import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Form, Link, useFetcher, useSubmit } from 'react-router';
import type { Booking, Service, Slot } from '../api';
import {
  addDays,
  dayLabel,
  localDate,
  localMinutes,
  localTime,
  timeRange,
  zoneAbbreviation,
} from '../time';
import {
  Button,
  Card,
  FormMessage,
  Modal,
  SecondaryButton,
  TextField,
  focusStyle,
} from '../ui';
import type { resourceAction } from './Resource';

// A free slot or a confirmed booking, placed in one day's column.
type Item = { startsAt: string; endsAt: string; booking?: Booking };

// Where an item sits in the grid. From `md` up, these CSS variables place it
// in its day's column and its time's row; below `md` they do nothing.
function cell(column: number, row: number, span?: number) {
  // CSSProperties has no custom properties, so React gets them through a cast.
  return { '--col': column, '--row': row, '--span': span } as CSSProperties;
}
const placed =
  'md:[grid-column:var(--col)] md:[grid-row:var(--row)/span_var(--span,1)]';

function BookDialog({
  slot,
  service,
  timeZone,
  fetcher,
  onClose,
}: {
  slot: Slot;
  service: Service;
  timeZone: string;
  fetcher: ReturnType<typeof useFetcher<typeof resourceAction>>;
  onClose: () => void;
}) {
  const booking = fetcher.state !== 'idle';
  const date = localDate(slot.startsAt, timeZone);

  return (
    <Modal
      title={`Book ${localTime(slot.startsAt, timeZone)}, ${dayLabel(date, true)}`}
      onClose={onClose}
    >
      <p className="text-muted mt-1 text-sm">
        {`${service.name} · ${service.durationMinutes} min`}
      </p>
      <fetcher.Form method="post" className="mt-4 space-y-4">
        <input type="hidden" name="intent" value="book" />
        <input type="hidden" name="startsAt" value={slot.startsAt} />
        <input type="hidden" name="serviceId" value={service.id} />
        <TextField
          label="Customer name"
          name="customerName"
          required
          maxLength={100}
          autoFocus
        />
        <TextField
          label="Customer email"
          name="customerEmail"
          type="email"
          required
          maxLength={254}
        />
        <FormMessage result={fetcher.data} />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={booking}>
            {booking ? 'Booking…' : 'Book'}
          </Button>
          <SecondaryButton type="button" onClick={onClose}>
            Close
          </SecondaryButton>
        </div>
      </fetcher.Form>
    </Modal>
  );
}

