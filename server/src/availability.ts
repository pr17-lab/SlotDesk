// This file holds every conversion between a resource's local time and UTC
// (D-032): the time zone check, the local-to-UTC conversion of working-hours
// boundaries, and the calculation of free slots (Step 9d). Nothing here
// touches the database or reads the clock, and Date is never used for time
// zone work: the Date objects passed in are only turned into
// Temporal.Instant.
//
// It uses temporal-polyfill, not Intl.supportedValuesOf('timeZone'): on
// Node 24 that list lacks Asia/Kolkata, so it would reject India's usual name.
import { Temporal } from 'temporal-polyfill';
// Type-only imports: they disappear when TypeScript compiles, so this file
// still loads no database code.
import type { BookedRange } from './data/bookings.js';
import type { WorkingWindow } from './data/working-hours.js';

// Slots start every 15 real minutes from the start of a window (D-032).
export const SLOT_STEP_MINUTES = 15;
// The longest range one availability request may ask for, in days (D-032).
export const MAX_RANGE_DAYS = 14;

// Returns the library's normalised name (for example 'asia/kolkata' becomes
// 'Asia/Kolkata'), or null when the name is not an IANA time zone.
export function normalizeTimeZone(input: string): string | null {
  let timeZoneId: string;
  try {
    // Building a ZonedDateTime makes the library check the name.
    timeZoneId = new Temporal.ZonedDateTime(0n, input).timeZoneId;
  } catch (err) {
    // Only the library's "not a valid time zone" error means a bad name.
    // Anything else is a programming error and must not look like bad input.
    if (err instanceof RangeError) {
      return null;
    }
    throw err;
  }
  // The library also accepts offsets such as +05:30. They are not IANA names
  // and have no daylight saving rules, so they are refused. Check the result,
  // not the input: the library turns '+0530' into '+05:30'.
  if (timeZoneId.startsWith('+') || timeZoneId.startsWith('-')) {
    return null;
  }
  return timeZoneId;
}

// The number of local dates from `from` to `to`, both included. `until`
// counts in days by default, so no unit is needed. The result is 0 or less
// when `to` is before `from`. Callers pass valid YYYY-MM-DD dates only (the
// route's schema guarantees it).
export function daysInRange(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(to).days + 1;
}

// The UTC range to search for bookings: midnight UTC the day before `from`
// to midnight UTC two days after `to`. It is wider than the request on
// purpose, and needs no time zone: offsets run from -12:00 to +14:00, so
// every local day from `from` to `to`, plus any DST shift, falls inside this
// UTC range. A few extra bookings fetched do no harm, because each slot is
// still checked against each booking.
export function bookingSearchRange(
  from: string,
  to: string,
): { start: string; end: string } {
  return {
    start: Temporal.PlainDate.from(from)
      .subtract({ days: 1 })
      .toZonedDateTime('UTC')
      .toInstant()
      .toString(),
    end: Temporal.PlainDate.from(to)
      .add({ days: 2 })
      .toZonedDateTime('UTC')
      .toInstant()
      .toString(),
  };
}

// The exact UTC range of the local dates from `from` to `to` (both
// included) in `timeZone`: from the start of `from` to the start of the day
// after `to`, as [start, end). The booking list uses it to find the bookings
// that start on those local dates (Step 10e).
//
// Unlike bookingSearchRange above, this range is exact, so it needs the time
// zone. toZonedDateTime with no time gives the first instant of the local
// day. That is usually midnight, but not always: where the clocks jump
// forward at midnight (Santiago in September) the day starts at 01:00, and
// where midnight happens twice (Havana in November) the earlier one is taken
// (Tested against Python zoneinfo, 2026-11-20).
export function localDaysToUtcRange(
  from: string,
  to: string,
  timeZone: string,
): { start: string; end: string } {
  return {
    start: Temporal.PlainDate.from(from)
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString(),
    end: Temporal.PlainDate.from(to)
      .add({ days: 1 })
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString(),
  };
}

// The exact instant of `minute` (minutes since local midnight) on `date` in
// `timeZone`. Minute 1440 means midnight at the start of the next day.
function toInstant(
  date: Temporal.PlainDate,
  minute: number,
  timeZone: string,
): Temporal.Instant {
  const wallClock =
    minute === 1440
      ? date.add({ days: 1 }).toPlainDateTime()
      : date.toPlainDateTime({
          hour: Math.floor(minute / 60),
          minute: minute % 60,
        });
  // 'compatible' is the default, but it is passed explicitly so the D-032
  // rule is visible. In a gap (spring forward, the time does not exist) the
  // time moves later by the length of the gap. In an overlap (fall back, the
  // time happens twice) the earlier of the two instants is taken.
  return wallClock
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' })
    .toInstant();
}

export type Slot = { startsAt: string; endsAt: string };

