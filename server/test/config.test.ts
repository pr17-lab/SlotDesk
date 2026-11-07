import { describe, expect, it } from 'vitest';
import {
  parsePort,
  databaseUrlSchema,
  authSecretSchema,
  authUrlSchema,
  envSchema,
} from '../src/config.js';

describe('parsePort', () => {
  it('returns 3000 for undefined', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it('returns 3000 for empty string', () => {
    expect(parsePort('')).toBe(3000);
  });

  it('returns 3000 for spaces-only string', () => {
    expect(parsePort('   ')).toBe(3000);
  });

  it('returns 3000 for "3000"', () => {
    expect(parsePort('3000')).toBe(3000);
  });

  it('returns 80 for " 80 " (trims whitespace)', () => {
    expect(parsePort(' 80 ')).toBe(80);
  });

  it('returns 65535 for "65535" (max valid port)', () => {
    expect(parsePort('65535')).toBe(65535);
  });

  it('throws for "3000abc" (non-numeric suffix)', () => {
    expect(() => parsePort('3000abc')).toThrow();
  });

  it('throws for "3000.5" (decimal)', () => {
    expect(() => parsePort('3000.5')).toThrow();
  });

  it('throws for "0x50" (hex)', () => {
    expect(() => parsePort('0x50')).toThrow();
  });

  it('throws for "1e3" (scientific notation)', () => {
    expect(() => parsePort('1e3')).toThrow();
  });

  it('throws for "0" (below minimum)', () => {
    expect(() => parsePort('0')).toThrow();
  });

  it('throws for "65536" (above maximum)', () => {
    expect(() => parsePort('65536')).toThrow();
  });

  it('throws for "-1" (negative)', () => {
    expect(() => parsePort('-1')).toThrow();
  });
});

describe('databaseUrlSchema (DATABASE_URL validation)', () => {
  it('accepts a postgres:// URL', () => {
    const result = databaseUrlSchema.safeParse(
      'postgres://user:pass@localhost:5432/slotdesk',
    );
    expect(result.success).toBe(true);
  });

  it('accepts a postgresql:// URL', () => {
    const result = databaseUrlSchema.safeParse(
      'postgresql://user:pass@localhost:5432/slotdesk',
    );
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

  it('rejects a plain string (not a URL)', () => {
    const result = databaseUrlSchema.safeParse('not-a-url');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = databaseUrlSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects undefined', () => {
    const result = databaseUrlSchema.safeParse(undefined);
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

  it('accepts an http:// URL', () => {
    const result = authUrlSchema.safeParse('http://localhost:3000');
    expect(result.success).toBe(true);
  });

  it('accepts an https:// URL', () => {
    const result = authUrlSchema.safeParse('https://slotdesk.example.com');
    expect(result.success).toBe(true);
  });
});

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

  it('accepts an https:// URL in production', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://slotdesk.example.com',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an http:// URL in development', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:3000',
    });
    expect(result.success).toBe(true);
  });
});
