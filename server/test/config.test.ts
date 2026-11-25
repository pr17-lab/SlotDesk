import { describe, expect, it } from 'vitest';
import {
  parsePort,
  databaseUrlSchema,
  authSecretSchema,
  authUrlSchema,
  envSchema,
} from '../src/config.js';

describe('parsePort', () => {
  it.each([
    { name: 'undefined', input: undefined, expected: 3000 },
    { name: 'empty string', input: '', expected: 3000 },
    { name: 'spaces-only string', input: '   ', expected: 3000 },
    { name: '"3000"', input: '3000', expected: 3000 },
    { name: '" 80 " (trims whitespace)', input: ' 80 ', expected: 80 },
    { name: '"65535" (max valid port)', input: '65535', expected: 65535 },
  ])('returns $expected for $name', ({ input, expected }) => {
    expect(parsePort(input)).toBe(expected);
  });

  it.each([
    { name: '"3000abc" (non-numeric suffix)', input: '3000abc' },
    { name: '"3000.5" (decimal)', input: '3000.5' },
    { name: '"0x50" (hex)', input: '0x50' },
    { name: '"1e3" (scientific notation)', input: '1e3' },
    { name: '"0" (below minimum)', input: '0' },
    { name: '"65536" (above maximum)', input: '65536' },
    { name: '"-1" (negative)', input: '-1' },
  ])('throws for $name', ({ input }) => {
    expect(() => parsePort(input)).toThrow();
  });
});

describe('databaseUrlSchema (DATABASE_URL validation)', () => {
  it.each([
    {
      name: 'a postgres:// URL',
      input: 'postgres://user:pass@localhost:5432/slotdesk',
    },
    {
      name: 'a postgresql:// URL',
      input: 'postgresql://user:pass@localhost:5432/slotdesk',
    },
  ])('accepts $name', ({ input }) => {
    const result = databaseUrlSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects an http:// URL (wrong scheme)', () => {
    const result = databaseUrlSchema.safeParse(
      'http://user:pass@localhost:5432/slotdesk',
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/postgres/);
    }
  });

  it.each([
    { name: 'a plain string (not a URL)', input: 'not-a-url' },
    { name: 'an empty string', input: '' },
    { name: 'undefined', input: undefined },
  ])('rejects $name', ({ input }) => {
    const result = databaseUrlSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('authSecretSchema (BETTER_AUTH_SECRET validation)', () => {
  it('rejects a missing secret (undefined)', () => {
    const result = authSecretSchema.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/BETTER_AUTH_SECRET/);
    }
  });

  it('rejects a secret shorter than 32 characters without printing it', () => {
    const shortSecret = 'short-test-secret-31-characters';
    expect(shortSecret).toHaveLength(31);
    const result = authSecretSchema.safeParse(shortSecret);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0].message;
      expect(message).toMatch(/BETTER_AUTH_SECRET/);
      expect(message).not.toContain(shortSecret);
    }
  });

  it('accepts a secret of exactly 32 characters', () => {
    const result = authSecretSchema.safeParse('a'.repeat(32));
    expect(result.success).toBe(true);
  });
});

describe('authUrlSchema (BETTER_AUTH_URL validation)', () => {
  it('rejects a missing URL (undefined)', () => {
    const result = authUrlSchema.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/BETTER_AUTH_URL/);
    }
  });

  it('rejects a plain string (not a URL)', () => {
    const result = authUrlSchema.safeParse('not-a-url');
    expect(result.success).toBe(false);
  });

  it('rejects an ftp:// URL (wrong scheme)', () => {
    const result = authUrlSchema.safeParse('ftp://localhost:3000');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/http/);
    }
  });

  it.each([
    { name: 'an http:// URL', input: 'http://localhost:3000' },
    { name: 'an https:// URL', input: 'https://slotdesk.example.com' },
  ])('accepts $name', ({ input }) => {
    const result = authUrlSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// Shaped like real keys, but made up. Production refuses Cloudflare's
// published test keys, so production tests need these.
const REAL_LOOKING_TURNSTILE_KEYS = {
  TURNSTILE_SITE_KEY: '0x4AAAAAAAmadeUpSiteKey',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAmadeUpSecretKeyNotReal00',
};

describe('envSchema (BETTER_AUTH_URL must be https in production)', () => {
  // Test-only values; none of them is a real secret or database.
  const baseEnv = {
    DATABASE_URL: 'postgresql://test:test@db.invalid:5432/slotdesk_test',
    BETTER_AUTH_SECRET: 'test-only-secret-not-for-real-00',
  };

  it('rejects an http:// URL in production', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'http://slotdesk.example.com',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/BETTER_AUTH_URL/);
    }
  });

  it.each([
    {
      name: 'an https:// URL in production',
      nodeEnv: 'production',
      url: 'https://slotdesk.example.com',
    },
    {
      name: 'an http:// URL in development',
      nodeEnv: 'development',
      url: 'http://localhost:3000',
    },
  ])('accepts $name', ({ nodeEnv, url }) => {
    const result = envSchema.safeParse({
      ...baseEnv,
      ...REAL_LOOKING_TURNSTILE_KEYS,
      NODE_ENV: nodeEnv,
      BETTER_AUTH_URL: url,
    });
    expect(result.success).toBe(true);
  });
});