// The free UTC slots for one service on one resource, for every local date
// from `from` to `to` (both included). One object parameter because there
// are seven inputs. `now` is passed in, not read from the clock, so tests can
// control it (the route passes new Date()).
export function availableSlots(input: {
  timeZone: string;
  windows: WorkingWindow[];
  durationMinutes: number;
  bookings: BookedRange[];
  from: string;
  to: string;
  now: Date;
}): Slot[] {
  const { timeZone, windows, durationMinutes, from, to } = input;
  const now = Temporal.Instant.fromEpochMilliseconds(input.now.getTime());
  const bookings = input.bookings.map((booking) => ({
    startsAt: Temporal.Instant.fromEpochMilliseconds(
      booking.startsAt.getTime(),
    ),
    endsAt: Temporal.Instant.fromEpochMilliseconds(booking.endsAt.getTime()),
  }));

  const starts: Temporal.Instant[] = [];
  const lastDate = Temporal.PlainDate.from(to);
  for (
    let date = Temporal.PlainDate.from(from);
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    for (const window of windows) {
      // Both are ISO weekdays: 1 is Monday, 7 is Sunday.
      if (window.weekday !== date.dayOfWeek) {
        continue;
      }
      const windowEnd = toInstant(date, window.endMinute, timeZone);
      // Step in real elapsed minutes between the converted boundaries.
      for (
        let start = toInstant(date, window.startMinute, timeZone);
        Temporal.Instant.compare(
          start.add({ minutes: durationMinutes }),
          windowEnd,
        ) <= 0;
        start = start.add({ minutes: SLOT_STEP_MINUTES })
      ) {
        // A start exactly at `now` is still offered.
        if (Temporal.Instant.compare(start, now) < 0) {
          continue;
        }
        const slotEnd = start.add({ minutes: durationMinutes });
        // Half-open ranges, like tstzrange: the slot [start, slotEnd)
        // overlaps a booking when it starts before the booking ends and the
        // booking starts before the slot ends. A slot that starts exactly
        // when a booking ends, or ends exactly when one starts, is free.
        let overlaps = false;
        for (const booking of bookings) {
          if (
            Temporal.Instant.compare(start, booking.endsAt) < 0 &&
            Temporal.Instant.compare(booking.startsAt, slotEnd) < 0
          ) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          starts.push(start);
        }
      }
    }
  }

  // Sort, then drop a start equal to the one before it. Windows never
  // overlap in wall-clock time, but after the 'compatible' rule a window that
  // ends inside a spring-forward gap ends later than its wall-clock time, so
  // it can overlap the next window in UTC and both would offer the same
  // start. Example: New York, 2026-03-08, windows 01:00 to 02:30 and 03:15 to
  // 05:00; the first ends at 07:30Z, the second starts at 07:15Z.
  starts.sort(Temporal.Instant.compare);
  const slots: Slot[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    if (i > 0 && Temporal.Instant.compare(start, starts[i - 1]!) === 0) {
      continue;
    }
    slots.push({
      startsAt: start.toString(),
      endsAt: start.add({ minutes: durationMinutes }).toString(),
    });
  }
  return slots;
}

// The slot a booking request asks for: the one starting at exactly
// `startsAt`, if availableSlots would offer it with no bookings passed in,
// else null (D-033: bookable means offered). It never looks at other
// bookings, so the bookings_no_overlap constraint alone decides overlap. The
// slot's end comes from the service's duration, so the server, not the
// client, sets ends_at.
//
// The working hours that apply are those of the start's local date in the
// resource's time zone, not its UTC date: a 21:00 start on a Monday in New
// York is 02:00 on Tuesday in UTC. A sweep of every day of 2026 in nine
// zones (Tested, 2026-11-19), including two whose clocks change at midnight,
// found no offered start whose local date differed from its window's date,
// so asking about that one local day is enough.
//
// `startsAt` has already passed Zod's ISO check, but Zod accepts more
// fractional digits than Temporal can read (ten or more), and Temporal then
// throws a RangeError (Tested). Such a start is never on the 15-minute grid,
// so it is simply not offered, as in normalizeTimeZone above.
export function bookableSlot(input: {
  timeZone: string;
  windows: WorkingWindow[];
  durationMinutes: number;
  startsAt: string;
  now: Date;
}): Slot | null {
  let start: Temporal.Instant;
  try {
    start = Temporal.Instant.from(input.startsAt);
  } catch (err) {
    if (err instanceof RangeError) {
      return null;
    }
    throw err;
  }
  const localDate = start
    .toZonedDateTimeISO(input.timeZone)
    .toPlainDate()
    .toString();
  const slots = availableSlots({
    timeZone: input.timeZone,
    windows: input.windows,
    durationMinutes: input.durationMinutes,
    bookings: [],
    from: localDate,
    to: localDate,
    now: input.now,
  });
  // Compared as exact instants, so 03:30:00Z, 09:00:00+05:30 and
  // 03:30:00.000Z all match the same slot.
  return (
    slots.find((slot) => Temporal.Instant.from(slot.startsAt).equals(start)) ??
    null
  );
}
