import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newSecret } from '../src/cancel-link';
import { routes } from '../src/routes';
import { fakeApi, type Managed } from './fake-api';

const SECRET = 's'.repeat(43);

// 10:00 AM on Tuesday 6 January 2099 in India; online cancelling closes at
// 10:00 AM on the Monday.
const tuesday: Managed = {
  token: SECRET,
  businessName: 'Sunrise Physio',
  serviceName: 'Consultation',
  resourceName: 'Dr Mehta',
  startsAt: '2099-01-06T04:30:00.000Z',
  endsAt: '2099-01-06T05:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  status: 'confirmed',
  cancelBefore: '2099-01-05T04:30:00.000Z',
};

function open(
  managed: Managed[] = [{ ...tuesday }],
  path = `/manage#${SECRET}`,
) {
  const api = fakeApi({ managed });
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );
  return api;
}

const card = async () =>
  within(await screen.findByRole('region', { name: 'Your booking' }));
const dialog = () => within(screen.getByRole('dialog'));

const CLOSED =
  'Online cancelling closed 24 hours before your booking. To cancel, contact the business.';

// 7:30 AM on Monday 5 January 2099 in India.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2099-01-05T02:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the booking, sending the secret in the body only', async () => {
  const api = open();

  const booking = await card();
  expect(
    screen.getByRole('heading', { level: 1, name: 'Sunrise Physio' }),
  ).toBeTruthy();
  expect(booking.getByText('Consultation')).toBeTruthy();
  expect(booking.getByText('Dr Mehta')).toBeTruthy();
  expect(booking.getByText('Tue 6 Jan, 10:00 AM IST')).toBeTruthy();
  expect(
    booking.getByText('You can cancel online until Mon 5 Jan, 10:00 AM IST.'),
  ).toBeTruthy();
  expect(booking.getByRole('button', { name: 'Cancel booking' })).toBeTruthy();
  expect(api.calls.map((call) => [call.method, call.path])).toEqual([
    ['POST', '/api/manage/lookup'],
  ]);
  expect(api.calls[0]!.body).toEqual({ token: SECRET });
  // A customer is never asked about a session.
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
});

it('cancels after the customer confirms', async () => {
  const api = open();

  await userEvent.click(
    (await card()).getByRole('button', { name: 'Cancel booking' }),
  );
  expect(
    screen.getByRole('heading', { name: 'Cancel this booking?' }),
  ).toBeTruthy();
  await userEvent.click(
    dialog().getByRole('button', { name: 'Cancel booking' }),
  );

  const booking = await card();
  expect((await booking.findByRole('status')).textContent).toBe(
    'Booking cancelled. The time is free again.',
  );
  expect(booking.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.callsTo('POST', '/api/manage/cancel')[0]!.body).toEqual({
    token: SECRET,
  });
});

it('sends nothing when the customer keeps the booking', async () => {
  const api = open();

  await userEvent.click(
    (await card()).getByRole('button', { name: 'Cancel booking' }),
  );
  await userEvent.click(dialog().getByRole('button', { name: 'Keep booking' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.callsTo('POST', '/api/manage/cancel')).toHaveLength(0);
  expect(
    (await card()).getByRole('button', { name: 'Cancel booking' }),
  ).toBeTruthy();
});

it('says a cancelled booking is cancelled, with no button', async () => {
  open([{ ...tuesday, status: 'cancelled' }]);

  const booking = await card();
  expect(booking.getByText('This booking is cancelled.')).toBeTruthy();
  expect(booking.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
});

it('offers no button inside the last 24 hours', async () => {
  vi.setSystemTime(new Date('2099-01-05T05:00:00Z'));
  open();

  const booking = await card();
  expect(booking.getByText(CLOSED)).toBeTruthy();
  expect(booking.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
});

it('shows the closed message when the server says it is too late', async () => {
  const api = open();
  api.failNext('POST', '/api/manage/cancel', 409, {
    error: 'Too late to cancel online',
  });

  await userEvent.click(
    (await card()).getByRole('button', { name: 'Cancel booking' }),
  );
  await userEvent.click(
    dialog().getByRole('button', { name: 'Cancel booking' }),
  );

  const booking = await card();
  expect(await booking.findByText(CLOSED)).toBeTruthy();
  expect(booking.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('shows a message in the dialog when cancelling fails for another reason', async () => {
  const api = open();
  api.failNext('POST', '/api/manage/cancel', 503, {
    error: 'Service Unavailable',
  });

  await userEvent.click(
    (await card()).getByRole('button', { name: 'Cancel booking' }),
  );
  await userEvent.click(
    dialog().getByRole('button', { name: 'Cancel booking' }),
  );

  expect((await dialog().findByRole('alert')).textContent).toBe(
    'Busy, try again',
  );
});

it.each([
  ['an unknown secret', `/manage#${'u'.repeat(43)}`],
  ['no secret', '/manage'],
])('says the link does not work for %s', async (_label, path) => {
  const api = open([{ ...tuesday }], path);

  const broken = within(
    await screen.findByRole('region', { name: "This link doesn't work" }),
  );
  expect(
    broken.getByText('To change or cancel a booking, contact the business.'),
  ).toBeTruthy();
  if (path === '/manage') expect(api.calls).toHaveLength(0);
});

it('makes secrets in the format the server checks', () => {
  const secrets = Array.from({ length: 200 }, newSecret);
  for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(new Set(secrets).size).toBe(200);
});
