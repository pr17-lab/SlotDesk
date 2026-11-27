import { CalendarCheck, CalendarDays } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Form,
  useFetcher,
  useLoaderData,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { api, ApiError, pathParam, type Service, type Slot } from '../api';
import { Page } from '../Page';
import {
  addDays,
  dayLabel,
  localDate,
  localTime,
  zoneAbbreviation,
} from '../time';
import { loadTurnstile } from '../turnstile';
import {
  Card,
  CopyButton,
  FormMessage,
  Modal,
  SecondaryButton,
  SecondaryLink,
  TextField,
  focusStyle,
} from '../ui';
import { CANCEL_NOTICE_HOURS, cancelLink, newSecret } from '../cancel-link';

// The customer's booking page: no account and no session. The business comes
// from the link the owner chose.

type Resource = { id: string; name: string; timeZone: string };

type PublicPage = {
  name: string;
  resources: Resource[];
  services: Service[];
  // Null when the server has no bot check keys: online booking is off.
  turnstileSiteKey: string | null;
};

// What the server stored, for the confirmation.
type Booked = {
  startsAt: string;
  endsAt: string;
  serviceName: string;
  resourceName: string;
  timeZone: string;
};

// The server takes online bookings up to 30 days ahead.
const HORIZON_DAYS = 30;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

// The first day shown: the `from` in the URL if it is a real date from today
// to the last bookable day, otherwise today.
function firstDay(from: string | null, today: string, lastDay: string) {
  const usable =
    from !== null &&
    datePattern.test(from) &&
    addDays(from, 0) === from &&
    from >= today &&
    from <= lastDay;
  return usable ? from : today;
}

// encodeURIComponent, so a link like /book/..%2Forgs can't reach another API path.
const pageApi = (slug: string) => `/public/${encodeURIComponent(slug)}`;

export async function publicBookingLoader({
  params,
  request,
}: LoaderFunctionArgs) {
  const slug = pathParam(params, 'slug');
  let page: PublicPage;
  try {
    page = await api<PublicPage>(pageApi(slug));
  } catch (error) {
    // Unknown and turned-off links get the same 404.
    if (error instanceof ApiError && error.status === 404) {
      return { available: false as const };
    }
    throw error;
  }

  const search = new URL(request.url).searchParams;
  const resource =
    page.resources.find((item) => item.id === search.get('with')) ??
    page.resources[0];
  const service =
    page.services.find((item) => item.id === search.get('service')) ??
    page.services[0];
  if (!page.turnstileSiteKey || !resource || !service) {
    return { available: false as const };
  }

  const today = localDate(new Date(), resource.timeZone);
  const lastDay = addDays(today, HORIZON_DAYS);
  const from = firstDay(search.get('from'), today, lastDay);
  const to = addDays(from, 6) < lastDay ? addDays(from, 6) : lastDay;
  const { slots } = await api<{ slots: Slot[] }>(
    `${pageApi(slug)}/resources/${resource.id}/availability?` +
      new URLSearchParams({ serviceId: service.id, from, to }),
  );
  return {
    available: true as const,
    page,
    siteKey: page.turnstileSiteKey,
    resource,
    service,
    slots,
    today,
    from,
    to,
    lastDay,
  };
}

// The messages a customer needs; anything else is the general one.
function bookingError(error: unknown) {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 409) {
    return 'This time is no longer free. If you just booked it, your booking went through.';
  }
  if (error.status === 422) {
    return 'Your booking already went through with the details you first entered. If something is wrong, contact the business.';
  }
  if (error.status === 429 && error.serverError === 'Daily limit reached') {
    return 'Online booking is paused for today. Please contact the business.';
  }
  if (error.status === 503) {
    return "The booking check isn't answering. Try again in a minute.";
  }
  if (error.status === 404) return 'This booking page is no longer available.';
  return error.message;
}

export async function publicBookingAction({
  params,
  request,
}: ActionFunctionArgs) {
  const slug = pathParam(params, 'slug');
  const form = await request.formData();
  const turnstileToken = String(form.get('turnstileToken') ?? '');
  if (!turnstileToken) return { error: 'Please complete the check first' };

  const customerName = String(form.get('customerName'));
  const manageToken = String(form.get('manageToken'));
  try {
    const booked = await api<Booked>(`${pageApi(slug)}/bookings`, {
      method: 'POST',
      body: {
        resourceId: String(form.get('resourceId')),
        serviceId: String(form.get('serviceId')),
        startsAt: String(form.get('startsAt')),
        customerName,
        customerEmail: String(form.get('customerEmail')),
        turnstileToken,
        manageToken,
      },
      headers: { 'Idempotency-Key': `"${String(form.get('idempotencyKey'))}"` },
    });
    return { booked: { ...booked, customerName, manageToken } };
  } catch (error) {
    return { error: bookingError(error) };
  }
}

