import { createHash } from 'node:crypto';
import { z } from 'zod';

// The secrets in invite and cancel links: 32 random bytes as 43 base64url
// characters, no padding.
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// The secret from a { token } body, or null for anything else. It comes in
// the body, never the URL, so it isn't in any log. A route answers null with
// the same 404 as an unknown link, before any database query.
export function readToken(body: unknown): string | null {
  const parsed = z.object({ token: tokenSchema }).safeParse(body);
  return parsed.success ? parsed.data.token : null;
}

// We keep only the SHA-256 of a link's secret. A fast hash is fine: the
// secret is random, so there is nothing to guess. Never log the secret.
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
