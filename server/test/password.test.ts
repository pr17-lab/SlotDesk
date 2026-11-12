// Unit tests for our password hashing (src/password.ts, D-031, Step 7d).
// No database. Test passwords are made up and never printed: every check
// compares a boolean or uses toMatch.
import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

const HASH_FORMAT = /^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$/;
const PASSWORD = 'correct-horse-battery';
const FORMAT_ERROR = 'Stored password hash is not in the expected format';

describe('hashPassword and verifyPassword', () => {
  it('stores the scrypt settings, salt and key in the hash', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(HASH_FORMAT);
  });

  it('accepts the right password and rejects one that differs by one character', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(
      await verifyPassword({ hash, password: 'correct-horse-batterz' }),
    ).toBe(false);
  });

  it('uses a random salt, so two hashes of one password differ and both verify', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first === second).toBe(false);
    expect(await verifyPassword({ hash: first, password: PASSWORD })).toBe(
      true,
    );
    expect(await verifyPassword({ hash: second, password: PASSWORD })).toBe(
      true,
    );
  });

  it('normalizes with NFKC, so both Unicode forms of an accented letter match', async () => {
    const hash = await hashPassword('caf\u00e9-password-1');
    expect(
      await verifyPassword({ hash, password: 'cafe\u0301-password-1' }),
    ).toBe(true);
  });

  it('reads N, r and p from the stored hash', async () => {
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync(PASSWORD.normalize('NFKC'), salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const hash = `scrypt:16384:8:1:${salt.toString('hex')}:${key.toString('hex')}`;
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong-password-1' })).toBe(
      false,
    );
  });
});

describe('verifyPassword with a malformed stored hash', () => {
  const SALT = 'a'.repeat(32);
  const KEY = 'b'.repeat(128);
  const VALID = `scrypt:32768:8:3:${SALT}:${KEY}`;

  it.each([
    ['empty string', ''],
    ["Better Auth's old two-part format", `${SALT}:${KEY}`],
    ['prefix bcrypt', `bcrypt:32768:8:3:${SALT}:${KEY}`],
    ['N not a power of two', `scrypt:30000:8:3:${SALT}:${KEY}`],
    ['N above the limit', `scrypt:131072:8:3:${SALT}:${KEY}`],
    ['N of 1', `scrypt:1:8:3:${SALT}:${KEY}`],
    ['r of 0', `scrypt:32768:0:3:${SALT}:${KEY}`],
    ['r above the limit', `scrypt:32768:16:3:${SALT}:${KEY}`],
    ['p not digits', `scrypt:32768:8:x:${SALT}:${KEY}`],
    ['p above the limit', `scrypt:32768:8:17:${SALT}:${KEY}`],
    ['a seventh part', `${VALID}:extra`],
    ['uppercase hex in the salt', `scrypt:32768:8:3:${'A'.repeat(32)}:${KEY}`],
    ['a key 2 characters short', `scrypt:32768:8:3:${SALT}:${'b'.repeat(126)}`],
  ])('rejects %s', async (_name, hash) => {
    await expect(verifyPassword({ hash, password: PASSWORD })).rejects.toThrow(
      FORMAT_ERROR,
    );
  });

  it('does not put the salt or key in the error message', async () => {
    const salt = 'c'.repeat(32);
    const key = 'd'.repeat(128);
    let message = '';
    try {
      await verifyPassword({
        hash: `bcrypt:32768:8:3:${salt}:${key}`,
        password: PASSWORD,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message === FORMAT_ERROR).toBe(true);
    expect(message.includes(salt)).toBe(false);
    expect(message.includes(key)).toBe(false);
  });
});
