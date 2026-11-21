import { z } from 'zod';
import { daysInRange, MAX_RANGE_DAYS } from '../availability.js';

// The from and to query rules, shared by availability and the booking list
// so there's one copy, not two.

// A local date such as 2026-11-23, in the resource's time zone.
//
// abort: true matters: without it, a bad date like 2026-02-30 still reaches
// the refines below, Temporal throws, and the route answers 500.
//
// Years are kept to 2000-2099, because dates near year 0 or 9999 turn into
// timestamps PostgreSQL refuses. YYYY-MM-DD strings sort like dates, so
// comparing them works.
export const localDate = z.iso
  .date({ abort: true })
  .refine((value) => value >= '2000-01-01' && value <= '2099-12-31', {
    message: 'Date must be between 2000-01-01 and 2099-12-31',
    abort: true,
  });

// Adds the two range rules (from not after to, at most 14 days) to a query
// schema that has from and to. A refine keeps the schema's type.
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
