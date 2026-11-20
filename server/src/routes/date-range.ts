import { z } from 'zod';
import { daysInRange, MAX_RANGE_DAYS } from '../availability.js';

// The from and to query values shared by the availability route and the
// booking list (D-033: one schema, not two copies). Moved here from
// routes/availability.ts in Step 10e, unchanged.

// A local date such as 2026-11-23, in the resource's time zone.
//
// Why abort: true (Tested): in Zod 4.6.7 a failed format check on a string
// does not stop the object-level refines below. Without it, from=2026-02-30
// reached daysInRange, temporal-polyfill threw "RangeError: Invalid day: 30",
// and the route would answer 500. With abort: true that field fails alone
// and the refines below are skipped.
//
// Why the year bounds (Tested, PostgreSQL 16): without them 0000-01-01 and
// 9999-12-31 are valid ISO dates, but bookingSearchRange then produces
// -000001-12-31T00:00:00Z or +010000-01-02T00:00:00Z, which PostgreSQL
// refuses (a 500). Comparing YYYY-MM-DD strings works because they sort like
// dates.
export const localDate = z.iso
  .date({ abort: true })
  .refine((value) => value >= '2000-01-01' && value <= '2099-12-31', {
    message: 'Date must be between 2000-01-01 and 2099-12-31',
    abort: true,
  });

// Adds the two range rules to a query schema that has from and to (both
// localDate). The schema comes back with the same type, because a Zod 4
// refine does not wrap the schema in a new type.
//
// query.from <= query.to compares strings, which works because YYYY-MM-DD
// strings sort like dates.
export function withDateRangeRules<
  Schema extends z.ZodType<{ from: string; to: string }>,
>(schema: Schema): Schema {
  return schema
    .refine((query) => query.from <= query.to, {
      message: 'from must not be after to',
      path: ['to'],
    })
    .refine((query) => daysInRange(query.from, query.to) <= MAX_RANGE_DAYS, {
      message: `The range must be at most ${MAX_RANGE_DAYS} days`,
      path: ['to'],
    });
}
