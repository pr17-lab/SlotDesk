// Password hashing for Better Auth (D-031, Step 7d).
//
// Why our own functions: Better Auth 1.7.18's default scrypt settings
// (N=16384, r=16, p=1) are below OWASP's minimum, and its stored format
// ("salt:key") does not record the settings, so raising the cost later would
// break every existing login. We use OWASP's listed equivalent N=2^15, r=8,
// p=3 (32 MiB per hash) and store the settings inside each hash:
//
//   scrypt:<N>:<r>:<p>:<salt as 32 hex characters>:<key as 128 hex characters>
//
// verifyPassword reads N, r and p from the stored hash, so a later task can
// raise the cost for new hashes while old hashes still verify.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = { N: 32768, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Upper limits for settings read back from a stored hash, so a corrupted or
// tampered value cannot make one sign-in use too much memory or CPU. scrypt
// needs about 128 * N * r bytes, so these allow at most 64 MiB per hash
// (Render's free instance has 512 MB, and Node runs up to four hashes at once).
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
  // NFKC: the same text typed in different Unicode forms (for example an
  // accented letter as one character or as letter plus accent) gives the same
  // hash. Better Auth's default hasher does the same.
  // node:crypto's scrypt takes a callback, so it is wrapped in a Promise
  // here. It runs on libuv's thread pool and does not block other requests.
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      // Node refuses settings that need more memory than `maxmem` (default
      // 32 MiB, exactly what N=2^15, r=8 needs), so allow twice the need.
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

// Throws for a stored hash that is not in our format. A broken hash is data
// corruption, so it should fail the request loudly (Better Auth logs it and
// answers 500), not look like a wrong password. The message never contains
// the hash.
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const parts = hash.split(':');
  // The `= ''` defaults give a missing part an empty string, which every
  // check below rejects.
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
  // Constant-time comparison: the time taken does not reveal how many leading
  // bytes matched. Both buffers are KEY_BYTES long (checked above).
  return timingSafeEqual(key, storedKey);
}
