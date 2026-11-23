import { render, screen } from '@testing-library/react';
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
