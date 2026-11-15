// Step 9a: the time zone check. Unit tests, no database.
import { describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import { normalizeTimeZone } from '../src/availability.js';

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
