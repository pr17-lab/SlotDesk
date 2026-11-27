import { CalendarCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { api, ApiError } from '../api';
import { Page } from '../Page';
import { dayLabel, localDate, localTime, zoneAbbreviation } from '../time';
import { Card, FormMessage, Modal, SecondaryButton } from '../ui';

// /manage#<secret>: the customer's cancel link. No account and no session.
// The secret stays in the address, because the link is meant to be saved
// and opened again; it never goes to the server except in a request body.

type Managed = {
  businessName: string;
  serviceName: string;
  resourceName: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: 'confirmed' | 'cancelled';
  cancelBefore: string;
};

type View =
  | { kind: 'loading' }
  | { kind: 'broken' }
  | { kind: 'failed'; message: string }
  | { kind: 'shown'; booking: Managed };

const ask = (action: 'lookup' | 'cancel', token: string) =>
  api<Managed>(`/manage/${action}`, { method: 'POST', body: { token } });

export function Manage() {
  const { hash } = useLocation();
  // A new secret in the address starts over.
  return <ManageLink key={hash} token={hash.slice(1)} />;
}

function ManageLink({ token }: { token: string }) {
  const [view, setView] = useState<View>(
    token ? { kind: 'loading' } : { kind: 'broken' },
  );

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    ask('lookup', token).then(
      (booking) => {
        if (!stopped) setView({ kind: 'shown', booking });
      },
      (error: unknown) => {
        if (stopped) return;
        // Unknown, broken and already started all get the same 404.
        if (error instanceof ApiError && error.status === 404) {
          setView({ kind: 'broken' });
        } else {
          setView({
            kind: 'failed',
            message:
              error instanceof ApiError
                ? error.message
                : 'Something went wrong',
          });
        }
      },
    );
    return () => {
      stopped = true;
    };
  }, [token]);

  if (view.kind === 'loading') {
    return (
      <Page>
        <p role="status" className="text-muted-foreground">
          Loading your booking…
        </p>
      </Page>
    );
  }
  if (view.kind === 'broken') {
    return (
      <Page>
        <Card title="This link doesn't work">
          <p className="mt-2">
            To change or cancel a booking, contact the business.
          </p>
        </Card>
      </Page>
    );
  }
  if (view.kind === 'failed') {
    return (
      <Page>
        <Card title="Your booking couldn't be loaded">
          <p className="text-destructive mt-2">{view.message}</p>
        </Card>
      </Page>
    );
  }
  return <ManagedBooking token={token} initial={view.booking} />;
}

function ManagedBooking({
  token,
  initial,
}: {
  token: string;
  initial: Managed;
}) {
  const [booking, setBooking] = useState(initial);
  const [justCancelled, setJustCancelled] = useState(false);
  const [tooLate, setTooLate] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // Read once, when the page opens. If it stays open past the cut-off, the
  // server answers 409 and the page says so.
  const [openedAt] = useState(Date.now);
  const { timeZone } = booking;
  const when = (instant: string) =>
    `${dayLabel(localDate(instant, timeZone))}, ${localTime(instant, timeZone)} ${zoneAbbreviation(instant, timeZone)}`;
  // The server decides; the browser's clock only picks what to show.
  const canCancel =
    booking.status === 'confirmed' &&
    !tooLate &&
    openedAt < Date.parse(booking.cancelBefore);

  async function cancel() {
    setSending(true);
    setError(undefined);
    try {
      setBooking(await ask('cancel', token));
      setJustCancelled(true);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (caught.status === 409) setTooLate(true);
      else setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  const rows = [
    ['Service', booking.serviceName],
    ['With', booking.resourceName],
    ['When', when(booking.startsAt)],
  ];

  return (
    <Page>
      <h1 className="text-3xl font-semibold tracking-tight">
        {booking.businessName}
      </h1>
      <div className="mt-8">
        <Card title="Your booking" icon={CalendarCheck}>
          <dl className="divide-border mt-2 divide-y">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-4 py-2">
                <dt className="text-muted-foreground w-20 shrink-0">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {justCancelled ? (
            <FormMessage
              result={{ notice: 'Booking cancelled. The time is free again.' }}
            />
          ) : booking.status === 'cancelled' ? (
            <p className="mt-4">This booking is cancelled.</p>
          ) : canCancel ? (
            <>
              <p className="mt-4">{`You can cancel online until ${when(booking.cancelBefore)}.`}</p>
              <Button
                type="button"
                variant="destructive"
                className="mt-4"
                onClick={() => setConfirming(true)}
              >
                Cancel booking
              </Button>
            </>
          ) : (
            <p className="mt-4">
              Online cancelling closed 24 hours before your booking. To cancel,
              contact the business.
            </p>
          )}
        </Card>
      </div>

      {confirming && canCancel && (
        <Modal
          title="Cancel this booking?"
          onClose={() => setConfirming(false)}
        >
          <p className="mt-2">
            {`${booking.serviceName}, ${when(booking.startsAt)}. The time becomes free for others.`}
          </p>
          <div className="mt-4 space-y-4">
            <FormMessage result={error ? { error } : null} />
            <div className="flex flex-wrap gap-3">
              <DialogClose render={<SecondaryButton type="button" />}>
                Keep booking
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={sending}
                onClick={cancel}
              >
                {sending ? 'Cancelling…' : 'Cancel booking'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
