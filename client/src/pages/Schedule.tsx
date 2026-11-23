import { useState } from 'react';
import { Form, Link, useFetcher, useSubmit } from 'react-router';
import type { Booking, Service, Slot } from '../api';
import { addDays, dayLabel, localDate, localTime, timeRange } from '../time';
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
  const itemsOn = (day: string) =>
    items
      .filter((item) => localDate(item.startsAt, timeZone) === day)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

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
      <p className="text-muted text-sm">{`All times are in ${timeZone}.`}</p>
      <FormMessage result={{ notice }} />

      <ol className="border-border rounded-control bg-border mt-4 grid max-h-[32rem] gap-px overflow-y-auto border md:grid-cols-7">
        {days.map((day) => {
          const dayItems = itemsOn(day);
          return (
            <li key={day} className="bg-surface min-w-0">
              <h3 className="bg-surface border-border sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-2 text-sm font-semibold">
                {dayLabel(day)}
                {day === today && (
                  <span className="bg-accent text-accent-ink rounded-full px-2 py-0.5 text-xs font-medium">
                    Today
                  </span>
                )}
              </h3>
              {dayItems.length === 0 ? (
                <p className="text-muted p-2 text-sm">No free times</p>
              ) : (
                <ul className="flex flex-wrap gap-2 p-2 md:flex-col md:flex-nowrap">
                  {dayItems.map((item) => (
                    <li key={item.startsAt + (item.booking?.id ?? '')}>
                      {item.booking ? (
                        <div className="bg-accent text-accent-ink rounded-control px-2 py-1 text-sm">
                          <span aria-hidden="true">
                            <span className="block text-xs font-medium whitespace-nowrap">
                              {timeRange(item.startsAt, item.endsAt, timeZone)}
                            </span>
                            <span className="block truncate">
                              {item.booking.customerName}
                            </span>
                          </span>
                          <span className="sr-only">
                            {`Booked ${timeRange(item.startsAt, item.endsAt, timeZone)}, ${item.booking.customerName}`}
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Book ${localTime(item.startsAt, timeZone)} on ${dayLabel(day, true)}`}
                          onClick={() => {
                            setChosen(item);
                            setAttempt(attempt + 1);
                          }}
                          className={`border-accent text-accent rounded-control hover:bg-accent hover:text-accent-ink w-full border px-2 py-1 text-sm font-medium transition-colors ${focusStyle}`}
                        >
                          {localTime(item.startsAt, timeZone)}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
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