// Draws Cloudflare's check and reports its token: '' until it passes, and
// again once the token runs out.
function BotCheck({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let remove = () => {};
    loadTurnstile().then(
      (turnstile) => {
        const container = box.current;
        if (stopped || !container) return;
        const widgetId = turnstile.render(container, {
          sitekey: siteKey,
          theme: 'light',
          // The normal widget is 300 px wide; a phone's dialog is narrower.
          size: container.clientWidth >= 300 ? 'normal' : 'compact',
          'response-field': false,
          callback: onToken,
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        });
        remove = () => turnstile.remove(widgetId);
      },
      () => {
        if (!stopped) setFailed(true);
      },
    );
    return () => {
      stopped = true;
      remove();
    };
  }, [siteKey, onToken]);

  if (failed) {
    return (
      <p role="alert" className="text-destructive text-sm">
        The booking check could not load. Reload the page to try again.
      </p>
    );
  }
  // Holds the widget's height, so the buttons don't jump when it appears.
  return <div ref={box} className="min-h-[65px]" />;
}

function BookDialog({
  slot,
  service,
  resource,
  showWith,
  siteKey,
  fetcher,
  onClose,
}: {
  slot: Slot;
  service: Service;
  resource: Resource;
  showWith: boolean;
  siteKey: string;
  fetcher: ReturnType<typeof useFetcher<typeof publicBookingAction>>;
  onClose: () => void;
}) {
  const [token, setToken] = useState('');
  // One key for every try in this dialog, so a retry after a lost answer
  // gets the same booking back instead of a 409. The cancel secret goes with
  // it: the server keeps only its hash, so a retry can't get it back.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [manageToken] = useState(newSecret);
  // A new React key draws a new widget.
  const [check, setCheck] = useState(0);
  const booking = fetcher.state !== 'idle';
  const { timeZone } = resource;

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('turnstileToken', token);
    fetcher.submit(form, { method: 'post' });
    // A token works once, and the server may have used it even if the
    // booking fails, so draw a fresh check straight away.
    if (token) {
      setToken('');
      setCheck(check + 1);
    }
  }

  return (
    <Modal
      title={`Book ${localTime(slot.startsAt, timeZone)}, ${dayLabel(localDate(slot.startsAt, timeZone), true)}`}
      onClose={onClose}
    >
      <p className="text-muted-foreground mt-1 text-sm">
        {`${service.name} · ${service.durationMinutes} min${showWith ? ` · With ${resource.name}` : ''}`}
      </p>
      <form onSubmit={send} className="mt-4 space-y-4">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <input type="hidden" name="manageToken" value={manageToken} />
        <input type="hidden" name="resourceId" value={resource.id} />
        <input type="hidden" name="serviceId" value={service.id} />
        <input type="hidden" name="startsAt" value={slot.startsAt} />
        <TextField
          label="Your name"
          name="customerName"
          required
          maxLength={100}
          autoComplete="name"
          autoFocus
        />
        <TextField
          label="Your email"
          name="customerEmail"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
        />
        <BotCheck key={check} siteKey={siteKey} onToken={setToken} />
        <FormMessage result={fetcher.data} />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={booking}>
            {booking ? 'Booking…' : 'Book'}
          </Button>
          <DialogClose render={<SecondaryButton type="button" />}>
            Close
          </DialogClose>
        </div>
      </form>
    </Modal>
  );
}

