import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { SAFE_METHODS } from './origin.js';

// shortcut: the counts live in this process's memory, so a restart resets them and a second instance would double the limit; move them to a shared store if either becomes a problem
export const makeRateLimiter = (
  limit: number,
  options: { skip?: (req: Request) => boolean; windowMinutes?: number } = {},
) =>
  rateLimit({
    windowMs: (options.windowMinutes ?? 15) * 60 * 1000,
    limit,
    skip: options.skip,
    // Cloudflare's header only; x-forwarded-for can be forged (D-031). The
    // library groups IPv6 addresses by /56, so one customer can't dodge the
    // limit by rotating addresses inside their own block.
    keyGenerator: (req) =>
      ipKeyGenerator(req.get('cf-connecting-ip') ?? req.ip ?? ''),
    message: { error: 'Too Many Requests' },
  });

// Every request to /api/orgs, reads included: they cost CPU and database time.
export const requestLimiter = makeRateLimiter(config.requestRateLimit);

// Requests that change data. The tighter limit that keeps one client from
// filling the database.
export const writeLimiter = makeRateLimiter(config.writeRateLimit, {
  skip: (req) => SAFE_METHODS.has(req.method),
});

// The same two kinds of limit on /api/public, with their own counts. The
// only write there is a booking, so the second one is bookings per hour.
export const publicRequestLimiter = makeRateLimiter(
  config.publicRequestRateLimit,
);

export const publicBookingLimiter = makeRateLimiter(
  config.publicBookingRateLimit,
  { skip: (req) => SAFE_METHODS.has(req.method), windowMinutes: 60 },
);
