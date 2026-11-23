// Date and time helpers. Instants are always shown in the resource's own
// zone, never the browser's. We never turn a local time into UTC.

// "2099-01-05" for an instant, as the calendar date in that zone.
export function localDate(instant: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// "09:15" for an instant. Midnight shows as "00:00".
export function localTime(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

export function timeRange(startsAt: string, endsAt: string, timeZone: string) {
  return `${localTime(startsAt, timeZone)}–${localTime(endsAt, timeZone)}`;
}

// Calendar arithmetic on a "YYYY-MM-DD" string.
export function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

// "Mon 5 Jan" or "Monday 5 January", from the plain date, not an instant.
export function dayLabel(date: string, long = false) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace(',', '');
}
