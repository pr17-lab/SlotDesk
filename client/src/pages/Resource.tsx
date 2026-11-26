import { Clock } from 'lucide-react';
import { useMemo, useState, type ComponentProps } from 'react';
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  api,
  ApiError,
  errorToData,
  pathParam,
  type Booking,
  type Org,
  type Service,
  type Slot,
} from '../api';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Page } from '../Page';
import { requireUser } from '../session';
import { addDays, localDate, minutesLabel } from '../time';
import { Breadcrumb, Card, FormMessage, SecondaryButton } from '../ui';
import { Bookings } from './Bookings';
import { Schedule } from './Schedule';

type Window = { weekday: number; startMinute: number; endMinute: number };

// Weekday 1 is Monday, as in the API.
const dayNames = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

// "09:00" to 540, and back. Minutes count from the resource's own midnight.
function toMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function toTime(minutes: number) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

// The first day of the 7-day range: the `from` in the URL if it is a real
// date in 2000 to 2099, otherwise today.
function firstDay(from: string | null, today: string) {
  const usable =
    from !== null &&
    datePattern.test(from) &&
    from >= '2000-01-01' &&
    from <= '2099-12-31' &&
    addDays(from, 0) === from;
  return usable ? from : today;
}

export async function resourceLoader({ params, request }: LoaderFunctionArgs) {
  await requireUser();
  const orgId = pathParam(params, 'orgId');
  const resourceId = pathParam(params, 'resourceId');
  const base = `/orgs/${orgId}/resources/${resourceId}`;
  const search = new URL(request.url).searchParams;

  // Today depends on the resource's zone, so the range waits for the resource.
  const resourceRequest = api<{ id: string; name: string; timeZone: string }>(
    base,
  );
  const rangeRequest = resourceRequest.then((resource) => {
    const today = localDate(new Date(), resource.timeZone);
    const from = firstDay(search.get('from'), today);
    return { today, from, to: addDays(from, 6) };
  });
  const [org, resource, hours, services, range, bookings] = await Promise.all([
    api<Org>(`/orgs/${orgId}`),
    resourceRequest,
    api<{ windows: Window[] }>(`${base}/working-hours`),
    api<Service[]>(`/orgs/${orgId}/services`),
    rangeRequest,
    rangeRequest.then(({ from, to }) =>
      api<Booking[]>(
        `/orgs/${orgId}/bookings?` +
          new URLSearchParams({ resourceId, from, to }),
      ),
    ),
  ]);

  const service =
    services.find((item) => item.id === search.get('service')) ?? services[0];
  let slots: Slot[] = [];
  if (service) {
    const availability = await api<{ slots: Slot[] }>(
      `${base}/availability?` +
        new URLSearchParams({
          serviceId: service.id,
          from: range.from,
          to: range.to,
        }),
    );
    slots = availability.slots;
  }
  return {
    org,
    resource,
    windows: hours.windows,
    services,
    service,
    bookings,
    slots,
    ...range,
  };
}

async function saveHours(orgId: string, resourceId: string, form: FormData) {
  const windows: Window[] = [];
  const badDays: number[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (!form.has(`open-${weekday}`)) continue;
    const startMinute = toMinutes(String(form.get(`start-${weekday}`)));
    const endMinute = toMinutes(String(form.get(`end-${weekday}`)));
    // Written this way so a time that did not parse (NaN) counts as bad too.
    if (endMinute > startMinute) {
      windows.push({ weekday, startMinute, endMinute });
    } else {
      badDays.push(weekday);
    }
  }
  if (badDays.length > 0) return { badDays };

  try {
    await api(`/orgs/${orgId}/resources/${resourceId}/working-hours`, {
      method: 'PUT',
      body: { windows },
    });
  } catch (error) {
    return errorToData(error);
  }
  return { notice: 'Working hours saved' };
}

