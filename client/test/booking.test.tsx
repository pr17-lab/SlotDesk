import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Booking, type Org, type Slot } from './fake-api';

const owner: Org = { id: 'o1', name: 'Northside Clinic', role: 'owner' };
const staff: Org = { ...owner, role: 'staff' };
const room = { id: 'r1', name: 'Consultation room', timeZone: 'Asia/Kolkata' };
const consultation = { id: 's1', name: 'Consultation', durationMinutes: 30 };
const longVisit = { id: 's2', name: 'Long visit', durationMinutes: 60 };
const windows = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

// 09:00 on Monday 5 January 2099 in India.
const nineOClock: Slot = {
  startsAt: '2099-01-05T03:30:00Z',
  endsAt: '2099-01-05T04:00:00Z',
};

function booking(changes: Partial<Booking> = {}): Booking {
  return {
    id: 'b1',
    resourceId: 'r1',
    serviceId: 's1',
    startsAt: '2099-01-05T03:30:00.000Z',
    endsAt: '2099-01-05T04:00:00.000Z',
    status: 'confirmed',
    customerName: 'Ravi',
    customerEmail: 'ravi@example.com',
    createdAt: '2099-01-01T00:00:00.000Z',
    ...changes,
  };
}

function open(
  given: {
    org?: Org;
    services?: (typeof consultation)[];
    bookings?: Booking[];
    slots?: Slot[];
  } = {},
  query = '?from=2099-01-05',
) {
  const api = fakeApi({
    orgs: [given.org ?? owner],
    resources: [room],
    services: given.services ?? [consultation, longVisit],
    windows,
    bookings: given.bookings,
    slots: given.slots,
  });
  render(
    <RouterProvider
      router={createMemoryRouter(routes, {
        initialEntries: [`/orgs/o1/resources/r1${query}`],
      })}
    />,
  );
  return api;
}

const card = (title: string) =>
  within(screen.getByRole('region', { name: title }));

// One day's column in the grid, found by its header.
const column = (header: string) =>
  within(
    screen
      .getByRole('heading', { level: 3, name: new RegExp(`^${header}`) })
      .closest('li') as HTMLElement, // the header sits inside its day's <li>
  );

const paths = (api: ReturnType<typeof fakeApi>) =>
  api.calls.map((call) => call.path);

// Pins "today" without stopping timers, so userEvent still works.
function pinClock(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bookingsPath = '/api/orgs/o1/bookings';
const availabilityPath = '/api/orgs/o1/resources/r1/availability';

it('uses the resource-zone date for today when there is no from', async () => {
  pinClock('2099-01-04T19:00:00Z');
  const api = open({}, '');

  await screen.findByRole('heading', { name: 'Consultation room' });
  expect(paths(api)).toContain(
    `${bookingsPath}?resourceId=r1&from=2099-01-05&to=2099-01-11`,
  );
  expect(paths(api)).toContain(
    `${availabilityPath}?serviceId=s1&from=2099-01-05&to=2099-01-11`,
  );
});

it('reads the service from the URL and shows it in the select', async () => {
  const api = open({}, '?from=2099-01-05&service=s2');

  await screen.findByRole('heading', { name: 'Consultation room' });
  expect(paths(api)).toContain(
    `${availabilityPath}?serviceId=s2&from=2099-01-05&to=2099-01-11`,
  );
  const select = screen.getByLabelText('Service') as HTMLSelectElement;
  expect(select.selectedOptions[0].textContent).toContain('Long visit');
});

it('falls back to today when from is not a date', async () => {
  pinClock('2099-01-04T19:00:00Z');
  const api = open({}, '?from=junk');

  await screen.findByRole('heading', { name: 'Consultation room' });
  expect(paths(api)).toContain(
    `${bookingsPath}?resourceId=r1&from=2099-01-05&to=2099-01-11`,
  );
});

it('shows seven day columns and a free slot as a button', async () => {
  open({ slots: [nineOClock] });

  await screen.findByRole('heading', { name: 'Consultation room' });
  const headers = card('Schedule')
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.firstChild?.textContent);
  expect(headers).toEqual([
    'Mon 5 Jan',
    'Tue 6 Jan',
    'Wed 7 Jan',
    'Thu 8 Jan',
    'Fri 9 Jan',
    'Sat 10 Jan',
    'Sun 11 Jan',
  ]);
  expect(
    column('Mon 5 Jan').getByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  ).toBeTruthy();
});

