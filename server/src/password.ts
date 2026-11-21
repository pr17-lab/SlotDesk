// Password hashing for Better Auth (D-031).
//
// Why our own: Better Auth's default scrypt settings are below OWASP's
// minimum, and its hash format doesn't record the settings, so raising the
// cost later would break every login. We use OWASP's N=2^15, r=8, p=3 and
// store the settings in each hash:
//
//   scrypt:<N>:<r>:<p>:<salt as 32 hex characters>:<key as 128 hex characters>
//
// verifyPassword reads the settings back, so we can raise the cost for new
// hashes and old ones still work.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = { N: 32768, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Caps on settings read from a stored hash, so a corrupted value can't make
// one sign-in eat the server's memory. These allow at most 64 MiB per hash
// (scrypt needs about 128 * N * r bytes).
const MAX_N = 65536;
const MAX_R = 8;
const MAX_P = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  // NFKC so the same password typed in different Unicode forms (an accented
  // letter as one character or two) gives the same hash.
  // scrypt runs on Node's thread pool, so it doesn't block other requests.
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      // Node's default memory cap is exactly what N=2^15, r=8 needs, so
      // allow twice that.
      { N, r, p, maxmem: 2 * 128 * N * r },
      (err, key) => {
        if (err) {
          reject(err);
        } else {
          resolve(key);
        }
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, COST.N, COST.r, COST.p);
  return [
    'scrypt',
    COST.N,
    COST.r,
    COST.p,
    salt.toString('hex'),
    key.toString('hex'),
  ].join(':');
}

// Reads a stored setting: digits only, between 1 and max.
function parseSetting(value: string, max: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : null;
}

// Throws on a stored hash that isn't in our format. That's corrupted data,
// so it should fail loudly (a 500), not look like a wrong password. The
// message never includes the hash.
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const parts = hash.split(':');
  // A missing part becomes '', which every check below rejects.
  const [
    prefix = '',
    nText = '',
    rText = '',
    pText = '',
    saltHex = '',
    keyHex = '',
  ] = parts;
  const N = parseSetting(nText, MAX_N);
  const r = parseSetting(rText, MAX_R);
  const p = parseSetting(pText, MAX_P);
  if (
    parts.length !== 6 ||
    prefix !== 'scrypt' ||
    N === null ||
    r === null ||
    p === null ||
    // scrypt requires N to be a power of two greater than 1.
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    !/^[0-9a-f]{32}$/.test(saltHex) ||
    !/^[0-9a-f]{128}$/.test(keyHex)
  ) {
    throw new Error('Stored password hash is not in the expected format');
  }
  const storedKey = Buffer.from(keyHex, 'hex');
  const key = await deriveKey(password, Buffer.from(saltHex, 'hex'), N, r, p);
  // Constant-time, so timing can't reveal how many bytes matched.
  return timingSafeEqual(key, storedKey);
}
