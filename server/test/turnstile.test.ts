// The bot check's call to Cloudflare, with a fake fetch: what it sends, and
// how each answer maps to ok, rejected or unavailable. Fails closed: anything
// that isn't a clear pass or a clear "bad token" is unavailable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../src/turnstile.js';

// Cloudflare's published test secret that always passes. Not a real secret.
const SECRET = '1x0000000000000000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const fakeFetch = (answer: (init: RequestInit) => Promise<Response>) => {
  const fake = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    answer(init ?? {}),
  );
  vi.stubGlobal('fetch', fake);
  return fake;
};

const answers = (body: unknown, status = 200) =>
  fakeFetch(async () => Response.json(body, { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyTurnstile', () => {
  it('posts the secret and the token, form-encoded, with a time limit', async () => {
    const fake = answers({ success: true });

    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('ok');

    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const sent = init?.body as URLSearchParams;
    expect(Object.fromEntries(sent)).toEqual({
      secret: SECRET,
      response: TOKEN,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['invalid-input-response'],
    ['timeout-or-duplicate'],
    ['missing-input-response'],
  ])('is rejected when the token is bad (%s)', async (code) => {
    answers({ success: false, 'error-codes': [code] });
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('rejected');
  });

  it.each([
    ['Cloudflare has an internal error', { 'error-codes': ['internal-error'] }],
    ['our secret is wrong', { 'error-codes': ['invalid-input-secret'] }],
    ['our request is malformed', { 'error-codes': ['bad-request'] }],
    ['no reason is given', {}],
    [
      'a bad token comes with another problem',
      { 'error-codes': ['invalid-input-response', 'internal-error'] },
    ],
  ])('is unavailable when %s', async (_label, extra) => {
    answers({ success: false, ...extra });
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');
  });

  it('is unavailable on an HTTP error, even with a success body', async () => {
    answers({ success: true }, 500);
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');
  });

  it('is unavailable when the answer is not the expected JSON', async () => {
    fakeFetch(async () => new Response('<html>oops</html>'));
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');

    answers({ success: 'true' });
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');
  });

  it('is unavailable when the network fails', async () => {
    fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');
  });

  // Real time, not fake timers: this proves the 5-second limit on Node
  // itself. The fake never answers; it only gives up when told to.
  it('gives up after 5 seconds and is unavailable', async () => {
    fakeFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const started = Date.now();
    expect(await verifyTurnstile(SECRET, TOKEN)).toBe('unavailable');
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(7000);
  });
});
