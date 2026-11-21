// Every conversion between a resource's local time and UTC lives here, and
// nowhere else (D-032). No database, no clock: callers pass the time in.
// We use temporal-polyfill because Intl's time zone list on Node 24 is
// missing Asia/Kolkata.
import { Temporal } from 'temporal-polyfill';
// Type-only imports, so this file still loads no database code.
import type { BookedRange } from './data/bookings.js';
import type { WorkingWindow } from './data/working-hours.js';

// Slots start every 15 real minutes from the start of a window.
export const SLOT_STEP_MINUTES = 15;
// The longest range one availability request may ask for, in days.
export const MAX_RANGE_DAYS = 14;

// Returns the library's normalised name (for example 'asia/kolkata' becomes
// 'Asia/Kolkata'), or null when the name is not an IANA time zone.
export function normalizeTimeZone(input: string): string | null {
  let timeZoneId: string;
  try {
    // Building a ZonedDateTime makes the library check the name.
    timeZoneId = new Temporal.ZonedDateTime(0n, input).timeZoneId;
  } catch (err) {
    // A RangeError means a bad name. Anything else is a real bug, so let it
    // through instead of calling it bad input.
    if (err instanceof RangeError) {
      return null;
    }
    throw err;
  }
  // Offsets like +05:30 parse fine but have no daylight saving rules, so we
  // refuse them. We check the result because '+0530' comes back as '+05:30'.
  if (timeZoneId.startsWith('+') || timeZoneId.startsWith('-')) {
    return null;
  }
  return timeZoneId;
}

// How many local dates from `from` to `to`, both included (0 or less when
// `to` is before `from`).
export function daysInRange(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(to).days + 1;
}

// A deliberately wide UTC range to fetch bookings in: from the day before
// `from` to two days after `to`. Offsets only go from -12:00 to +14:00, so
// every local day in the request fits inside it whatever the zone. Fetching
// a few extra bookings is harmless; each slot is still checked against them.
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

// The exact UTC range [start, end) covering the local dates `from` to `to`
// in `timeZone`. The booking list uses it.
//
// toZonedDateTime with no time gives the first instant of the local day.
// That's usually midnight, but not always: in Santiago the clocks jump past
// midnight, and in Havana midnight happens twice.
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
  // 'compatible' is the default; we spell it out so the DST rule is visible.
  // A time that doesn't exist (spring forward) moves later; a time that
  // happens twice (fall back) takes the earlier instant.
  return wallClock
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' })
    .toInstant();
}

export type Slot = { startsAt: string; endsAt: string };

// The free UTC slots for one service on one resource, for each local date
// from `from` to `to`. `now` is passed in so tests can control the clock.
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
        // Half-open ranges, like tstzrange: back-to-back is not an overlap.
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

  // Sort and drop duplicates. Windows never overlap on the wall clock, but a
  // window ending inside a spring-forward gap gets pushed later, so it can
  // overlap the next one in UTC (New York, 2026-03-08: 01:00-02:30 and
  // 03:15-05:00) and both would offer the same start.
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

// The slot starting at exactly `startsAt`, if availableSlots would offer it,
// otherwise null. Bookable means offered (D-033). We pass no bookings on
// purpose: the bookings_no_overlap constraint alone decides overlaps. The
// end comes from the service's duration, so the server sets it, not the
// client.
//
// We use the working hours of the start's local date, not its UTC date: a
// Monday 21:00 start in New York is already Tuesday in UTC.
//
// Zod lets through ten or more fractional digits, which Temporal can't read.
// Such a start is never on the grid anyway, so it's just "not offered".
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
  // Compare instants, so 03:30:00Z and 09:00:00+05:30 match the same slot.
  return (
    slots.find((slot) => Temporal.Instant.from(slot.startsAt).equals(start)) ??
    null
  );
}
