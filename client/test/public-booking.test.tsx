import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Org, type Slot } from './fake-api';
import { fakeTurnstile } from './fake-turnstile';

const business: Org = {
  id: 'o1',
  name: 'Sunrise Physio',
  role: 'owner',
  bookingSlug: 'sunrise-physio',
};
const room = { id: 'r1', name: 'Consultation room', timeZone: 'Asia/Kolkata' };
const doctor = { id: 'r2', name: 'Dr Mehta', timeZone: 'Asia/Kolkata' };
const consultation = { id: 's1', name: 'Consultation', durationMinutes: 30 };

// 9:00 and 9:30 AM on Monday 5 January 2099 in India, and 10:00 AM on the
// Tuesday.
const nine: Slot = {
  startsAt: '2099-01-05T03:30:00Z',
  endsAt: '2099-01-05T04:00:00Z',
};
const nineThirty: Slot = {
  startsAt: '2099-01-05T04:00:00Z',
  endsAt: '2099-01-05T04:30:00Z',
};
const tuesdayTen: Slot = {
  startsAt: '2099-01-06T04:30:00Z',
  endsAt: '2099-01-06T05:00:00Z',
};

function open(
  given: Parameters<typeof fakeApi>[0] = {},
  path = '/book/sunrise-physio',
) {
  const api = fakeApi({
    orgs: [business],
    resources: [room],
    services: [consultation],
    slots: [nine, nineThirty, tuesdayTen],
    ...given,
  });
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );
  return api;
}

// One day's list of times, found by its heading.
const day = (label: string) =>
  within(
    screen
      .getByRole('heading', { level: 3, name: new RegExp(`^${label}`) })
      .closest('li') as HTMLElement, // the heading sits inside its day's <li>
  );

const dialog = () => within(screen.getByRole('dialog'));

async function chooseNine() {
  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Book 9:00 AM on Monday 5 January',
    }),
  );
  await screen.findByRole('dialog');
}

async function fillIn() {
  await userEvent.type(dialog().getByLabelText('Your name'), 'Meera');
  await userEvent.type(
    dialog().getByLabelText('Your email'),
    'meera@example.com',
  );
}

const posts = (api: ReturnType<typeof fakeApi>) =>
  api.callsTo('POST', '/api/public/sunrise-physio/bookings');

// A cancel link's secret: 32 random bytes in base64url, no padding.
const secretPattern = /^[A-Za-z0-9_-]{43}$/;

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

it('shows the business, its service and the free times by day', async () => {
  const api = open();

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Sunrise Physio' }),
  ).toBeTruthy();
  const service = screen.getByLabelText('Service') as HTMLSelectElement;
  expect(service.selectedOptions[0].textContent).toBe('Consultation · 30 min');
  // One resource, so nothing to choose.
  expect(screen.queryByLabelText('With')).toBeNull();
  expect(
    day('Mon 5 Jan').getByRole('button', {
      name: 'Book 9:30 AM on Monday 5 January',
    }),
  ).toBeTruthy();
  expect(
    day('Tue 6 Jan').getByRole('button', {
      name: 'Book 10:00 AM on Tuesday 6 January',
    }),
  ).toBeTruthy();
  expect(day('Wed 7 Jan').getByText('No free times')).toBeTruthy();
  expect(screen.getByText('All times are in Asia/Kolkata (IST).')).toBeTruthy();
  expect(
    api.callsTo(
      'GET',
      '/api/public/sunrise-physio/resources/r1/availability?serviceId=s1&from=2099-01-05&to=2099-01-11',
    ),
  ).toHaveLength(1);
  // A customer is never asked about a session.
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  expect(api.callsTo('GET', '/api/auth/get-session')).toHaveLength(0);
});

it('finds the business from a link typed in capitals', async () => {
  open({}, '/book/Sunrise-Physio');

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Sunrise Physio' }),
  ).toBeTruthy();
});

it('offers "With" when there is more than one resource', async () => {
  const api = open({ resources: [room, doctor] });

  const choice = (await screen.findByLabelText('With')) as HTMLSelectElement;
  expect([...choice.options].map((option) => option.textContent)).toEqual([
    'Consultation room',
    'Dr Mehta',
  ]);
  await userEvent.selectOptions(choice, 'r2');

  await waitFor(() =>
    expect(
      api.calls.some((call) =>
        call.path.startsWith(
          '/api/public/sunrise-physio/resources/r2/availability?',
        ),
      ),
    ).toBe(true),
  );
});