async function bookSlot(orgId: string, resourceId: string, form: FormData) {
  let created: Booking;
  try {
    created = await api<Booking>(`/orgs/${orgId}/bookings`, {
      method: 'POST',
      body: {
        resourceId,
        serviceId: String(form.get('serviceId')),
        startsAt: String(form.get('startsAt')),
        customerName: String(form.get('customerName')),
        customerEmail: String(form.get('customerEmail')),
      },
      headers: { 'Idempotency-Key': `"${String(form.get('idempotencyKey'))}"` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return { error: 'This slot was just taken. Pick another time.' };
    }
    // The same key came back with other details: the first try went through.
    if (error instanceof ApiError && error.status === 422) {
      return {
        error:
          'This booking was already made with the details you first entered. Check the list below.',
      };
    }
    return errorToData(error);
  }
  return { notice: 'Booking confirmed', bookingId: created.id };
}

async function cancelBooking(orgId: string, form: FormData) {
  try {
    await api(
      `/orgs/${orgId}/bookings/${String(form.get('bookingId'))}/cancel`,
      {
        method: 'POST',
      },
    );
  } catch (error) {
    return errorToData(error);
  }
  return { notice: 'Booking cancelled' };
}

// One action for the page's three forms; each form says which with `intent`.
export async function resourceAction({ request, params }: ActionFunctionArgs) {
  const orgId = pathParam(params, 'orgId');
  const resourceId = pathParam(params, 'resourceId');
  const form = await request.formData();
  const intent = form.get('intent');

  if (intent === 'book') return bookSlot(orgId, resourceId, form);
  if (intent === 'cancel') return cancelBooking(orgId, form);
  if (intent === 'hours') return saveHours(orgId, resourceId, form);
  return { error: 'Unknown action' };
}

// The editor shows one window per day, ending before midnight. Anything else
// would be changed or lost on save, so it stays read-only.
function fitsEditor(windows: Window[]) {
  const days = new Set(windows.map((window) => window.weekday));
  return (
    days.size === windows.length && windows.every((w) => w.endMinute < 1440)
  );
}

type Row = { open: boolean; start: string; end: string };

function rowFor(window: Window | undefined): Row {
  if (!window) return { open: false, start: '09:00', end: '17:00' };
  return {
    open: true,
    start: toTime(window.startMinute),
    end: toTime(window.endMinute),
  };
}

// Minutes from midnight offered in the time selects: every 15 minutes. A day
// cannot end at midnight, so the last end is 23:59.
const startChoices = Array.from({ length: 96 }, (_, step) => step * 15);
const endChoices = [...startChoices.slice(1), 1439];

// Option values stay "HH:MM"; the labels are 12-hour. A saved time that is not
// on the list (set through the API) is added in its place so it is not changed.
function TimeSelect({
  choices,
  value,
  ...props
}: { choices: number[]; value: string } & ComponentProps<typeof NativeSelect>) {
  const saved = toMinutes(value);
  // Kept between renders: a week has 14 selects of ~96 options each, and
  // rebuilding them on every page update is slow.
  const options = useMemo(() => {
    const minutes = choices.includes(saved)
      ? choices
      : [...choices, saved].sort((a, b) => a - b);
    return minutes.map((option) => (
      <NativeSelectOption key={option} value={toTime(option)}>
        {minutesLabel(option)}
      </NativeSelectOption>
    ));
  }, [choices, saved]);

  return (
    <NativeSelect value={value} {...props}>
      {options}
    </NativeSelect>
  );
}

function HoursEditor({
  windows,
  timeZone,
}: {
  windows: Window[];
  timeZone: string;
}) {
  const fetcher = useFetcher<typeof resourceAction>();
  const saving = fetcher.state !== 'idle';
  const badDays =
    (fetcher.data && 'badDays' in fetcher.data && fetcher.data.badDays) || [];
  const [rows, setRows] = useState(() =>
    dayNames.map((_, index) =>
      rowFor(windows.find((window) => window.weekday === index + 1)),
    ),
  );

  function change(index: number, changes: Partial<Row>) {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }

  // Tuesday to Friday become a copy of Monday. Nothing is saved yet.
  function copyMonday() {
    setRows(rows.map((row, i) => (i >= 1 && i <= 4 ? rows[0] : row)));
  }

  return (
    <>
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="hours" />
        <ul className="divide-border mt-2 divide-y">
          {dayNames.map((day, index) => {
            const weekday = index + 1;
            const row = rows[index];
            return (
              <li
                key={day}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
              >
                <span className="w-24 font-medium">{day}</span>
                <div className="flex items-center gap-2">
                  <Switch
                    name={`open-${weekday}`}
                    aria-label={`Open on ${day}`}
                    checked={row.open}
                    onCheckedChange={(open) => change(index, { open })}
                  />
                  <span className="text-muted-foreground w-14 text-sm">
                    {row.open ? 'Open' : 'Closed'}
                  </span>
                </div>
                {row.open && (
                  <>
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground text-sm"
                      >
                        Start
                      </span>
                      <TimeSelect
                        choices={startChoices}
                        name={`start-${weekday}`}
                        aria-label={`${day} start`}
                        value={row.start}
                        onChange={(event) =>
                          change(index, { start: event.target.value })
                        }
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground text-sm"
                      >
                        End
                      </span>
                      <TimeSelect
                        choices={endChoices}
                        name={`end-${weekday}`}
                        aria-label={`${day} end`}
                        value={row.end}
                        onChange={(event) =>
                          change(index, { end: event.target.value })
                        }
                      />
                    </div>
                  </>
                )}
                {badDays.includes(weekday) && (
                  <p
                    role="alert"
                    className="text-destructive basis-full text-sm"
                  >
                    End must be after start
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save working hours'}
          </Button>
          <SecondaryButton type="button" onClick={copyMonday}>
            Copy Monday to weekdays
          </SecondaryButton>
        </div>
        <FormMessage result={fetcher.data} />
      </fetcher.Form>
      <p className="text-muted-foreground mt-4 text-sm">
        {`Times are in ${timeZone}. A day can't stay open until midnight; the latest end is 11:59 PM.`}
      </p>
    </>
  );
}

function ReadOnlyWeek({ windows }: { windows: Window[] }) {
  return (
    <ul className="divide-border mt-2 divide-y">
      {dayNames.map((day, index) => {
        const times = windows
          .filter((window) => window.weekday === index + 1)
          .sort((a, b) => a.startMinute - b.startMinute)
          .map(
            (w) =>
              `${minutesLabel(w.startMinute)} to ${minutesLabel(w.endMinute)}`,
          );
        return (
          <li key={day} className="py-3">
            {`${day} ${times.length > 0 ? times.join(', ') : 'closed'}`}
          </li>
        );
      })}
    </ul>
  );
}

export function Resource() {
  const data = useLoaderData<typeof resourceLoader>();
  const { org, resource, windows } = data;
  const isOwner = org.role === 'owner';
  const canEdit = isOwner && fitsEditor(windows);

  return (
    <Page wide>
      <Breadcrumb
        items={[
          { label: 'Organizations', to: '/' },
          { label: org.name, to: `/orgs/${org.id}` },
          { label: resource.name },
        ]}
      />
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        {resource.name}
      </h1>
      <p className="text-muted-foreground">{resource.timeZone}</p>

      <div className="mt-8 space-y-6">
        <Schedule
          orgId={org.id}
          timeZone={resource.timeZone}
          services={data.services}
          service={data.service}
          slots={data.slots}
          bookings={data.bookings}
          from={data.from}
          to={data.to}
          today={data.today}
        />
        <Bookings
          timeZone={resource.timeZone}
          services={data.services}
          bookings={data.bookings}
        />
        <Card title="Working hours" icon={Clock}>
          {canEdit ? (
            <HoursEditor
              key={resource.id}
              windows={windows}
              timeZone={resource.timeZone}
            />
          ) : (
            <>
              <ReadOnlyWeek windows={windows} />
              {isOwner && (
                <p className="border-border bg-background mt-4 rounded-lg border p-3 text-sm">
                  These hours can only be edited through the API (split days or
                  open until midnight)
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}
