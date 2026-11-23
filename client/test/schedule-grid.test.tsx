import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Booking, type Resource, type Slot } from './fake-api';

const room: Resource = {
  id: 'r1',
  name: 'Consultation room',
  timeZone: 'Asia/Kolkata',
};
const consultation = { id: 's1', name: 'Consultation', durationMinutes: 30 };
const windows = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

// An instant from an India (UTC+5:30) date and time, for example
// india('2099-01-05', '09:00') is 2099-01-05T03:30:00.000Z.
function india(day: string, time: string, plusMinutes = 0) {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utc = Date.UTC(year, month - 1, date, hour, minute + plusMinutes);
  return new Date(utc - 330 * 60000).toISOString();
}

function slotAt(day: string, time: string, minutes = 30): Slot {
  return {
    startsAt: india(day, time),
    endsAt: india(day, time, minutes),
  };
}

function bookingAt(
  day: string,
  time: string,
  changes: Partial<Booking> = {},
): Booking {
  return {
    id: 'b1',
    resourceId: 'r1',
    serviceId: 's1',
    startsAt: india(day, time),
    endsAt: india(day, time, 30),
    status: 'confirmed',
    customerName: 'Ravi',
    customerEmail: 'ravi@example.com',
    createdAt: '2099-01-01T00:00:00.000Z',
    ...changes,
  };
}

const monday = '2099-01-05';
const tuesday = '2099-01-06';

function open(
  given: { resource?: Resource; bookings?: Booking[]; slots?: Slot[] } = {},
) {
  const api = fakeApi({
    orgs: [{ id: 'o1', name: 'Northside Clinic', role: 'owner' }],
    resources: [given.resource ?? room],
    services: [consultation],
    windows,
    bookings: given.bookings,
    slots: given.slots,
  });
  render(
    <RouterProvider
      router={createMemoryRouter(routes, {
        initialEntries: ['/orgs/o1/resources/r1?from=2099-01-05'],
      })}
    />,
  );
  return api;
}

const card = (title: string) =>
  within(screen.getByRole('region', { name: title }));

const scheduleElement = () => screen.getByRole('region', { name: 'Schedule' });

// The grid cell around a free slot's button.
const slotCell = (name: string) =>
  card('Schedule').getByRole('button', { name }).closest('li') as HTMLElement; // a slot button always sits in its cell <li>

// A booked block is its own <li>; its text is found through the screen-reader line.
const block = (text: string) =>
  card('Schedule').getByText(text).closest('li') as HTMLElement; // the text sits inside the block's <li>

const variable = (element: HTMLElement, name: string) =>
  element.style.getPropertyValue(name);

const timeLabels = () =>
  [...scheduleElement().querySelectorAll('[data-time-label]')].map(
    (label) => label.textContent,
  );

async function waitForPage() {
  await screen.findByRole('heading', { name: 'Consultation room' });
}

// Opens the Monday 9:00 AM slot, fills the form and presses Book.
async function fillAndBook() {
  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Book 9:00 AM, Monday 5 January',
  });
  await userEvent.type(
    within(dialog).getByLabelText('Customer name'),
    'Ravi Kumar',
  );
  await userEvent.type(
    within(dialog).getByLabelText('Customer email'),
    'ravi@example.com',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Book' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('puts the same start time in the same row on every day', async () => {
  open({
    slots: [
      slotAt(monday, '09:00'),
      slotAt(monday, '09:30'),
      slotAt(tuesday, '09:30'),
    ],
    bookings: [bookingAt(tuesday, '09:00')],
  });
  await waitForPage();

  const mondayRow = variable(
    slotCell('Book 9:30 AM on Monday 5 January'),
    '--row',
  );
  const tuesdayRow = variable(
    slotCell('Book 9:30 AM on Tuesday 6 January'),
    '--row',
  );
  expect(mondayRow).toBe('3');
  expect(tuesdayRow).toBe(mondayRow);
});

it('makes a booking span every row it covers', async () => {
  open({
    slots: [
      slotAt(monday, '09:00', 15),
      slotAt(monday, '09:15', 15),
      slotAt(monday, '09:30', 15),
    ],
    bookings: [bookingAt(tuesday, '09:00')],
  });
  await waitForPage();

  const booked = block('Booked 9:00–9:30 AM, Ravi');
  expect(variable(booked, '--span')).toBe('2');
  expect(variable(booked, '--row')).toBe(
    variable(slotCell('Book 9:00 AM on Monday 5 January'), '--row'),
  );
});

it('gives an off-step start its own row, in order', async () => {
  open({ slots: [slotAt(monday, '09:10'), slotAt(tuesday, '09:00')] });
  await waitForPage();

  expect(timeLabels()).toEqual(['9:00 AM', '9:10 AM']);
});

