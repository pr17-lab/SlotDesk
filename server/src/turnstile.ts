import { z } from 'zod';
import { logger } from './logger.js';

// Cloudflare Turnstile, the bot check on the public booking page. The page
// gets a token from Cloudflare's widget; we ask Cloudflare whether it is real
// before booking.

export const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare's docs ask for a time limit but give none; 5 seconds keeps a
// customer from waiting long on an outage.
const TIMEOUT_MS = 5000;

// The error codes that mean the customer's token is bad. Every other code
// means Cloudflare or our setup is at fault, not the customer.
const BAD_TOKEN_CODES = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
]);

const answerSchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).optional(),
});

export type BotCheck = 'ok' | 'rejected' | 'unavailable';

// Fails closed: anything other than a clear pass or a clear bad token is
// 'unavailable', and no booking is made. Never logs the secret or the token.
export async function verifyTurnstile(
  secret: string,
  token: string,
): Promise<BotCheck> {
  let body: unknown;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Bot check: Cloudflare HTTP error');
      return 'unavailable';
    }
    body = await res.json();
  } catch (err) {
    // A timeout, a network failure or a body that isn't JSON. Only the
    // error's name: its message can include the URL, never the secret.
    logger.warn(
      { error: err instanceof Error ? err.name : 'unknown' },
      'Bot check: no answer from Cloudflare',
    );
    return 'unavailable';
  }

  const answer = answerSchema.safeParse(body);
  if (!answer.success) {
    logger.warn('Bot check: unexpected answer from Cloudflare');
    return 'unavailable';
  }
  if (answer.data.success) {
    return 'ok';
  }
  const codes = answer.data['error-codes'] ?? [];
  if (codes.length > 0 && codes.every((code) => BAD_TOKEN_CODES.has(code))) {
    return 'rejected';
  }
  logger.warn({ codes }, 'Bot check: Cloudflare could not check the token');
  return 'unavailable';
}
