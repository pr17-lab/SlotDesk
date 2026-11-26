import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';

function answer(status: number, body?: unknown) {
  const text = body === undefined ? null : JSON.stringify(body);
  return vi.fn().mockResolvedValue(new Response(text, { status }));
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('calls the path under /api and returns the parsed body', async () => {
    const fetch = answer(200, { status: 'ok' });
    vi.stubGlobal('fetch', fetch);

    expect(await api('/health')).toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledWith('/api/health', {
      method: undefined,
      headers: undefined,
      body: undefined,
    });
  });

  it('sends a body as JSON', async () => {
    const fetch = answer(201, { id: '1' });
    vi.stubGlobal('fetch', fetch);

    await api('/orgs', { method: 'POST', body: { name: 'Clinic' } });
    expect(fetch).toHaveBeenCalledWith('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"Clinic"}',
    });
  });

  it('sends extra headers alongside the JSON content type', async () => {
    const fetch = answer(201, { id: '1' });
    vi.stubGlobal('fetch', fetch);

    await api('/orgs/1/bookings', {
      method: 'POST',
      body: { name: 'Clinic' },
      headers: { 'Idempotency-Key': '"abc"' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/orgs/1/bookings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '"abc"',
      },
      body: '{"name":"Clinic"}',
    });
  });

  it('returns null for a null body, as get-session sends when signed out', async () => {
    vi.stubGlobal('fetch', answer(200, null));
    expect(await api('/auth/get-session')).toBeNull();
  });

  it('returns null for an empty 204', async () => {
    vi.stubGlobal('fetch', answer(204));
    expect(await api('/orgs/1/members/2', { method: 'DELETE' })).toBeNull();
  });

  it("uses the server's message for a 400 that names a field", async () => {
    vi.stubGlobal(
      'fetch',
      answer(400, {
        error: 'Bad Request',
        details: [
          { path: 'startsAt', message: 'This start time is not offered' },
        ],
      }),
    );

    const error = await failure(api('/orgs/1/bookings', { method: 'POST' }));
    expect(error.status).toBe(400);
    expect(error.message).toBe('This start time is not offered');
  });

  it.each([
    [400, { error: 'Bad Request' }, 'Please check the form and try again'],
    [401, { error: 'Unauthorized' }, 'Please sign in'],
    [404, { error: 'Not found' }, 'Not found'],
    [409, { error: 'Conflict' }, 'This conflicts with something that exists'],
    [
      429,
      { error: 'Too Many Requests' },
      'Too many requests, wait a few minutes',
    ],
    [503, { error: 'Service Unavailable' }, 'Busy, try again'],
    [502, undefined, 'Cannot reach the server, try again'],
    [500, { error: 'Internal Server Error' }, 'Something went wrong'],
  ])('a %i gets a clear message', async (status, body, message) => {
    vi.stubGlobal('fetch', answer(status, body));

    const error = await failure(api('/orgs'));
    expect(error.status).toBe(status);
    expect(error.message).toBe(message);
  });

  it("keeps the server's error name, so two 429s can be told apart", async () => {
    vi.stubGlobal('fetch', answer(429, { error: 'Daily limit reached' }));

    const error = await failure(api('/public/x/bookings', { method: 'POST' }));
    expect(error.message).toBe('Too many requests, wait a few minutes');
    expect(error.serverError).toBe('Daily limit reached');
  });

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));

    const error = await failure(api('/health'));
    expect(error.status).toBe(0);
    expect(error.message).toBe('Cannot reach the server, try again');
  });
});