it('places bookings around midnight in the right day, rows and span', async () => {
  open({
    bookings: [
      bookingAt(monday, '00:00', { id: 'b1', customerName: 'Early' }),
      bookingAt(monday, '23:30', { id: 'b2', customerName: 'Late' }),
    ],
  });
  await waitForPage();

  const early = block('Booked 12:00–12:30 AM, Early');
  const late = block('Booked 11:30 PM–12:00 AM, Late');
  expect(early.dataset.day).toBe(monday);
  expect(late.dataset.day).toBe(monday);
  expect(variable(early, '--span')).toBe('1');
  expect(variable(late, '--span')).toBe('1');
});

it('lets the grid take its full height', async () => {
  open({ slots: [slotAt(monday, '09:00')] });
  await waitForPage();

  const grid = scheduleElement().querySelector('ol');
  expect(grid?.className).not.toContain('overflow-y-auto');
  expect(grid?.className).not.toMatch(/max-h-/);
});

it('shows times in 12-hour form on the labels and the slot', async () => {
  open({ slots: [slotAt(monday, '09:00')] });
  await waitForPage();

  expect(timeLabels()).toEqual(['9:00 AM']);
  const button = card('Schedule').getByRole('button', {
    name: 'Book 9:00 AM on Monday 5 January',
  });
  expect(button.textContent).toBe('9:00 AM');
});

it('says which zone the times are in, with its abbreviation', async () => {
  open();

  expect(
    await screen.findByText('All times are in Asia/Kolkata (IST).'),
  ).toBeTruthy();
});

it('lists bookings with the zone abbreviation of another zone', async () => {
  open({
    resource: { ...room, timeZone: 'America/New_York' },
    bookings: [
      bookingAt(monday, '00:00', {
        startsAt: '2099-01-05T14:00:00.000Z',
        endsAt: '2099-01-05T14:30:00.000Z',
      }),
    ],
  });
  await waitForPage();

  expect(
    await card('Bookings').findByText('Mon 5 Jan, 9:00–9:30 AM GMT-5'),
  ).toBeTruthy();
});

it('puts the cursor in Customer name when the dialog opens', async () => {
  open({ slots: [slotAt(monday, '09:00')] });

  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  );

  const dialog = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText('Customer name'),
    ),
  );
});

it('moves focus to the new booked block after booking', async () => {
  open({ slots: [slotAt(monday, '09:00')] });

  await fillAndBook();

  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain(
      'Booked 9:00–9:30 AM, Ravi Kumar',
    ),
  );
  expect((document.activeElement as HTMLElement).dataset.new).toBe('true'); // activeElement is the block <li>
});

it('returns focus to the slot button when the dialog is closed', async () => {
  open({ slots: [slotAt(monday, '09:00')] });
  const button = await screen.findByRole('button', {
    name: 'Book 9:00 AM on Monday 5 January',
  });

  await userEvent.click(button);
  await userEvent.click(await screen.findByRole('button', { name: 'Close' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(button);
});

it('shows the notices in a tinted box with role status', async () => {
  open({ slots: [slotAt(monday, '09:00')] });

  await fillAndBook();

  const confirmed = await card('Schedule').findByRole('status');
  expect(confirmed.textContent).toBe('Booking confirmed');
  expect(confirmed.className).toContain('bg-accent/10');

  await userEvent.click(
    await screen.findByRole('button', { name: /^Cancel booking for Ravi/ }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Cancel booking?' });
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Cancel booking' }),
  );

  const cancelled = await card('Bookings').findByRole('status');
  expect(cancelled.textContent).toBe('Booking cancelled');
  expect(cancelled.className).toContain('bg-accent/10');
});

it('marks only the new block as new', async () => {
  open({
    slots: [slotAt(monday, '09:00')],
    bookings: [bookingAt(tuesday, '09:00', { customerName: 'Meena' })],
  });

  await fillAndBook();

  const created = await card('Schedule').findByText(
    'Booked 9:00–9:30 AM, Ravi Kumar',
  );
  expect(created.closest('li')?.dataset.new).toBe('true');
  expect(block('Booked 9:00–9:30 AM, Meena').dataset.new).toBeUndefined();
  expect(scheduleElement().querySelectorAll('[data-new="true"]')).toHaveLength(
    1,
  );
});

it('shows a booked block as plain text, and free slots as buttons', async () => {
  open({
    slots: [slotAt(monday, '09:00')],
    bookings: [bookingAt(tuesday, '09:00')],
  });
  await waitForPage();

  const booked = block('Booked 9:00–9:30 AM, Ravi');
  expect(within(booked).queryByRole('button')).toBeNull();
  expect(booked.getAttribute('role')).toBeNull();
  expect(
    card('Schedule').getByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  ).toBeTruthy();
});
