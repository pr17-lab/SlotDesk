import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';

function serve(status: number, body: unknown) {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('asks the server for the session and shows signed out', async () => {
  const fetch = serve(200, null);
  render(<RouterProvider router={createMemoryRouter(routes)} />);

  expect(await screen.findByText('You are signed out.')).toBeTruthy();
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
