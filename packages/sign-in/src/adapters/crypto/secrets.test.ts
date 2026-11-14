/** Password hashes carry explicit, stronger scrypt parameters, so they can be raised later without locking anyone out. */
import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSecrets } from './secrets.js';

describe('password hashing', () => {
  it('hashes with N = 2^17, r = 8 and p = 1, stored in the hash, and verifies only the right password', async () => {
    // Given the server's secrets.
    const secrets = createSecrets();

    // When Maya's password is hashed.
    const hash = await secrets.hashPassword('private-password');

    // Then the hash names its parameters, and only her password verifies.
    expect(hash).toMatch(/^scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await secrets.verifyPassword({ password: 'private-password', hash })).toBe(true);
    expect(await secrets.verifyPassword({ password: 'wrong-password!', hash })).toBe(false);
  });

  it('verifies a hash by the parameters stored in it', async () => {
    // Given a hash made with other parameters.
    const salt = randomBytes(16).toString('base64url');
    const derived = scryptSync('private-password', salt, 64, { N: 2 ** 14, r: 4, p: 2 }).toString('base64url');
    const hash = `scrypt$ln=14,r=4,p=2$${salt}$${derived}`;

    // When Maya's password is checked against it.
    const isAccepted = await createSecrets().verifyPassword({ password: 'private-password', hash });

    // Then it verifies.
    expect(isAccepted).toBe(true);
  });
});
