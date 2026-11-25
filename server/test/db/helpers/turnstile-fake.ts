// Stands in for Cloudflare's siteverify in database tests, so no test calls
// the real service. Any other fetch goes through unchanged.
import { vi } from 'vitest';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// What the test widget hands the page (Cloudflare's docs, "Testing").
export const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

type Answer = (body: URLSearchParams) => Promise<Response>;

export function fakeSiteverify(answer: Answer) {
  const realFetch = globalThis.fetch;
  const fake = vi.fn(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      String(input) === SITEVERIFY_URL
        ? answer(init?.body as URLSearchParams)
        : realFetch(input, init),
  );
  vi.stubGlobal('fetch', fake);
  return fake;
}

// Every check passes, as with Cloudflare's always-pass test secret.
export const siteverifyPasses = () =>
  fakeSiteverify(async () => Response.json({ success: true }));

// How many times the fake was asked to verify a token.
export const verifyCalls = (fake: ReturnType<typeof fakeSiteverify>) =>
  fake.mock.calls.filter(([input]) => String(input) === SITEVERIFY_URL).length;
