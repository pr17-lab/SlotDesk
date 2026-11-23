import { useState } from 'react';
import { useFetcher } from 'react-router';
import type { Booking, Service } from '../api';
import { dayLabel, localDate, localTime, timeRange } from '../time';
import {
  Badge,
  Card,
  FormMessage,
  Modal,
  SecondaryButton,
  focusStyle,
} from '../ui';
import type { resourceAction } from './Resource';

// "Monday 5 January" and "09:00–09:30" for one booking, in the resource's zone.
function when(booking: Booking, timeZone: string) {
  return {
    day: dayLabel(localDate(booking.startsAt, timeZone), true),
    range: timeRange(booking.startsAt, booking.endsAt, timeZone),
    start: localTime(booking.startsAt, timeZone),
  };
}

export function Bookings({
  timeZone,
  services,
  bookings,
}: {
  timeZone: string;
  services: Service[];
  bookings: Booking[];
}) {
  const [chosen, setChosen] = useState<Booking | null>(null);
  // A new key for every opened dialog, so it never starts with an old result.
  const [attempt, setAttempt] = useState(0);
  const fetcher = useFetcher<typeof resourceAction>({
    key: `cancel-${attempt}`,
  });
  const cancelling = fetcher.state !== 'idle';
  const notice =
    fetcher.data && 'notice' in fetcher.data ? fetcher.data.notice : undefined;

  return (
    <Card title="Bookings">
      <FormMessage result={{ notice }} />
      {bookings.length === 0 ? (
        <p className="text-muted mt-2">No bookings in these 7 days.</p>
      ) : (
        <ul className="divide-border mt-2 divide-y">
          {bookings.map((booking) => {
            const time = when(booking, timeZone);
            const confirmed = booking.status === 'confirmed';
            const service = services.find((s) => s.id === booking.serviceId);
            return (
              <li
                key={booking.id}
                className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 ${confirmed ? '' : 'text-muted'}`}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {`${dayLabel(localDate(booking.startsAt, timeZone))}, ${time.range}`}
                  </p>
                  <p>{booking.customerName}</p>
                  <p className="text-muted text-sm">{booking.customerEmail}</p>
                  <p className="text-muted text-sm">
                    {service?.name ?? 'Unknown service'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge>{confirmed ? 'Confirmed' : 'Cancelled'}</Badge>
                  {confirmed && (
                    <button
                      type="button"
                      aria-label={`Cancel booking for ${booking.customerName} at ${time.start} on ${time.day}`}
                      onClick={() => {
                        setChosen(booking);
                        setAttempt(attempt + 1);
                      }}
                      className={`border-muted bg-surface text-ink rounded-control hover:bg-background border px-3 py-1.5 text-sm font-medium transition-colors ${focusStyle}`}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {chosen && !notice && (
        <Modal title="Cancel booking?" onClose={() => setChosen(null)}>
          <p className="mt-2">
            {`${chosen.customerName}, ${when(chosen, timeZone).range} on ${when(chosen, timeZone).day}. The time becomes free again.`}
          </p>
          <fetcher.Form method="post" className="mt-4 space-y-4">
            <input type="hidden" name="intent" value="cancel" />
            <input type="hidden" name="bookingId" value={chosen.id} />
            <FormMessage result={fetcher.data} />
            <div className="flex flex-wrap gap-3">
              <SecondaryButton type="button" onClick={() => setChosen(null)}>
                Keep booking
              </SecondaryButton>
              <button
                type="submit"
                disabled={cancelling}
                className={`bg-danger text-accent-ink rounded-control px-4 py-2 font-medium disabled:opacity-60 ${focusStyle}`}
              >
                {cancelling ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </div>
          </fetcher.Form>
        </Modal>
      )}
    </Card>
  );
}
