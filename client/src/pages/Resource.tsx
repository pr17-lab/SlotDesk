import { useState } from 'react';
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { api, errorToData, pathParam, type Org } from '../api';
import { Page } from '../Page';
import { requireUser } from '../session';
import { Breadcrumb, Button, Card, FormMessage, focusStyle } from '../ui';

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

export async function resourceLoader({ params }: LoaderFunctionArgs) {
  await requireUser();
  const orgId = pathParam(params, 'orgId');
  const resourceId = pathParam(params, 'resourceId');
  const base = `/orgs/${orgId}/resources/${resourceId}`;
  const [org, resource, hours] = await Promise.all([
    api<Org>(`/orgs/${orgId}`),
    api<{ id: string; name: string; timeZone: string }>(base),
    api<{ windows: Window[] }>(`${base}/working-hours`),
  ]);
  return { org, resource, windows: hours.windows };
}

export async function resourceAction({ request, params }: ActionFunctionArgs) {
  const orgId = pathParam(params, 'orgId');
  const resourceId = pathParam(params, 'resourceId');
  const form = await request.formData();

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

const timeInputStyle = `border-muted bg-surface text-ink rounded-control border px-2 py-1 ${focusStyle}`;

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
                <label className="relative inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    name={`open-${weekday}`}
                    aria-label={`Open on ${day}`}
                    checked={row.open}
                    onChange={(event) =>
                      change(index, { open: event.target.checked })
                    }
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-muted peer-checked:bg-accent peer-focus-visible:outline-accent after:bg-surface relative h-6 w-11 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:transition-transform peer-checked:after:translate-x-5"
                  />
                  <span className="text-muted w-14 text-sm">
                    {row.open ? 'Open' : 'Closed'}
                  </span>
                </label>
                {row.open && (
                  <>
                    <div className="flex items-center gap-2">
                      <span aria-hidden="true" className="text-muted text-sm">
                        Start
                      </span>
                      <input
                        type="time"
                        name={`start-${weekday}`}
                        aria-label={`${day} start`}
                        value={row.start}
                        onChange={(event) =>
                          change(index, { start: event.target.value })
                        }
                        required
                        className={timeInputStyle}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span aria-hidden="true" className="text-muted text-sm">
                        End
                      </span>
                      <input
                        type="time"
                        name={`end-${weekday}`}
                        aria-label={`${day} end`}
                        value={row.end}
                        onChange={(event) =>
                          change(index, { end: event.target.value })
                        }
                        required
                        className={timeInputStyle}
                      />
                    </div>
                  </>
                )}
                {badDays.includes(weekday) && (
                  <p role="alert" className="text-danger basis-full text-sm">
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
          <button
            type="button"
            onClick={copyMonday}
            className={`border-muted bg-surface text-ink rounded-control border px-4 py-2 font-medium ${focusStyle}`}
          >
            Copy Monday to weekdays
          </button>
        </div>
        <FormMessage result={fetcher.data} />
      </fetcher.Form>
      <p className="text-muted mt-4 text-sm">
        {`Times are in ${timeZone}. A day can't stay open until midnight; the latest end is 23:59.`}
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
          .map((w) => `${toTime(w.startMinute)} to ${toTime(w.endMinute)}`);
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
  const { org, resource, windows } = useLoaderData<typeof resourceLoader>();
  const isOwner = org.role === 'owner';
  const canEdit = isOwner && fitsEditor(windows);

  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Organizations', to: '/' },
          { label: org.name, to: `/orgs/${org.id}` },
          { label: resource.name },
        ]}
      />
      <h1 className="mt-2 text-2xl font-semibold">{resource.name}</h1>
      <p className="text-muted">{resource.timeZone}</p>

      <div className="mt-8">
        <Card title="Working hours">
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
                <p className="border-border bg-background rounded-control mt-4 border p-3 text-sm">
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