it.each([
  ['an unknown link', { orgs: [{ ...business, bookingSlug: 'other' }] }],
  ['the bot check turned off', { turnstileSiteKey: null }],
  ['no service yet', { services: [] }],
])('says online booking is not available for %s', async (_, given) => {
  const api = open(given);

  expect(
    await screen.findByRole('region', {
      name: "Online booking isn't available",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "This page isn't taking bookings right now. Contact the business to book.",
    ),
  ).toBeTruthy();
  expect(
    api.calls.filter((call) => call.path.includes('/availability')),
  ).toHaveLength(0);
});

it('books a time and shows what was booked', async () => {
  const check = fakeTurnstile();
  const api = open();

  await chooseNine();
  expect(
    screen.getByRole('heading', { name: 'Book 9:00 AM, Monday 5 January' }),
  ).toBeTruthy();
  expect(check.widgets).toHaveLength(1);
  expect(check.widgets[0].options.sitekey).toBe('test-site-key');
  await fillIn();
  check.pass('token-1');
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));

  const card = within(
    await screen.findByRole('region', { name: "You're booked" }),
  );
  expect(posts(api)[0].body).toEqual({
    resourceId: 'r1',
    serviceId: 's1',
    startsAt: '2099-01-05T03:30:00Z',
    customerName: 'Meera',
    customerEmail: 'meera@example.com',
    turnstileToken: 'token-1',
    manageToken: expect.stringMatching(secretPattern),
  });
  expect(card.getByText('Sunrise Physio')).toBeTruthy();
  expect(card.getByText('Consultation')).toBeTruthy();
  expect(card.getByText('Mon 5 Jan, 9:00 AM IST')).toBeTruthy();
  expect(card.getByText('Meera')).toBeTruthy();
  // 9:00 is less than 24 hours away, so there is no cancel link.
  expect(
    card.getByText(
      "This booking starts within 24 hours, so it can't be cancelled online. Contact the business to cancel.",
    ),
  ).toBeTruthy();
  expect(card.queryByLabelText('Your cancel link')).toBeNull();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await userEvent.click(
    card.getByRole('button', { name: 'Book another time' }),
  );
  expect(
    await screen.findByRole('button', {
      name: 'Book 9:30 AM on Monday 5 January',
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Book 9:00 AM on Monday 5 January' }),
  ).toBeNull();
});

it('shows a cancel link for a booking more than 24 hours away', async () => {
  const check = fakeTurnstile();
  const api = open();

  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Book 10:00 AM on Tuesday 6 January',
    }),
  );
  await screen.findByRole('dialog');
  await fillIn();
  check.pass('token-1');
  const user = userEvent.setup();
  await user.click(dialog().getByRole('button', { name: 'Book' }));

  const card = within(
    await screen.findByRole('region', { name: "You're booked" }),
  );
  const secret = (posts(api)[0].body as { manageToken: string }).manageToken;
  expect(secret).toMatch(secretPattern);
  const field = card.getByLabelText('Your cancel link') as HTMLInputElement;
  const link = `${window.location.origin}/manage#${secret}`;
  expect(field.value).toBe(link);
  expect(field.readOnly).toBe(true);
  // 24 hours before 10:00 AM on Tuesday.
  expect(
    card.getByText(
      'Save this link. You can cancel online until Mon 5 Jan, 10:00 AM IST. Anyone with it can cancel this booking.',
    ),
  ).toBeTruthy();
  expect(
    card.getByText('To change a booking, contact the business.'),
  ).toBeTruthy();

  await user.click(card.getByRole('button', { name: 'Copy link' }));
  expect(await navigator.clipboard.readText()).toBe(link);
  expect(await card.findByText('Copied')).toBeTruthy();
});

it('asks for the check before sending anything', async () => {
  const check = fakeTurnstile();
  const api = open();

  await chooseNine();
  await fillIn();
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
  expect((await dialog().findByRole('alert')).textContent).toBe(
    'Please complete the check first',
  );

  // A token that ran out counts as no token.
  check.pass();
  check.expire();
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
  expect(dialog().getByRole('alert').textContent).toBe(
    'Please complete the check first',
  );
  expect(posts(api)).toHaveLength(0);
});

it.each([
  [
    409,
    { error: 'Conflict' },
    'This time is no longer free. If you just booked it, your booking went through.',
  ],
  [
    429,
    { error: 'Daily limit reached' },
    'Online booking is paused for today. Please contact the business.',
  ],
  [
    429,
    { error: 'Too Many Requests' },
    'Too many requests, wait a few minutes',
  ],
  [
    503,
    { error: 'Service Unavailable' },
    "The booking check isn't answering. Try again in a minute.",
  ],
  [
    400,
    {
      error: 'Bad Request',
      details: [
        { path: 'turnstileToken', message: 'Please complete the check again' },
      ],
    },
    'Please complete the check again',
  ],
  [404, { error: 'Not found' }, 'This booking page is no longer available.'],
])(
  'after a %i shows its message and a fresh check',
  async (status, body, message) => {
    const check = fakeTurnstile();
    const api = open();
    api.failNext('POST', '/api/public/sunrise-physio/bookings', status, body);

    await chooseNine();
    await fillIn();
    check.pass('token-1');
    await userEvent.click(dialog().getByRole('button', { name: 'Book' }));

    expect((await dialog().findByRole('alert')).textContent).toBe(message);
    // A token works once, so the old widget goes and a new one is drawn.
    await waitFor(() => expect(check.widgets).toHaveLength(2));
    expect(check.removed).toEqual(['w1']);
    await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
    await waitFor(() =>
      expect(dialog().getByRole('alert').textContent).toBe(
        'Please complete the check first',
      ),
    );
    expect(posts(api)).toHaveLength(1);
  },
);

