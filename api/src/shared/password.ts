import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` resolves to scrypt's 3-argument overload and drops the one that
// takes options, so the signature is restated here to keep N/r/p available.
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from `node:crypto`.
 *
 * scrypt is memory-hard and is on OWASP's accepted list, and it ships with
 * Node -- so this adds no dependency and no native build step. Argon2id would
 * be the first choice in production; it needs a native module, which is a poor
 * trade for a take-home a reviewer has to install.
 *
 * Format: `scrypt$N$r$p$<salt hex>$<hash hex>`. Parameters travel with the
 * hash, so they can be raised later and old passwords keep verifying against
 * the settings they were created with.
 */

// N=16384, r=8, p=1 is the classic interactive-login baseline: ~16MB and a few
// tens of milliseconds per hash.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// scrypt needs its memory budget raised explicitly or it refuses N this large.
const MEMORY = 32 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MEMORY,
  });

  return ['scrypt', N, R, P, salt.toString('hex'), derived.toString('hex')].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored hash, so a corrupt row denies access instead of 500-ing.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltHex, 'hex'),
      expected.length,
      {
        N: n,
        r,
        p,
        maxmem: MEMORY,
      },
    );
  } catch {
    return false;
  }

  // Lengths are equal by construction above, but timingSafeEqual throws if they
  // are not, so this stays defensive.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
