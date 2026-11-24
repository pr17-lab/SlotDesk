import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi } from './fake-api';

function serve(status: number, body: unknown) {
  const fetch = vi
    .fn()
    // A new Response each call: the root and page loaders both read one.
    .mockImplementation(async (path: string) =>
      path === '/api/orgs'
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify(body), { status }),
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('sends a signed-out visitor to the sign-in page', async () => {
  const fetch = serve(200, null);
  render(<RouterProvider router={createMemoryRouter(routes)} />);

  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(
    '/api/auth/get-session',
    expect.anything(),
  );
});

it('shows who is signed in', async () => {
  serve(200, { user: { email: 'asha@example.com' }, session: {} });
  render(<RouterProvider router={createMemoryRouter(routes)} />);

  expect(
    await screen.findByText('Signed in as asha@example.com.'),
  ).toBeTruthy();
});

it('shows a clear message when the session check fails', async () => {
  serve(503, { error: 'Service Unavailable' });
  render(<RouterProvider router={createMemoryRouter(routes)} />);

  expect(await screen.findByText('Busy, try again')).toBeTruthy();
});

it('answers an unknown page with page not found', async () => {
  serve(200, null);
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: ['/nope'] })}
    />,
  );

  expect(await screen.findByText('Page not found.')).toBeTruthy();
});

function openHome() {
  render(<RouterProvider router={createMemoryRouter(routes)} />);
}

it('lists organizations as links with role badges', async () => {
  fakeApi({
    orgs: [
      { id: 'o1', name: 'Northside Clinic', role: 'owner' },
      { id: 'o2', name: 'Harbour Studio', role: 'staff' },
    ],
  });
  openHome();

  const clinic = await screen.findByRole('link', { name: 'Northside Clinic' });
  expect(clinic.getAttribute('href')).toBe('/orgs/o1');
  const studio = screen.getByRole('link', { name: 'Harbour Studio' });
  expect(studio.getAttribute('href')).toBe('/orgs/o2');
  expect(screen.getByText('Owner')).toBeTruthy();
  expect(screen.getByText('Staff')).toBeTruthy();
});

it('welcomes a user with no organizations and shows the form', async () => {
  fakeApi();
  openHome();

  expect(
    await screen.findByText(
      'Welcome. Create your first organization to begin.',
    ),
  ).toBeTruthy();
  expect(screen.getByLabelText('Name')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Create organization' }),
  ).toBeTruthy();
});

it('creates an organization and opens its page', async () => {
  const api = fakeApi();
  openHome();

  await userEvent.type(await screen.findByLabelText('Name'), 'Dental Care');
  await userEvent.click(
    screen.getByRole('button', { name: 'Create organization' }),
  );

  expect(
    await screen.findByRole('heading', { name: 'Dental Care' }),
  ).toBeTruthy();
  expect(api.callsTo('POST', '/api/orgs')[0].body).toEqual({
    name: 'Dental Care',
  });
});

function openAt(path: string) {
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );
}

it('shows a loading bar while the next page loads, and only then', async () => {
  const api = fakeApi({
    orgs: [{ id: 'o1', name: 'Northside Clinic', role: 'owner' }],
  });
  const release = api.hold('GET', '/api/orgs/o1');
  openHome();

  await userEvent.click(
    await screen.findByRole('link', { name: 'Northside Clinic' }),
  );

  expect(
    await screen.findByRole('progressbar', { name: 'Loading page' }),
  ).toBeTruthy();
  release();
  expect(
    await screen.findByRole('heading', { name: 'Northside Clinic' }),
  ).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('shows no loading bar on a page that is idle', async () => {
  fakeApi();
  openHome();

  await screen.findByText('Welcome. Create your first organization to begin.');
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('explains the slow first load while the session is checked', async () => {
  const api = fakeApi();
  const release = api.hold('GET', '/api/auth/get-session');
  openHome();

  expect(await screen.findByText('Starting SlotDesk')).toBeTruthy();
  expect(
    screen.getByText(
      'The server may take up to 30 seconds to wake up on the first visit.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('status')).toBeTruthy();
  release();
  expect(
    await screen.findByText(
      'Welcome. Create your first organization to begin.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Starting SlotDesk')).toBeNull();
});

it('shows a failed page as a card with a way out, and reloads on request', async () => {
  const api = fakeApi();
  api.failNext('GET', '/api/orgs', 500, { error: 'Boom' });
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  openHome();

  const card = await screen.findByRole('region', { name: "That didn't work" });
  expect(card.textContent).toContain('Something went wrong');
  expect(
    screen
      .getByRole('link', { name: 'Go to the home page' })
      .getAttribute('href'),
  ).toBe('/');
  expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('still offers sign in when the failure is a 401', async () => {
  const api = fakeApi();
  api.failNext('GET', '/api/orgs', 401, { error: 'Unauthorized' });
  openHome();

  const link = await screen.findByRole('link', { name: 'Sign in' });
  expect(link.getAttribute('href')).toBe('/sign-in');
  expect(screen.getByRole('region', { name: "That didn't work" })).toBeTruthy();
});

it('shows page not found as a card with the home link', async () => {
  fakeApi();
  openAt('/nope');

  expect(
    await screen.findByRole('region', { name: 'Page not found' }),
  ).toBeTruthy();
  expect(screen.getByText('Page not found.')).toBeTruthy();
  expect(
    screen
      .getByRole('link', { name: 'Go to the home page' })
      .getAttribute('href'),
  ).toBe('/');
});

it('makes Sign out a text control, not a solid button', async () => {
  fakeApi();
  openHome();

  const button = await screen.findByRole('button', { name: 'Sign out' });
  expect(button.className).not.toContain('bg-primary');
});
