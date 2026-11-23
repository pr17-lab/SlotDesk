import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';

const asha = { name: 'Asha', email: 'asha@example.com' };

type Options = {
  signedInAs?: typeof asha;
  signInStatus?: number;
  signUpStatus?: number;
};

// Answers by path and method, like the real server. A good sign-in or
// sign-up starts a session, and sign-out ends it.
function fakeServer(options: Options = {}) {
  let user = options.signedInAs ?? null;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/api/auth/get-session' && method === 'GET') {
      return reply(200, user && { session: {}, user });
    }
    if (path === '/api/orgs' && method === 'GET') return reply(200, []);
    if (path === '/api/auth/sign-in/email' && method === 'POST') {
      const status = options.signInStatus ?? 200;
      if (status === 401) {
        return reply(401, {
          message: 'Invalid email or password',
          code: 'INVALID_EMAIL_OR_PASSWORD',
        });
      }
      if (status !== 200) return reply(status, {});
      user = asha;
      return reply(200, { user: asha });
    }
    if (path === '/api/auth/sign-up/email' && method === 'POST') {
      const status = options.signUpStatus ?? 200;
      if (status === 422) {
        return reply(422, {
          message: 'User already exists. Use another email.',
          code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
        });
      }
      user = asha;
      return reply(200, { user: asha });
    }
    if (path === '/api/auth/sign-out' && method === 'POST') {
      user = null;
      return reply(200, { success: true });
    }
    return reply(404, {});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function open(path: string) {
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );
}

// The calls made to one path, as { method, body }.
function callsTo(fetch: ReturnType<typeof fakeServer>, path: string) {
  return fetch.mock.calls
    .filter(([calledPath]) => calledPath === path)
    .map(([, init]) => ({
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['/sign-in', '/sign-up'])(
  'sends a signed-in visitor from %s to the home page',
  async (path) => {
    fakeServer({ signedInAs: asha });
    open(path);

    expect(
      await screen.findByText('Signed in as asha@example.com.'),
    ).toBeTruthy();
  },
);

it('signs in and shows the home page with the email in the header', async () => {
  const fetch = fakeServer();
  open('/sign-in');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText('Password'), 'a long password 123');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(
    await screen.findByText('Signed in as asha@example.com.'),
  ).toBeTruthy();
  // The header shows the email on its own, apart from the sentence.
  expect(screen.getByText('asha@example.com')).toBeTruthy();
  expect(callsTo(fetch, '/api/auth/sign-in/email')).toEqual([
    {
      method: 'POST',
      body: { email: 'asha@example.com', password: 'a long password 123' },
    },
  ]);
});

it('shows a wrong password once and keeps the email', async () => {
  fakeServer({ signInStatus: 401 });
  open('/sign-in');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText('Password'), 'not the password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Wrong email or password');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(
    'asha@example.com',
  );
});

it('shows the api message when sign-in is rate limited', async () => {
  fakeServer({ signInStatus: 429 });
  open('/sign-in');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText('Password'), 'whatever it is');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Too many requests, wait a few minutes',
  );
});

it('links between the sign-in and sign-up pages', async () => {
  fakeServer();
  open('/sign-in');
  const user = userEvent.setup();

  await user.click(
    await screen.findByRole('link', { name: 'Create an account' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Create an account' }),
  ).toBeTruthy();

  await user.click(screen.getByRole('link', { name: 'Sign in instead' }));
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
});

it('signs up with a trimmed name and shows the home page', async () => {
  const fetch = fakeServer();
  open('/sign-up');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Name'), '  Asha  ');
  await user.type(screen.getByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'a long password 123');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(
    await screen.findByText('Signed in as asha@example.com.'),
  ).toBeTruthy();
  expect(callsTo(fetch, '/api/auth/sign-up/email')).toEqual([
    {
      method: 'POST',
      body: {
        name: 'Asha',
        email: 'asha@example.com',
        password: 'a long password 123',
      },
    },
  ]);
});

it('shows that the email is taken and keeps name and email', async () => {
  fakeServer({ signUpStatus: 422 });
  open('/sign-up');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Name'), 'Asha');
  await user.type(screen.getByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'a long password 123');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'An account with this email already exists',
  );
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
    'Asha',
  );
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(
    'asha@example.com',
  );
});

it('refuses a name of only spaces without calling the server', async () => {
  const fetch = fakeServer();
  open('/sign-up');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Name'), '   ');
  await user.type(screen.getByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'a long password 123');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Enter your name',
  );
  expect(callsTo(fetch, '/api/auth/sign-up/email')).toEqual([]);
});

it('signs out and shows the sign-in page', async () => {
  const fetch = fakeServer({ signedInAs: asha });
  open('/');
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Sign out' }));

  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(callsTo(fetch, '/api/auth/sign-out')).toEqual([
    { method: 'POST', body: undefined },
  ]);
});

it('finds the sign-up fields by label with the right input rules', async () => {
  fakeServer();
  open('/sign-up');

  const password = (await screen.findByLabelText(
    /^Password/,
  )) as HTMLInputElement;
  expect(password.minLength).toBe(15);
  expect(password.getAttribute('autocomplete')).toBe('new-password');
  expect(password.required).toBe(true);
  expect(screen.getByLabelText('Name')).toBeTruthy();
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(screen.getByText('At least 15 characters')).toBeTruthy();
});

it('shows a sign-in link on a 401 error page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 401 })),
  );
  open('/');

  expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
});
