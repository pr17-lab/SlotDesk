import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Org, type Window } from './fake-api';

const owner: Org = { id: 'o1', name: 'Northside Clinic', role: 'owner' };
const staff: Org = { ...owner, role: 'staff' };
const room = { id: 'r1', name: 'Room 1', timeZone: 'Europe/London' };
const hoursPath = '/api/orgs/o1/resources/r1/working-hours';

const weekdays: Window[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

function open(given: { org?: Org; windows?: Window[] } = {}) {
  const api = fakeApi({
    orgs: [given.org ?? owner],
    resources: [room],
    windows: given.windows ?? weekdays,
  });
  render(
    <RouterProvider
      router={createMemoryRouter(routes, {
        initialEntries: ['/orgs/o1/resources/r1'],
      })}
    />,
  );
  return api;
}

const field = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads the windows into rows', async () => {
  open();

  await screen.findByRole('heading', { name: 'Room 1' });
  expect(field('Open on Monday').checked).toBe(true);
  expect(field('Monday start').value).toBe('09:00');
  expect(field('Monday end').value).toBe('17:00');
  expect(field('Open on Saturday').checked).toBe(false);
  expect(screen.queryByLabelText('Saturday start')).toBeNull();
});

it('saves the minutes, leaves closed days out and says so', async () => {
  const api = open();

  await screen.findByRole('heading', { name: 'Room 1' });
  await userEvent.click(field('Open on Saturday'));
  await userEvent.selectOptions(field('Saturday end'), '12:30');
  await userEvent.click(field('Open on Friday'));
  await userEvent.click(
    screen.getByRole('button', { name: 'Save working hours' }),
  );

  expect(await screen.findByText('Working hours saved')).toBeTruthy();
  const puts = api.callsTo('PUT', hoursPath);
  expect(puts).toHaveLength(1);
  expect(puts[0].body).toEqual({
    windows: [
      { weekday: 1, startMinute: 540, endMinute: 1020 },
      { weekday: 2, startMinute: 540, endMinute: 1020 },
      { weekday: 3, startMinute: 540, endMinute: 1020 },
      { weekday: 4, startMinute: 540, endMinute: 1020 },
      { weekday: 6, startMinute: 540, endMinute: 750 },
    ],
  });
});

it('shows end before start on its row and sends nothing', async () => {
  const api = open();

  await screen.findByRole('heading', { name: 'Room 1' });
  await userEvent.selectOptions(field('Tuesday end'), '08:00');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save working hours' }),
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('End must be after start');
  expect(alert.closest('li')?.textContent).toContain('Tuesday');
  expect(api.callsTo('PUT', hoursPath)).toHaveLength(0);
});

it('shows a day with two windows as read-only text', async () => {
  open({
    windows: [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
    ],
  });

  expect(
    await screen.findByText(/Monday 9:00 AM to 12:00 PM, 1:00 PM to 5:00 PM/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'These hours can only be edited through the API (split days or open until midnight)',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Save working hours' }),
  ).toBeNull();
  expect(screen.queryByLabelText('Open on Monday')).toBeNull();
});

it('copies Monday to Tuesday through Friday and leaves the weekend', async () => {
  const api = open({
    windows: [{ weekday: 1, startMinute: 600, endMinute: 900 }],
  });

  await screen.findByRole('heading', { name: 'Room 1' });
  expect(field('Open on Tuesday').checked).toBe(false);
  await userEvent.click(
    screen.getByRole('button', { name: 'Copy Monday to weekdays' }),
  );

  for (const day of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    expect(field(`Open on ${day}`).checked).toBe(true);
    expect(field(`${day} start`).value).toBe('10:00');
    expect(field(`${day} end`).value).toBe('15:00');
  }
  expect(field('Open on Saturday').checked).toBe(false);
  expect(field('Open on Sunday').checked).toBe(false);
  expect(api.callsTo('PUT', hoursPath)).toHaveLength(0);
});

it('shows staff the read-only week without a save button or notice', async () => {
  open({ org: staff });

  expect(await screen.findByText(/Monday 9:00 AM to 5:00 PM/)).toBeTruthy();
  expect(screen.getByText(/Saturday closed/)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Save working hours' }),
  ).toBeNull();
  expect(screen.queryByText(/only be edited through the API/)).toBeNull();
  expect(screen.queryByLabelText('Open on Monday')).toBeNull();
});

// The time fields are selects now. The cast is safe: getByLabelText finds one.
const timeSelect = (label: string) =>
  screen.getByLabelText(label) as HTMLSelectElement;

const optionLabels = (select: HTMLSelectElement) =>
  Array.from(select.options).map((option) => option.textContent);

it('offers 15-minute 12-hour times that send 24-hour values', async () => {
  open();

  await screen.findByRole('heading', { name: 'Room 1' });
  const start = timeSelect('Monday start');
  expect(optionLabels(start)[0]).toBe('12:00 AM');
  expect(optionLabels(start).at(-1)).toBe('11:45 PM');
  expect(start.options).toHaveLength(96);
  const end = timeSelect('Monday end');
  expect(optionLabels(end).at(-1)).toBe('11:59 PM');
  expect(end.options[end.options.length - 1].value).toBe('23:59');
  const nine = Array.from(start.options).find(
    (option) => option.textContent === '9:00 AM',
  );
  expect(nine?.value).toBe('09:00');
});

it('keeps a saved time that is not on the 15-minute list', async () => {
  const api = open({
    windows: [{ weekday: 1, startMinute: 550, endMinute: 1020 }],
  });

  await screen.findByRole('heading', { name: 'Room 1' });
  const start = timeSelect('Monday start');
  expect(start.selectedOptions[0].textContent).toBe('9:10 AM');
  const labels = optionLabels(start);
  expect(labels.indexOf('9:10 AM')).toBe(labels.indexOf('9:00 AM') + 1);
  await userEvent.click(
    screen.getByRole('button', { name: 'Save working hours' }),
  );

  expect(await screen.findByText('Working hours saved')).toBeTruthy();
  expect(api.callsTo('PUT', hoursPath)[0].body).toEqual({
    windows: [{ weekday: 1, startMinute: 550, endMinute: 1020 }],
  });
});

it('sends 1439 when the end is 11:59 PM', async () => {
  const api = open();

  await screen.findByRole('heading', { name: 'Room 1' });
  await userEvent.selectOptions(timeSelect('Friday end'), '11:59 PM');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save working hours' }),
  );

  expect(await screen.findByText('Working hours saved')).toBeTruthy();
  const body = api.callsTo('PUT', hoursPath)[0].body as { windows: Window[] };
  expect(body.windows.find((w) => w.weekday === 5)?.endMinute).toBe(1439);
});

it('says the latest end is 11:59 PM', async () => {
  open();

  expect(
    await screen.findByText(
      "Times are in Europe/London. A day can't stay open until midnight; the latest end is 11:59 PM.",
    ),
  ).toBeTruthy();
});