it('removes the check when the dialog closes', async () => {
  const check = fakeTurnstile();
  open();

  await chooseNine();
  await userEvent.click(dialog().getByRole('button', { name: 'Close' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(check.removed).toEqual(['w1']);
});

it('says so when the check cannot load', async () => {
  // No fake: the page adds Cloudflare's script, which then fails.
  open();

  await chooseNine();
  const script = document.head.querySelector<HTMLScriptElement>(
    'script[src*="challenges.cloudflare.com"]',
  );
  expect(script?.src).toBe(
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  );
  script?.dispatchEvent(new Event('error'));

  expect((await dialog().findByRole('alert')).textContent).toBe(
    'The booking check could not load. Reload the page to try again.',
  );
  script?.remove();
});

it('moves by week inside the 30 days and no further', async () => {
  open();

  await screen.findByRole('heading', { level: 1, name: 'Sunrise Physio' });
  expect(screen.queryByRole('link', { name: 'Previous 7 days' })).toBeNull();
  const next = screen.getByRole('link', { name: 'Next 7 days' });
  expect(next.getAttribute('href')).toBe(
    '/book/sunrise-physio?from=2099-01-12&service=s1&with=r1',
  );
});

it('shows the last week only up to the 30th day', async () => {
  open({}, '/book/sunrise-physio?from=2099-02-02');

  await screen.findByRole('heading', { level: 1, name: 'Sunrise Physio' });
  expect(screen.queryByRole('link', { name: 'Next 7 days' })).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Previous 7 days' }).getAttribute('href'),
  ).toBe('/book/sunrise-physio?from=2099-01-26&service=s1&with=r1');
  expect(
    screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(['Mon 2 Feb', 'Tue 3 Feb', 'Wed 4 Feb']);
});

it('starts today when the week in the link is out of range', async () => {
  open({}, '/book/sunrise-physio?from=2099-03-02');

  expect(
    await screen.findByRole('heading', { level: 3, name: /^Mon 5 Jan/ }),
  ).toBeTruthy();
});

it('keeps a strange link inside the public API', async () => {
  const api = open({}, '/book/..%2Forgs');

  await screen.findByRole('region', { name: "Online booking isn't available" });
  expect(api.calls.map((call) => call.path)).toEqual(['/api/public/..%2Forgs']);
});

// A quoted v4 UUID, as the IETF draft writes the Idempotency-Key header.
const quotedUuid =
  /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/;

it('sends the same key on every try in a dialog, and a new key in a new dialog', async () => {
  const check = fakeTurnstile();
  const api = open();
  const bookingsPath = '/api/public/sunrise-physio/bookings';
  api.failNext('POST', bookingsPath, 503, { error: 'Service Unavailable' });

  await chooseNine();
  await fillIn();
  check.pass('token-1');
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
  await dialog().findByRole('alert');
  await waitFor(() => expect(check.widgets).toHaveLength(2));
  api.failNext('POST', bookingsPath, 503, { error: 'Service Unavailable' });
  check.pass('token-2');
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
  await waitFor(() => expect(posts(api)).toHaveLength(2));
  await userEvent.click(dialog().getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await chooseNine();
  await fillIn();
  check.pass('token-3');
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));
  expect(
    await screen.findByRole('region', { name: "You're booked" }),
  ).toBeTruthy();

  const [key1, key2, key3] = posts(api).map(
    (call) => call.headers?.['Idempotency-Key'],
  );
  expect(key1).toMatch(quotedUuid);
  expect(key2).toBe(key1);
  expect(key3).toMatch(quotedUuid);
  expect(key3).not.toBe(key1);
  // The cancel secret goes with the key, so a retry still shows a working link.
  const [secret1, secret2, secret3] = posts(api).map(
    (call) => (call.body as { manageToken: string }).manageToken,
  );
  expect(secret1).toMatch(secretPattern);
  expect(secret2).toBe(secret1);
  expect(secret3).toMatch(secretPattern);
  expect(secret3).not.toBe(secret1);
});

it('says the booking already went through for a 422', async () => {
  const check = fakeTurnstile();
  const api = open();
  api.failNext('POST', '/api/public/sunrise-physio/bookings', 422, {
    error: 'Idempotency key reused',
  });

  await chooseNine();
  await fillIn();
  check.pass('token-1');
  await userEvent.click(dialog().getByRole('button', { name: 'Book' }));

  expect((await dialog().findByRole('alert')).textContent).toBe(
    'Your booking already went through with the details you first entered. If something is wrong, contact the business.',
  );
});
