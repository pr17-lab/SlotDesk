import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';

function serve(status: number, body: unknown) {
  const fetch = vi
    .fn()
    // A new Response each call: the root and page loaders both read one.
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
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