it('shows a confirmed booking as a block and leaves cancelled ones out', async () => {
  open({
    bookings: [
      booking(),
      booking({
        id: 'b2',
        status: 'cancelled',
        customerName: 'Meena',
        startsAt: '2099-01-05T05:30:00.000Z',
        endsAt: '2099-01-05T06:00:00.000Z',
      }),
    ],
  });

  await screen.findByRole('heading', { name: 'Consultation room' });
  const grid = card('Schedule');
  expect(grid.getByText('Booked 9:00–9:30 AM, Ravi')).toBeTruthy();
  expect(grid.queryByRole('button', { name: /Booked/ })).toBeNull();
  expect(grid.queryByText(/Meena/)).toBeNull();
});

it('puts bookings around midnight in the resource-zone day', async () => {
  open({
    bookings: [
      booking({
        id: 'b1',
        customerName: 'Early',
        startsAt: '2099-01-04T18:30:00.000Z',
        endsAt: '2099-01-04T19:00:00.000Z',
      }),
      booking({
        id: 'b2',
        customerName: 'Late',
        startsAt: '2099-01-05T18:00:00.000Z',
        endsAt: '2099-01-05T18:30:00.000Z',
      }),
    ],
  });

  await screen.findByRole('heading', { name: 'Consultation room' });
  const monday = column('Mon 5 Jan');
  expect(monday.getByText('Booked 12:00–12:30 AM, Early')).toBeTruthy();
  expect(monday.getByText('Booked 11:30 PM–12:00 AM, Late')).toBeTruthy();
});

it('moves the range by seven days and keeps the service', async () => {
  const api = open({}, '?from=2099-01-05&service=s2');

  await userEvent.click(
    await screen.findByRole('link', { name: 'Next 7 days' }),
  );
  await waitFor(() =>
    expect(paths(api)).toContain(
      `${bookingsPath}?resourceId=r1&from=2099-01-12&to=2099-01-18`,
    ),
  );
  expect(paths(api)).toContain(
    `${availabilityPath}?serviceId=s2&from=2099-01-12&to=2099-01-18`,
  );

  // Back to 5 January, then one more week back.
  await userEvent.click(screen.getByRole('link', { name: 'Previous 7 days' }));
  await waitFor(() =>
    expect(screen.getByText('Mon 5 Jan to Sun 11 Jan')).toBeTruthy(),
  );
  await userEvent.click(screen.getByRole('link', { name: 'Previous 7 days' }));
  await waitFor(() =>
    expect(paths(api)).toContain(
      `${bookingsPath}?resourceId=r1&from=2098-12-29&to=2099-01-04`,
    ),
  );
});

it('asks for a service first when there are none', async () => {
  const api = open({ services: [] });

  expect(
    await screen.findByText(
      'Add a service on the organization page to start booking.',
    ),
  ).toBeTruthy();
  const link = card('Schedule').getByRole('link');
  expect(link.getAttribute('href')).toBe('/orgs/o1');
  expect(paths(api).some((path) => path.includes('/availability'))).toBe(false);
});

// Opens the 09:00 slot, fills the form and presses Book.
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
  return dialog;
}

