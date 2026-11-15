// This file will hold every conversion between a resource's local time and
// UTC (Step 9d, D-032). Today it holds only the time zone check.
//
// It uses temporal-polyfill, not Intl.supportedValuesOf('timeZone'): on
// Node 24 that list lacks Asia/Kolkata, so it would reject India's usual name.
import { Temporal } from 'temporal-polyfill';

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
