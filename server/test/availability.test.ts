// The time zone check, local time to UTC, free slots, the booking start check
// and the booking list's local-day range. Unit tests, no database.
import { describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import {
  availableSlots,
  bookableSlot,
  bookingSearchRange,
  daysInRange,
  localDaysToUtcRange,
  normalizeTimeZone,
} from '../src/availability.js';

describe('normalizeTimeZone: accepted names', () => {
  it.each([
    ['Asia/Kolkata', 'Asia/Kolkata'],
    ['asia/kolkata', 'Asia/Kolkata'],
    ['Asia/Calcutta', 'Asia/Calcutta'],
    ['utc', 'UTC'],
    ['America/New_York', 'America/New_York'],
    ['Europe/London', 'Europe/London'],
    // A valid IANA name, not an offset.
    ['Etc/GMT+5', 'Etc/GMT+5'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeTimeZone(input)).toBe(expected);
  });
});

describe('normalizeTimeZone: refused names', () => {
  it.each([
    ['Mars/Base', 'Mars/Base'],
    ['an empty string', ''],
    ['an offset with a colon', '+05:30'],
    ['a negative offset', '-08:00'],
    ['an offset without a colon', '+0530'],
    ['an hour-only offset', '+05'],
    ['Z', 'Z'],
    ['UTC+5', 'UTC+5'],
    ['a leading space', ' UTC'],
    ['a trailing newline', 'UTC\n'],
  ])('refuses %s', (_label, input) => {
    expect(normalizeTimeZone(input)).toBeNull();
  });
});

describe('the library error', () => {
  // normalizeTimeZone catches only RangeError. This proves the library's
  // error for a bad name really is one in this setup.
  it('is a RangeError for an unknown name', () => {
    expect(() => new Temporal.ZonedDateTime(0n, 'Mars/Base')).toThrow(
      RangeError,
    );
  });
});

// Slots. Expected values were computed with temporal-polyfill and
// cross-checked with Python's zoneinfo.

const INDIA = 'Asia/Kolkata';
const NEW_YORK = 'America/New_York';
const LONG_AGO = new Date('2000-01-01T00:00:00Z');
type Window = { weekday: number; startMinute: number; endMinute: number };
type Booking = { startsAt: Date; endsAt: Date };

// availableSlots with now set long ago and no bookings, unless a case gives
// them, so each case names only what it changes.
function slots(input: {
  timeZone: string;
  windows: Window[];
  durationMinutes: number;
  from: string;
  to: string;
  now?: Date;
  bookings?: Booking[];
}) {
  return availableSlots({
    ...input,
    now: input.now ?? LONG_AGO,
    bookings: input.bookings ?? [],
  });
}

const starts = (result: Array<{ startsAt: string }>) =>
  result.map((slot) => slot.startsAt);

// Starts every 15 minutes from `first` to `last`, both included, written out
// with Temporal so the list is not typed by hand.
function everyQuarter(first: string, last: string): string[] {
  const result: string[] = [];
  const end = Temporal.Instant.from(last);
  for (
    let start = Temporal.Instant.from(first);
    Temporal.Instant.compare(start, end) <= 0;
    start = start.add({ minutes: 15 })
  ) {
    result.push(start.toString());
  }
  return result;
}

const INDIA_MONDAY_MORNING = { weekday: 1, startMinute: 540, endMinute: 600 };
const INDIA_THREE_SLOTS = [
  { startsAt: '2026-11-23T03:30:00Z', endsAt: '2026-11-23T04:00:00Z' },
  { startsAt: '2026-11-23T03:45:00Z', endsAt: '2026-11-23T04:15:00Z' },
  { startsAt: '2026-11-23T04:00:00Z', endsAt: '2026-11-23T04:30:00Z' },
];

// India, Monday 2026-11-23, 09:00 to 10:00, a 30-minute service.
const indiaMonday = (extra: { now?: Date; bookings?: Booking[] } = {}) =>
  slots({
    timeZone: INDIA,
    windows: [INDIA_MONDAY_MORNING],
    durationMinutes: 30,
    from: '2026-11-23',
    to: '2026-11-23',
    ...extra,
  });

describe('availableSlots: India (no DST)', () => {
  it('gives three 30-minute slots in a 09:00 to 10:00 Monday window', () => {
    expect(indiaMonday()).toEqual(INDIA_THREE_SLOTS);
  });

  it('handles a window ending at 1440 (midnight)', () => {
    const result = slots({
      timeZone: INDIA,
      windows: [{ weekday: 1, startMinute: 1380, endMinute: 1440 }],
      durationMinutes: 60,
      from: '2026-11-23',
      to: '2026-11-23',
    });
    expect(result).toEqual([
      { startsAt: '2026-11-23T17:30:00Z', endsAt: '2026-11-23T18:30:00Z' },
    ]);
  });

  it('offers a service that fits exactly, and nothing for one too long', () => {
    const base = {
      timeZone: INDIA,
      windows: [INDIA_MONDAY_MORNING],
      from: '2026-11-23',
      to: '2026-11-23',
    };
    expect(slots({ ...base, durationMinutes: 60 })).toEqual([
      { startsAt: '2026-11-23T03:30:00Z', endsAt: '2026-11-23T04:30:00Z' },
    ]);
    expect(slots({ ...base, durationMinutes: 75 })).toEqual([]);
  });

  it('uses only the matching weekday over a whole week', () => {
    const week = { from: '2026-11-23', to: '2026-11-29' };
    expect(
      slots({
        timeZone: INDIA,
        windows: [INDIA_MONDAY_MORNING],
        durationMinutes: 30,
        ...week,
      }),
    ).toEqual(INDIA_THREE_SLOTS);
    // Weekday 7 is Sunday (ISO).
    expect(
      slots({
        timeZone: INDIA,
        windows: [{ weekday: 7, startMinute: 540, endMinute: 570 }],
        durationMinutes: 30,
        ...week,
      }),
    ).toEqual([
      { startsAt: '2026-11-29T03:30:00Z', endsAt: '2026-11-29T04:00:00Z' },
    ]);
  });

  it('gives [] with no windows', () => {
    expect(
      slots({
        timeZone: INDIA,
        windows: [],
        durationMinutes: 30,
        from: '2026-11-23',
        to: '2026-11-29',
      }),
    ).toEqual([]);
  });
});

describe('availableSlots: New York across a clock change', () => {
  // 09:00 to 10:00 on Saturday, Sunday and Monday.
  const mornings = [6, 7, 1].map((weekday) => ({
    weekday,
    startMinute: 540,
    endMinute: 600,
  }));

  it('spring forward: 09:00 is EST before the change, EDT after', () => {
    const result = slots({
      timeZone: NEW_YORK,
      windows: mornings,
      durationMinutes: 60,
      from: '2026-03-07',
      to: '2026-03-09',
    });
    expect(starts(result)).toEqual([
      '2026-03-07T14:00:00Z',
      '2026-03-08T13:00:00Z',
      '2026-03-09T13:00:00Z',
    ]);
  });

  it('fall back: 09:00 is EDT before the change, EST after', () => {
    const result = slots({
      timeZone: NEW_YORK,
      windows: mornings,
      durationMinutes: 60,
      from: '2026-10-31',
      to: '2026-11-02',
    });
    expect(starts(result)).toEqual([
      '2026-10-31T13:00:00Z',
      '2026-11-01T14:00:00Z',
      '2026-11-02T14:00:00Z',
    ]);
  });
});

describe('availableSlots: the spring-forward gap (New York, 2026-03-08)', () => {
  const sunday = (windows: Window[], durationMinutes: number) =>
    slots({
      timeZone: NEW_YORK,
      windows,
      durationMinutes,
      from: '2026-03-08',
      to: '2026-03-08',
    });

  it('a window spanning the gap is two real hours (01:00 EST to 04:00 EDT)', () => {
    const result = sunday(
      [{ weekday: 7, startMinute: 60, endMinute: 240 }],
      60,
    );
    expect(starts(result)).toEqual([
      '2026-03-08T06:00:00Z',
      '2026-03-08T06:15:00Z',
      '2026-03-08T06:30:00Z',
      '2026-03-08T06:45:00Z',
      '2026-03-08T07:00:00Z',
    ]);
  });

  it('a window starting in the gap: 02:30 moves later to 03:30 EDT', () => {
    const result = sunday(
      [{ weekday: 7, startMinute: 150, endMinute: 240 }],
      30,
    );
    expect(result).toEqual([
      { startsAt: '2026-03-08T07:30:00Z', endsAt: '2026-03-08T08:00:00Z' },
    ]);
  });

  // 01:00 to 02:30 ends at 07:30Z (02:30 moves later); 03:15 to 05:00 starts
  // at 07:15Z. Without the de-duplication 07:15Z appears twice (13 starts).
  const twoWindows = [
    { weekday: 7, startMinute: 60, endMinute: 150 },
    { weekday: 7, startMinute: 195, endMinute: 300 },
  ];

  it('offers each start once when two windows overlap in UTC', () => {
    const expected = everyQuarter(
      '2026-03-08T06:00:00Z',
      '2026-03-08T08:45:00Z',
    );
    expect(expected).toHaveLength(12);
    expect(starts(sunday(twoWindows, 15))).toEqual(expected);
  });

  it('gives the same result with the windows in the opposite order', () => {
    expect(sunday([...twoWindows].reverse(), 15)).toEqual(
      sunday(twoWindows, 15),
    );
  });
});

describe('availableSlots: the fall-back overlap (New York, 2026-11-01)', () => {
  const sunday = (window: Window, durationMinutes: number) =>
    slots({
      timeZone: NEW_YORK,
      windows: [window],
      durationMinutes,
      from: '2026-11-01',
      to: '2026-11-01',
    });

  it('a window spanning the overlap is three real hours (01:00 EDT to 03:00 EST)', () => {
    const expected = everyQuarter(
      '2026-11-01T05:00:00Z',
      '2026-11-01T07:00:00Z',
    );
    expect(expected).toHaveLength(9);
    const result = sunday({ weekday: 7, startMinute: 60, endMinute: 180 }, 60);
    expect(starts(result)).toEqual(expected);
  });

  it('a window starting in the overlap: 01:30 takes the earlier instant', () => {
    const result = sunday({ weekday: 7, startMinute: 90, endMinute: 120 }, 30);
    expect(starts(result)).toEqual([
      '2026-11-01T05:30:00Z',
      '2026-11-01T05:45:00Z',
      '2026-11-01T06:00:00Z',
      '2026-11-01T06:15:00Z',
      '2026-11-01T06:30:00Z',
    ]);
  });
});

describe('availableSlots: now', () => {
  it.each([
    ['leaves out starts before now', '2026-11-23T03:40:00Z'],
    ['offers a start exactly at now', '2026-11-23T03:45:00Z'],
  ])('%s', (_label, now) => {
    const result = indiaMonday({ now: new Date(now) });
    expect(starts(result)).toEqual([
      '2026-11-23T03:45:00Z',
      '2026-11-23T04:00:00Z',
    ]);
  });
});

describe('availableSlots: bookings', () => {
  const booking = (startsAt: string, endsAt: string) => ({
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  });

  it('a booking that ends when a slot starts leaves that slot free', () => {
    const result = indiaMonday({
      bookings: [booking('2026-11-23T03:30:00Z', '2026-11-23T03:45:00Z')],
    });
    expect(starts(result)).toEqual([
      '2026-11-23T03:45:00Z',
      '2026-11-23T04:00:00Z',
    ]);
  });

  it('a booking that starts when the last slot ends leaves all three', () => {
    const result = indiaMonday({
      bookings: [booking('2026-11-23T04:30:00Z', '2026-11-23T05:00:00Z')],
    });
    expect(result).toEqual(INDIA_THREE_SLOTS);
  });

  it('a booking one minute inside the last slot removes it', () => {
    const result = indiaMonday({
      bookings: [booking('2026-11-23T04:29:00Z', '2026-11-23T05:00:00Z')],
    });
    expect(starts(result)).toEqual([
      '2026-11-23T03:30:00Z',
      '2026-11-23T03:45:00Z',
    ]);
  });
});

describe('daysInRange', () => {
  it.each([
    ['2026-11-17', '2026-11-30', 14],
    ['2026-11-17', '2026-11-17', 1],
    ['2026-11-18', '2026-11-17', 0],
    ['2026-02-25', '2026-03-10', 14],
    // A leap year: 29 February adds one day.
    ['2028-02-25', '2028-03-10', 15],
  ])('%s to %s is %i', (from, to, expected) => {
    expect(daysInRange(from, to)).toBe(expected);
  });
});

describe('bookingSearchRange', () => {
  it('runs from UTC midnight the day before to UTC midnight two days after', () => {
    expect(bookingSearchRange('2026-11-17', '2026-11-30')).toEqual({
      start: '2026-11-16T00:00:00Z',
      end: '2026-12-02T00:00:00Z',
    });
  });
});

// localDaysToUtcRange: the exact UTC range [start, end) of the local dates from
// `from` to `to`. Expected values cross-checked with Python's zoneinfo.
describe('localDaysToUtcRange', () => {
  it.each([
    // +05:30 all year: the local day starts at 18:30Z the UTC day before.
    [
      'India',
      'Asia/Kolkata',
      '2099-01-05',
      '2099-01-05',
      '2099-01-04T18:30:00Z',
      '2099-01-05T18:30:00Z',
    ],
    // Spring forward at 02:00: a 23-hour day.
    [
      'New York spring forward',
      'America/New_York',
      '2026-03-08',
      '2026-03-08',
      '2026-03-08T05:00:00Z',
      '2026-03-09T04:00:00Z',
    ],
    // Fall back at 02:00: a 25-hour day.
    [
      'New York fall back',
      'America/New_York',
      '2026-11-01',
      '2026-11-01',
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
    ],
    // The clocks jump from 00:00 to 01:00, so the day starts at 01:00 local
    // (-03:00), not at a midnight that does not exist.
    [
      'Santiago, midnight skipped',
      'America/Santiago',
      '2026-09-06',
      '2026-09-06',
      '2026-09-06T04:00:00Z',
      '2026-09-07T03:00:00Z',
    ],
    // The clocks go back from 01:00 to 00:00, so midnight happens twice; the
    // day starts at the first one (-04:00).
    [
      'Havana, midnight twice',
      'America/Havana',
      '2026-11-01',
      '2026-11-01',
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
    ],
    // 14 days, both included: the end is the start of the day after `to`.
    [
      'UTC, 14 days',
      'UTC',
      '2026-11-17',
      '2026-11-30',
      '2026-11-17T00:00:00Z',
      '2026-12-01T00:00:00Z',
    ],
    // The two ends of the allowed years, in the zones furthest from UTC
    // (+14:00 and -12:00). Both results are inside PostgreSQL's range.
    [
      'the last allowed day, +14:00',
      'Pacific/Kiritimati',
      '2099-12-31',
      '2099-12-31',
      '2099-12-30T10:00:00Z',
      '2099-12-31T10:00:00Z',
    ],
    [
      'the first allowed day, -12:00',
      'Etc/GMT+12',
      '2000-01-01',
      '2000-01-01',
      '2000-01-01T12:00:00Z',
      '2000-01-02T12:00:00Z',
    ],
  ])('%s', (_label, timeZone, from, to, start, end) => {
    expect(localDaysToUtcRange(from, to, timeZone)).toEqual({ start, end });
  });
});

// bookableSlot: a start is accepted exactly when availableSlots would offer it,
// with no bookings. Expected instants cross-checked with Python's zoneinfo.
function bookable(input: {
  timeZone: string;
  windows: Window[];
  durationMinutes: number;
  startsAt: string;
  now?: Date;
}) {
  return bookableSlot({ ...input, now: input.now ?? LONG_AGO });
}

describe('bookableSlot: India (no DST)', () => {
  // Monday 2099-01-05, two touching windows, 09:00 to 13:00 and 13:00 to
  // 17:00, and a 60-minute service.
  const india = (startsAt: string, now?: Date) =>
    bookable({
      timeZone: INDIA,
      windows: [
        { weekday: 1, startMinute: 540, endMinute: 780 },
        { weekday: 1, startMinute: 780, endMinute: 1020 },
      ],
      durationMinutes: 60,
      startsAt,
      now,
    });

  it('accepts an offered start and sets the end from the duration', () => {
    expect(india('2099-01-05T03:30:00Z')).toEqual({
      startsAt: '2099-01-05T03:30:00Z',
      endsAt: '2099-01-05T04:30:00Z',
    });
  });

  // The same instant written four ways; the slot is always written in UTC.
  it.each([
    '2099-01-05T09:00:00+05:30',
    '2099-01-05T03:30:00.000Z',
    '2099-01-05T03:30:00-00:00',
  ])('accepts %s as the 03:30Z slot', (startsAt) => {
    expect(india(startsAt)?.startsAt).toBe('2099-01-05T03:30:00Z');
  });

  it('accepts the last start that fits (16:00 local)', () => {
    expect(india('2099-01-05T10:30:00Z')?.endsAt).toBe('2099-01-05T11:30:00Z');
  });

  it.each([
    ['one millisecond after an offered start', '2099-01-05T03:30:00.001Z'],
    ['an off-grid start (09:05 local)', '2099-01-05T03:35:00Z'],
    ['a start too late to fit (16:15 local)', '2099-01-05T10:45:00Z'],
    ['a start before the hours (08:45 local)', '2099-01-05T03:15:00Z'],
    // 12:30 to 13:30 would run across the two touching windows (D-033).
    ['a booking across two touching windows', '2099-01-05T07:00:00Z'],
    ['a Tuesday (no hours)', '2099-01-06T03:30:00Z'],
  ])('refuses %s', (_label, startsAt) => {
    expect(india(startsAt)).toBeNull();
  });

  // Zod accepts ten or more fractional digits; Temporal cannot read them and
  // throws a RangeError. This fails if bookableSlot stops catching it.
  it('refuses a start with ten fractional digits instead of throwing', () => {
    expect(india('2099-01-05T03:30:00.1234567891Z')).toBeNull();
  });

  it('accepts a start exactly at now', () => {
    const now = new Date('2099-01-05T03:30:00Z');
    expect(india('2099-01-05T03:30:00Z', now)).not.toBeNull();
  });

  it('refuses a start one millisecond in the past', () => {
    const now = new Date('2099-01-05T03:30:00.001Z');
    expect(india('2099-01-05T03:30:00Z', now)).toBeNull();
  });
});

describe('bookableSlot: the local date, not the UTC date', () => {
  // New York, Monday 2026-11-02, 20:00 to 24:00 local, a 60-minute service.
  // 21:00 on Monday in New York is 02:00 on Tuesday in UTC. This fails if
  // bookableSlot looks up the working hours of the UTC date.
  const evening = (startsAt: string) =>
    bookable({
      timeZone: NEW_YORK,
      windows: [{ weekday: 1, startMinute: 1200, endMinute: 1440 }],
      durationMinutes: 60,
      startsAt,
    });

  it('accepts Monday 21:00 local, which is Tuesday 02:00Z', () => {
    expect(evening('2026-11-03T02:00:00Z')).toEqual({
      startsAt: '2026-11-03T02:00:00Z',
      endsAt: '2026-11-03T03:00:00Z',
    });
  });

  it('accepts 23:00 local, which ends at the window end, minute 1440', () => {
    expect(evening('2026-11-03T04:00:00Z')?.endsAt).toBe(
      '2026-11-03T05:00:00Z',
    );
  });

  it('refuses 23:15 local, which would end after midnight', () => {
    expect(evening('2026-11-03T04:15:00Z')).toBeNull();
  });
});

describe('bookableSlot: New York clock changes', () => {
  // Sunday 2026-11-01, 00:00 to 04:00 local, 60 minutes. 01:30 happens
  // twice: 05:30Z (EDT) and 06:30Z (EST). Slots step in real minutes, so
  // both are offered and both can be booked.
  const fallBack = (startsAt: string) =>
    bookable({
      timeZone: NEW_YORK,
      windows: [{ weekday: 7, startMinute: 0, endMinute: 240 }],
      durationMinutes: 60,
      startsAt,
    });

  it.each([
    [
      'the first 01:30 (EDT)',
      '2026-11-01T01:30:00-04:00',
      '2026-11-01T05:30:00Z',
    ],
    [
      'the second 01:30 (EST)',
      '2026-11-01T01:30:00-05:00',
      '2026-11-01T06:30:00Z',
    ],
    [
      'the last start, 03:00 EST',
      '2026-11-01T08:00:00Z',
      '2026-11-01T08:00:00Z',
    ],
  ])('fall back: accepts %s', (_label, startsAt, expected) => {
    expect(fallBack(startsAt)?.startsAt).toBe(expected);
  });

  // Sunday 2026-03-08, 01:00 to 05:00 local, 60 minutes: 02:00 to 03:00 does
  // not exist, so the window is three real hours (06:00Z to 09:00Z).
  const springForward = (startsAt: string) =>
    bookable({
      timeZone: NEW_YORK,
      windows: [{ weekday: 7, startMinute: 60, endMinute: 300 }],
      durationMinutes: 60,
      startsAt,
    });

  it.each([
    ['01:30 EST', '2026-03-08T06:30:00Z'],
    ['03:00 EDT, the first time after the gap', '2026-03-08T07:00:00Z'],
    ['04:00 EDT, the last start', '2026-03-08T08:00:00Z'],
  ])('spring forward: accepts %s', (_label, startsAt) => {
    expect(springForward(startsAt)).not.toBeNull();
  });

  it('spring forward: refuses 08:15Z, which would end after 05:00 EDT', () => {
    expect(springForward('2026-03-08T08:15:00Z')).toBeNull();
  });
});