it('books the slot with the exact startsAt and shows the block', async () => {
  const api = open({ slots: [nineOClock] });

  await fillAndBook();

  expect(await screen.findByText('Booking confirmed')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Booking confirmed');
  const posts = api.callsTo('POST', bookingsPath);
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({
    resourceId: 'r1',
    serviceId: 's1',
    startsAt: '2099-01-05T03:30:00Z',
    customerName: 'Ravi Kumar',
    customerEmail: 'ravi@example.com',
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    await card('Schedule').findByText('Booked 9:00–9:30 AM, Ravi Kumar'),
  ).toBeTruthy();
});

it('disables the button and says Booking… while the request runs', async () => {
  const api = open({ slots: [nineOClock] });
  const release = api.hold('POST', bookingsPath);

  const dialog = await fillAndBook();

  const button = await within(dialog).findByRole('button', {
    name: 'Booking…',
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  release();
  expect(await screen.findByText('Booking confirmed')).toBeTruthy();
});

it('keeps the dialog open on a 409 and reloads the grid', async () => {
  const api = open({ slots: [nineOClock] });
  api.failNext('POST', bookingsPath, 409, { error: 'Conflict' });

  const dialog = await fillAndBook();

  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'This slot was just taken. Pick another time.',
  );
  await waitFor(() =>
    expect(
      paths(api).filter((path) => path.startsWith(availabilityPath)),
    ).toHaveLength(2),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('shows the field message of a 400 in the dialog', async () => {
  const api = open({ slots: [nineOClock] });
  api.failNext('POST', bookingsPath, 400, {
    error: 'Bad Request',
    details: [{ path: 'startsAt', message: 'This start time is not offered' }],
  });

  const dialog = await fillAndBook();

  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'This start time is not offered',
  );
});

it('shows Busy, try again for a 503', async () => {
  const api = open({ slots: [nineOClock] });
  api.failNext('POST', bookingsPath, 503, { error: 'Service Unavailable' });

  const dialog = await fillAndBook();

  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'Busy, try again',
  );
});

it('lists confirmed and cancelled bookings, with Cancel on confirmed only', async () => {
  open({
    bookings: [
      booking(),
      booking({
        id: 'b2',
        serviceId: 's2',
        status: 'cancelled',
        customerName: 'Meena',
        customerEmail: 'meena@example.com',
        startsAt: '2099-01-05T05:30:00.000Z',
        endsAt: '2099-01-05T06:30:00.000Z',
      }),
    ],
  });

  await screen.findByRole('heading', { name: 'Consultation room' });
  const [first, second] = card('Bookings').getAllByRole('listitem');
  expect(within(first).getByText('Mon 5 Jan, 9:00–9:30 AM IST')).toBeTruthy();
  expect(within(first).getByText('Ravi')).toBeTruthy();
  expect(within(first).getByText('ravi@example.com')).toBeTruthy();
  expect(within(first).getByText('Consultation')).toBeTruthy();
  expect(within(first).getByText('Confirmed')).toBeTruthy();
  expect(
    within(first).getByRole('button', {
      name: 'Cancel booking for Ravi at 9:00 AM on Monday 5 January',
    }),
  ).toBeTruthy();
  expect(
    within(second).getByText('Mon 5 Jan, 11:00 AM–12:00 PM IST'),
  ).toBeTruthy();
  expect(within(second).getByText('Meena')).toBeTruthy();
  expect(within(second).getByText('Long visit')).toBeTruthy();
  expect(within(second).getByText('Cancelled')).toBeTruthy();
  expect(within(second).queryByRole('button')).toBeNull();
});

// Presses Cancel on Ravi's row and returns the confirm dialog.
async function askToCancel() {
  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Cancel booking for Ravi at 9:00 AM on Monday 5 January',
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Cancel booking?',
  });
  expect(
    within(dialog).getByText(
      'Ravi, 9:00–9:30 AM IST on Monday 5 January. The time becomes free again.',
    ),
  ).toBeTruthy();
  return dialog;
}

it('closes the cancel dialog on Keep booking and sends nothing', async () => {
  const api = open({ bookings: [booking()] });

  const dialog = await askToCancel();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Keep booking' }),
  );

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.callsTo('POST', `${bookingsPath}/b1/cancel`)).toHaveLength(0);
});

it('cancels the booking and marks the row Cancelled', async () => {
  const api = open({ bookings: [booking()] });

  const dialog = await askToCancel();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Cancel booking' }),
  );

  expect(await screen.findByText('Booking cancelled')).toBeTruthy();
  expect(api.callsTo('POST', `${bookingsPath}/b1/cancel`)).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const [row] = card('Bookings').getAllByRole('listitem');
  expect(await within(row).findByText('Cancelled')).toBeTruthy();
});

it('says when there are no bookings', async () => {
  open();

  expect(await screen.findByText('No bookings in these 7 days.')).toBeTruthy();
});

it('lets staff book and cancel', async () => {
  open({ org: staff, slots: [nineOClock], bookings: [booking({ id: 'b9' })] });

  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  );
  expect(
    await screen.findByRole('dialog', {
      name: 'Book 9:00 AM, Monday 5 January',
    }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(
    await screen.findByRole('button', { name: /^Cancel booking for Ravi/ }),
  ).toBeTruthy();
});
