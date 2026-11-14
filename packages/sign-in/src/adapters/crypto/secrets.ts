/** Server-only random material, S256 PKCE and constant-work scrypt password verification. */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

import { accountIdSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

const PASSWORD_BYTES = 64;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const SCHEME = 'scrypt';

/** scrypt's work as stored in each hash: N as its base-2 logarithm, the block size r and the parallelism p. */
export interface PasswordCost {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/** About 128 MiB and a few hundred milliseconds per hash: OWASP's scrypt parameters for passwords. */
export const PASSWORD_COST: PasswordCost = { log2N: 17, r: 8, p: 1 };
/** scrypt needs 128 * N * r * p bytes; room is left for its own bookkeeping. */
const MEMORY_HEADROOM = 2;
const SCRYPT_BLOCK_BYTES = 128;

/** Parameters read back from a stored hash are bounded, so a damaged row cannot exhaust the server. */
const storedCostSchema = z.object({ log2N: z.coerce.number().int().min(10).max(20), r: z.coerce.number().int().min(1).max(32), p: z.coerce.number().int().min(1).max(16) });
const STORED_HASH = /^scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export function createSecrets(options: { passwordCost?: PasswordCost } = {}) {
  const cost = options.passwordCost ?? PASSWORD_COST;
  const unmatched = randomBytes(SALT_BYTES).toString('base64url');
  return {
    accountId: () => accountIdSchema.parse(randomUUID()),
    token: () => randomBytes(TOKEN_BYTES).toString('base64url'),
    digest: (value: string) => Promise.resolve(createHash('sha256').update(value).digest('base64url')),
    async hashPassword(password: string) {
      const salt = randomBytes(SALT_BYTES).toString('base64url');
      const hash = await derive({ password, salt, cost });
      return `${SCHEME}$ln=${String(cost.log2N)},r=${String(cost.r)},p=${String(cost.p)}$${salt}$${hash.toString('base64url')}`;
    },
    async verifyPassword(input: { password: string; hash: string | null }) {
      const stored = storedOf(input.hash);
      // An unknown account or unreadable hash costs the same work as a real one, then fails.
      const actual = await derive({ password: input.password, salt: stored?.salt ?? unmatched, cost: stored?.cost ?? cost });
      if (stored === null) return false;
      return actual.length === stored.expected.length && timingSafeEqual(actual, stored.expected);
    },
  };
}

function storedOf(hash: string | null): { cost: PasswordCost; salt: string; expected: Buffer } | null {
  const match = STORED_HASH.exec(hash ?? '');
  if (match === null) return null;
  const [, log2N, r, p, salt = '', expected = ''] = match;
  const cost = storedCostSchema.safeParse({ log2N, r, p });
  return cost.success ? { cost: cost.data, salt, expected: Buffer.from(expected, 'base64url') } : null;
}

function derive(input: { password: string; salt: string; cost: PasswordCost }): Promise<Buffer> {
  const N = 2 ** input.cost.log2N;
  const maxmem = MEMORY_HEADROOM * SCRYPT_BLOCK_BYTES * N * input.cost.r * input.cost.p;
  return new Promise((resolve, reject) => {
    scrypt(input.password, input.salt, PASSWORD_BYTES, { N, r: input.cost.r, p: input.cost.p, maxmem }, (error, key) => { if (error) reject(error); else resolve(key); });
  });
}
