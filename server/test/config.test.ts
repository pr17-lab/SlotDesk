import { describe, expect, it } from 'vitest';
import { parsePort, databaseUrlSchema } from '../src/config.js';

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
