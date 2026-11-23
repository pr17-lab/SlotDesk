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

// The hour, minute and AM/PM of an instant in 12-hour form.
function clockParts(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    hour: part('hour'),
    minute: part('minute'),
    period: part('dayPeriod'),
  };
}

// "9:15 AM" for an instant. Joined by hand so the space is a normal space.
export function localTime(instant: string, timeZone: string) {
  const { hour, minute, period } = clockParts(instant, timeZone);
  return `${hour}:${minute} ${period}`;
}

// "9:00–9:30 AM", or "11:30 AM–12:00 PM" when the two ends differ in AM/PM.
export function timeRange(startsAt: string, endsAt: string, timeZone: string) {
  const start = clockParts(startsAt, timeZone);
  const end = clockParts(endsAt, timeZone);
  if (start.period !== end.period) {
    return `${localTime(startsAt, timeZone)}–${localTime(endsAt, timeZone)}`;
  }
  return `${start.hour}:${start.minute}–${end.hour}:${end.minute} ${end.period}`;
}

// "IST", "GMT-5" ... the short zone name at that instant (it can change with
// daylight saving). en-IN gives "IST" for India, where en-US would not.
export function zoneAbbreviation(instant: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(instant));
  return parts.find((item) => item.type === 'timeZoneName')?.value ?? timeZone;
}

// Minutes since local midnight for an instant, like 540 for 09:00.
export function localMinutes(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value);
  return part('hour') * 60 + part('minute');
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

// "9:00 AM" for minutes after midnight: 0 is "12:00 AM", 720 is "12:00 PM".
export function minutesLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, '0');
  const period = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 || 12}:${minute} ${period}`;
}