describe('envSchema (rate limit settings)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://test:test@db.invalid:5432/slotdesk_test',
    BETTER_AUTH_SECRET: 'test-only-secret-not-for-real-00',
    BETTER_AUTH_URL: 'http://localhost:3000',
  };

  it('uses 100 writes and 600 requests when they are not set', () => {
    const result = envSchema.parse(baseEnv);
    expect(result.WRITE_RATE_LIMIT).toBe(100);
    expect(result.REQUEST_RATE_LIMIT).toBe(600);
  });

  it('reads both settings as numbers', () => {
    const result = envSchema.parse({
      ...baseEnv,
      WRITE_RATE_LIMIT: '5',
      REQUEST_RATE_LIMIT: '50',
    });
    expect(result.WRITE_RATE_LIMIT).toBe(5);
    expect(result.REQUEST_RATE_LIMIT).toBe(50);
  });

  it.each(['0', '-1', '1.5', '1e3', 'ten', '', ' 5'])(
    'rejects "%s" and names the variable',
    (value) => {
      const result = envSchema.safeParse({
        ...baseEnv,
        WRITE_RATE_LIMIT: value,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/WRITE_RATE_LIMIT/);
      }
    },
  );
});

describe('envSchema (online booking settings)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://test:test@db.invalid:5432/slotdesk_test',
    BETTER_AUTH_SECRET: 'test-only-secret-not-for-real-00',
    BETTER_AUTH_URL: 'http://localhost:3000',
  };

  it('uses 300 requests, 5 bookings an hour and 20 a day when not set', () => {
    const result = envSchema.parse(baseEnv);
    expect(result.PUBLIC_REQUEST_RATE_LIMIT).toBe(300);
    expect(result.PUBLIC_BOOKING_RATE_LIMIT).toBe(5);
    expect(result.PUBLIC_DAILY_BOOKING_CAP).toBe(20);
  });

  it('reads all three as numbers', () => {
    const result = envSchema.parse({
      ...baseEnv,
      PUBLIC_REQUEST_RATE_LIMIT: '30',
      PUBLIC_BOOKING_RATE_LIMIT: '2',
      PUBLIC_DAILY_BOOKING_CAP: '50',
    });
    expect(result.PUBLIC_REQUEST_RATE_LIMIT).toBe(30);
    expect(result.PUBLIC_BOOKING_RATE_LIMIT).toBe(2);
    expect(result.PUBLIC_DAILY_BOOKING_CAP).toBe(50);
  });

  it.each([
    'PUBLIC_REQUEST_RATE_LIMIT',
    'PUBLIC_BOOKING_RATE_LIMIT',
    'PUBLIC_DAILY_BOOKING_CAP',
  ])('rejects 0 for %s and names it', (name) => {
    const result = envSchema.safeParse({ ...baseEnv, [name]: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(name);
    }
  });
});

describe('envSchema (bot check keys)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://test:test@db.invalid:5432/slotdesk_test',
    BETTER_AUTH_SECRET: 'test-only-secret-not-for-real-00',
    BETTER_AUTH_URL: 'https://slotdesk.example.com',
  };
  // Cloudflare's published test keys (always pass, always fail, spent).
  const TEST_SITE_KEY = '1x00000000000000000000AA';
  const TEST_SECRETS = [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
  ];

  const messages = (env: Record<string, string>): string[] => {
    const result = envSchema.safeParse({ ...baseEnv, ...env });
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it('accepts real-looking keys in production', () => {
    const result = envSchema.parse({
      ...baseEnv,
      ...REAL_LOOKING_TURNSTILE_KEYS,
      NODE_ENV: 'production',
    });
    expect(result.TURNSTILE_SITE_KEY).toBe(
      REAL_LOOKING_TURNSTILE_KEYS.TURNSTILE_SITE_KEY,
    );
    expect(result.TURNSTILE_SECRET_KEY).toBe(
      REAL_LOOKING_TURNSTILE_KEYS.TURNSTILE_SECRET_KEY,
    );
  });

  it('refuses to start in production without the keys', () => {
    const found = messages({ NODE_ENV: 'production' });
    expect(found.some((m) => m.includes('TURNSTILE_SITE_KEY'))).toBe(true);
    expect(found.some((m) => m.includes('TURNSTILE_SECRET_KEY'))).toBe(true);
  });

  it.each(TEST_SECRETS)(
    'refuses the published test secret %s in production, without printing it',
    (secret) => {
      const found = messages({
        NODE_ENV: 'production',
        TURNSTILE_SITE_KEY: REAL_LOOKING_TURNSTILE_KEYS.TURNSTILE_SITE_KEY,
        TURNSTILE_SECRET_KEY: secret,
      });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/TURNSTILE_SECRET_KEY/);
      expect(found[0]).not.toContain(secret);
    },
  );

  it.each(['development', 'test'])(
    'starts without the keys in %s',
    (nodeEnv) => {
      const result = envSchema.parse({ ...baseEnv, NODE_ENV: nodeEnv });
      expect(result.TURNSTILE_SITE_KEY).toBeUndefined();
      expect(result.TURNSTILE_SECRET_KEY).toBeUndefined();
    },
  );

  it('accepts the published test keys outside production', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'test',
      TURNSTILE_SITE_KEY: TEST_SITE_KEY,
      TURNSTILE_SECRET_KEY: TEST_SECRETS[0],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['only the site key', { TURNSTILE_SITE_KEY: TEST_SITE_KEY }],
    ['only the secret', { TURNSTILE_SECRET_KEY: TEST_SECRETS[0]! }],
  ])('refuses %s: both or neither', (_label, env) => {
    const found = messages({ NODE_ENV: 'development', ...env });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/);
  });
});
