// Largest value a PostgreSQL bigint can hold.
const MAX_BIGINT = 9223372036854775807n;

// Digits only, no leading zero, and within bigint range, so a malformed ID
// never reaches the database (where it would cause an error and a 500).
export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]*$/.test(value) &&
    BigInt(value) <= MAX_BIGINT
  );
}
