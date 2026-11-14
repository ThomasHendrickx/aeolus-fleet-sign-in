/** Server-only random material, S256 PKCE and constant-work scrypt password verification. */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

import { accountIdSchema } from '@aeolus-fleet/common';

const PASSWORD_BYTES = 64;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

export function createSecrets() {
  const unmatched = randomBytes(SALT_BYTES);
  return {
    accountId: () => accountIdSchema.parse(randomUUID()),
    token: () => randomBytes(TOKEN_BYTES).toString('base64url'),
    digest: (value: string) => Promise.resolve(createHash('sha256').update(value).digest('base64url')),
    async hashPassword(password: string) {
      const salt = randomBytes(SALT_BYTES).toString('base64url');
      const hash = await derive({ password, salt });
      return `scrypt:${salt}:${hash.toString('base64url')}`;
    },
    async verifyPassword(input: { password: string; hash: string | null }) {
      const [scheme, salt, expected] = (input.hash ?? '').split(':');
      const actual = await derive({ password: input.password, salt: salt ?? unmatched });
      if (scheme !== 'scrypt' || expected === undefined) return false;
      const bytes = Buffer.from(expected, 'base64url');
      return actual.length === bytes.length && timingSafeEqual(actual, bytes);
    },
  };
}

function derive(input: { password: string; salt: string | Buffer }): Promise<Buffer> {
  return new Promise((resolve, reject) => { scrypt(input.password, input.salt, PASSWORD_BYTES, (error, key) => { if (error) reject(error); else resolve(key); }); });
}