function YouAreBooked({
  business,
  booked,
  showWith,
  onAgain,
}: {
  business: string;
  booked: Booked & { customerName: string; manageToken: string };
  showWith: boolean;
  onAgain: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The dialog has just gone, so the focus moves to what it did.
  useEffect(() => box.current?.focus(), []);
  const { startsAt, timeZone } = booked;
  const when = (instant: string) =>
    `${dayLabel(localDate(instant, timeZone))}, ${localTime(instant, timeZone)} ${zoneAbbreviation(instant, timeZone)}`;
  // The server decides; this only chooses what to show.
  const [bookedAt] = useState(Date.now);
  const cancelBefore = new Date(
    Date.parse(startsAt) - CANCEL_NOTICE_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const link = cancelLink(booked.manageToken);
  const rows = [
    ['Business', business],
    ['Service', booked.serviceName],
    ...(showWith ? [['With', booked.resourceName]] : []),
    ['When', when(startsAt)],
    ['Name', booked.customerName],
  ];

  return (
    <div
      ref={box}
      tabIndex={-1}
      className={`motion-safe:animate-fade-in rounded-xl ${focusStyle}`}
    >
      <Card title="You're booked" icon={CalendarCheck}>
        <dl className="divide-border mt-2 divide-y">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-4 py-2">
              <dt className="text-muted-foreground w-20 shrink-0">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {bookedAt < Date.parse(cancelBefore) ? (
          <div className="mt-4 space-y-3">
            <TextField
              label="Your cancel link"
              value={link}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <p className="text-muted-foreground text-sm">
              {`Save this link. You can cancel online until ${when(cancelBefore)}. Anyone with it can cancel this booking.`}
            </p>
            <CopyButton text={link} />
            <p>To change a booking, contact the business.</p>
          </div>
        ) : (
          <p className="mt-4">
            This booking starts within 24 hours, so it can&apos;t be cancelled
            online. Contact the business to cancel.
          </p>
        )}
        <SecondaryButton type="button" className="mt-4" onClick={onAgain}>
          Book another time
        </SecondaryButton>
      </Card>
    </div>
  );
}

function Unavailable() {
  return (
    <Page>
      <Card title="Online booking isn't available">
        <p className="text-muted-foreground mt-2">
          This page isn't taking bookings right now. Contact the business to
          book.
        </p>
      </Card>
    </Page>
  );
}

export function PublicBooking() {
  const data = useLoaderData<typeof publicBookingLoader>();
  if (!data.available) return <Unavailable />;
  return <BookingPage {...data} />;
}

function BookingPage({
  page,
  siteKey,
  resource,
  service,
  slots,
  today,
  from,
  to,
  lastDay,
}: Extract<
  Awaited<ReturnType<typeof publicBookingLoader>>,
  { available: true }
>) {
  const [chosen, setChosen] = useState<Slot | null>(null);
  // A new key for every opened dialog, so it never starts with an old result.
  const [attempt, setAttempt] = useState(0);
  const fetcher = useFetcher<typeof publicBookingAction>({
    key: `public-book-${attempt}`,
  });
  const submit = useSubmit();
  const booked =
    fetcher.data && 'booked' in fetcher.data ? fetcher.data.booked : undefined;
  const showWith = page.resources.length > 1;
  const { timeZone } = resource;

  function weekLink(start: string) {
    return `?${new URLSearchParams({ from: start, service: service.id, with: resource.id })}`;
  }
  const previous = addDays(from, -7) > today ? addDays(from, -7) : today;
  const next = addDays(from, 7);

  // Days after the last bookable one are left out.
  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(from, index),
  ).filter((day) => day <= lastDay);
  const daySlots = (day: string) =>
    slots.filter((slot) => localDate(slot.startsAt, timeZone) === day);

  return (
    <Page>
      <h1 className="text-3xl font-semibold tracking-tight">{page.name}</h1>
      <p className="text-muted-foreground mt-1">
        Pick a time that suits you. No account needed.
      </p>

      <div className="mt-8">
        {booked ? (
          <YouAreBooked
            business={page.name}
            booked={booked}
            showWith={showWith}
            onAgain={() => {
              setChosen(null);
              setAttempt(attempt + 1);
            }}
          />
        ) : (
          <Card title="Choose a time" icon={CalendarDays}>
            <Form method="get" className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
              <input type="hidden" name="from" value={from} />
              <div className="w-full sm:w-auto">
                <Label htmlFor="service">Service</Label>
                <NativeSelect
                  id="service"
                  name="service"
                  value={service.id}
                  onChange={(event) => submit(event.currentTarget.form)}
                  className="mt-1 w-full sm:w-fit"
                >
                  {page.services.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {`${item.name} · ${item.durationMinutes} min`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {showWith ? (
                <div className="w-full sm:w-auto">
                  <Label htmlFor="with">With</Label>
                  <NativeSelect
                    id="with"
                    name="with"
                    value={resource.id}
                    onChange={(event) => submit(event.currentTarget.form)}
                    className="mt-1 w-full sm:w-fit"
                  >
                    {page.resources.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {item.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <input type="hidden" name="with" value={resource.id} />
              )}
            </Form>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{`${dayLabel(from)} to ${dayLabel(to)}`}</p>
                <p className="text-muted-foreground text-sm">
                  {`All times are in ${timeZone} (${zoneAbbreviation(new Date(), timeZone)}).`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {from > today && (
                  <SecondaryLink small to={weekLink(previous)}>
                    Previous 7 days
                  </SecondaryLink>
                )}
                {next <= lastDay && (
                  <SecondaryLink small to={weekLink(next)}>
                    Next 7 days
                  </SecondaryLink>
                )}
              </div>
            </div>

            <ol className="mt-4 space-y-4">
              {days.map((day) => {
                const free = daySlots(day);
                return (
                  <li key={day}>
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      {dayLabel(day)}
                      {day === today && (
                        <span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                          Today
                        </span>
                      )}
                    </h3>
                    {free.length === 0 ? (
                      <p className="text-muted-foreground mt-1 text-sm">
                        No free times
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {free.map((slot) => (
                          <li key={slot.startsAt}>
                            <button
                              type="button"
                              aria-label={`Book ${localTime(slot.startsAt, timeZone)} on ${dayLabel(day, true)}`}
                              onClick={() => {
                                setChosen(slot);
                                setAttempt(attempt + 1);
                              }}
                              className={`bg-accent text-primary hover:bg-primary hover:text-primary-foreground min-w-20 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${focusStyle}`}
                            >
                              {localTime(slot.startsAt, timeZone)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          </Card>
        )}
      </div>

      {chosen && !booked && (
        <BookDialog
          slot={chosen}
          service={service}
          resource={resource}
          showWith={showWith}
          siteKey={siteKey}
          fetcher={fetcher}
          onClose={() => setChosen(null)}
        />
      )}
    </Page>
  );
}