export function Schedule({
  orgId,
  timeZone,
  services,
  service,
  slots,
  bookings,
  from,
  to,
  today,
}: {
  orgId: string;
  timeZone: string;
  services: Service[];
  service: Service | undefined;
  slots: Slot[];
  bookings: Booking[];
  from: string;
  to: string;
  today: string;
}) {
  const [chosen, setChosen] = useState<Slot | null>(null);
  // A new key for every opened dialog, so it never starts with the last
  // booking's result.
  const [attempt, setAttempt] = useState(0);
  const fetcher = useFetcher<typeof resourceAction>({ key: `book-${attempt}` });
  const submit = useSubmit();
  const newBlock = useRef<HTMLLIElement>(null);

  const newBookingId =
    fetcher.data && 'bookingId' in fetcher.data
      ? fetcher.data.bookingId
      : undefined;
  const hasNewBlock = bookings.some(
    (booking) => booking.id === newBookingId && booking.status === 'confirmed',
  );
  // The new block only exists once the page has reloaded after booking, so
  // wait for it, then move the focus there.
  useEffect(() => {
    if (hasNewBlock) newBlock.current?.focus();
  }, [hasNewBlock]);

  if (!service) {
    return (
      <Card title="Schedule">
        <p className="mt-2">
          Add a service on the organization page to start booking.
        </p>
        <Link
          to={`/orgs/${orgId}`}
          className={`rounded-control text-accent mt-2 inline-block font-medium hover:underline ${focusStyle}`}
        >
          Go to the organization page
        </Link>
      </Card>
    );
  }

  const notice =
    fetcher.data && 'notice' in fetcher.data ? fetcher.data.notice : undefined;

  // The link keeps the chosen service; no `from` means today.
  function rangeLink(start: string) {
    return `?${new URLSearchParams({ from: start, service: service?.id ?? '' })}`;
  }

  const items: Item[] = [
    ...slots,
    ...bookings
      .filter((booking) => booking.status === 'confirmed')
      .map((booking) => ({ ...booking, booking })),
  ];
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const dates = new Map(
    items.map((item) => [item, localDate(item.startsAt, timeZone)]),
  );
  const dayItems = days.map((day) =>
    items
      .filter((item) => dates.get(item) === day)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
  );

  // One row for each distinct local start time. The server steps from the
  // start of each working window, so the rows are not always 15 minutes apart.
  // Each item's minutes are worked out once: Intl formatters are slow to make.
  const startMinutes = new Map(
    items.map((item) => [item, localMinutes(item.startsAt, timeZone)]),
  );
  const startOf = (item: Item) => startMinutes.get(item) ?? 0;
  const rowMinutes = [...new Set(startMinutes.values())].sort((a, b) => a - b);
  // Row 1 is the day headers, so the time rows start at 2.
  const rowOf = (item: Item) => rowMinutes.indexOf(startOf(item)) + 2;
  // The label for each row comes from the first item that starts then.
  const rows = rowMinutes.map(
    (minutes) => items.find((item) => startOf(item) === minutes) as Item,
  );
  // A booking covers every row from its start up to, not including, its end.
  function spanOf(item: Item) {
    const start = startOf(item);
    let end = localMinutes(item.endsAt, timeZone);
    if (end <= start) end += 1440; // it ends at or after the next midnight
    return rowMinutes.filter((minutes) => minutes >= start && minutes < end)
      .length;
  }

  const linkStyle = `border-border bg-surface text-ink rounded-control hover:bg-background border px-3 py-1.5 text-sm font-medium transition-colors ${focusStyle}`;

  return (
    <Card title="Schedule">
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <Form method="get">
          <input type="hidden" name="from" value={from} />
          <label htmlFor="service" className="block text-sm font-medium">
            Service
          </label>
          <select
            id="service"
            name="service"
            value={service.id}
            onChange={(event) => submit(event.currentTarget.form)}
            className={`border-muted bg-surface text-ink rounded-control mt-1 block border px-3 py-2 ${focusStyle}`}
          >
            {services.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.name} · ${item.durationMinutes} min`}
              </option>
            ))}
          </select>
        </Form>
        <div className="flex flex-wrap gap-2">
          <Link to={rangeLink(addDays(from, -7))} className={linkStyle}>
            Previous 7 days
          </Link>
          <Link to={rangeLink(today)} className={linkStyle}>
            Today
          </Link>
          <Link to={rangeLink(addDays(from, 7))} className={linkStyle}>
            Next 7 days
          </Link>
        </div>
      </div>
      <p className="mt-3 font-medium">
        {`${dayLabel(from)} to ${dayLabel(to)}`}
      </p>
      <p className="text-muted text-sm">
        {`All times are in ${timeZone} (${zoneAbbreviation(new Date(), timeZone)}).`}
      </p>
      <FormMessage result={{ notice }} />

      {/* One grid for phone and laptop. From md up, each day's <li> and its
          list use display: contents, so all their items join this grid. */}
      <ol className="mt-4 md:grid md:grid-cols-[auto_repeat(7,minmax(0,1fr))] md:gap-x-2 md:gap-y-1">
        {rows.map((row) => (
          <li
            key={startOf(row)}
            aria-hidden="true"
            data-time-label
            style={cell(1, rowOf(row))}
            className="text-muted hidden pt-2 text-xs whitespace-nowrap md:[grid-column:var(--col)] md:[grid-row:var(--row)] md:block"
          >
            {localTime(row.startsAt, timeZone)}
          </li>
        ))}
        {days.map((day, dayIndex) => (
          <li
            key={day}
            className="border-border rounded-control mb-3 border md:contents"
          >
            <h3
              style={cell(dayIndex + 2, 1)}
              className="bg-surface border-border flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-2 text-sm font-semibold md:sticky md:top-0 md:z-10 md:[grid-column:var(--col)] md:[grid-row:var(--row)]"
            >
              {dayLabel(day)}
              {day === today && (
                <span className="bg-accent text-accent-ink rounded-full px-2 py-0.5 text-xs font-medium">
                  Today
                </span>
              )}
            </h3>
            {dayItems[dayIndex].length === 0 ? (
              <p
                data-day={day}
                style={cell(dayIndex + 2, 2, Math.max(rows.length, 1))}
                className={`text-muted p-2 text-sm ${placed}`}
              >
                No free times
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2 p-2 md:contents">
                {/* shortcut: two items with the same start on one day (a
                    daylight-saving fall-back) overlap in one cell; stack them
                    if that ever matters. */}
                {dayItems[dayIndex].map((item) =>
                  item.booking ? (
                    <li
                      key={item.booking.id}
                      ref={item.booking.id === newBookingId ? newBlock : null}
                      tabIndex={-1}
                      data-day={day}
                      data-new={item.booking.id === newBookingId || undefined}
                      style={cell(dayIndex + 2, rowOf(item), spanOf(item))}
                      className={`bg-accent/10 border-accent text-ink rounded-control border-l-4 px-1 py-1 text-sm ${placed} ${focusStyle} ${item.booking.id === newBookingId ? 'motion-safe:animate-fade-in' : ''}`}
                    >
                      <span aria-hidden="true">
                        <span className="block text-[11px] font-medium whitespace-nowrap">
                          {timeRange(item.startsAt, item.endsAt, timeZone)}
                        </span>
                        <span className="line-clamp-2">
                          {item.booking.customerName}
                        </span>
                      </span>
                      <span className="sr-only">
                        {`Booked ${timeRange(item.startsAt, item.endsAt, timeZone)}, ${item.booking.customerName}`}
                      </span>
                    </li>
                  ) : (
                    <li
                      key={item.startsAt}
                      data-day={day}
                      style={cell(dayIndex + 2, rowOf(item))}
                      className={placed}
                    >
                      <button
                        type="button"
                        aria-label={`Book ${localTime(item.startsAt, timeZone)} on ${dayLabel(day, true)}`}
                        onClick={() => {
                          setChosen(item);
                          setAttempt(attempt + 1);
                        }}
                        className={`border-accent text-accent bg-surface rounded-control hover:ring-accent focus-visible:ring-accent w-full border px-2 py-1 text-sm font-medium hover:ring-2 focus-visible:ring-2 ${focusStyle}`}
                      >
                        {localTime(item.startsAt, timeZone)}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </li>
        ))}
      </ol>

      {chosen && !notice && (
        <BookDialog
          slot={chosen}
          service={service}
          timeZone={timeZone}
          fetcher={fetcher}
          onClose={() => setChosen(null)}
        />
      )}
    </Card>
  );
}
