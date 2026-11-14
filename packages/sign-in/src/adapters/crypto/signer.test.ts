/** Operational key rotation keeps verification through the last token's life and allowance. */
import { generateKeyPairSync } from 'node:crypto';

import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import type { FleetClaims } from '../../core/account-tokens/account-token.js';
import { createSigner } from './signer.js';

const claims: FleetClaims = { iss: 'https://signin.example.test', aud: 'flt_00000000000000000000000001', sub: 'maya-opaque-account', org: 'local', scope: 'fleet:read', group: ['fleet-manager'], iat: 0, exp: 600 };

describe('publish, activate and retire signing keys', () => {
  it('publishes the replacement before use and keeps old tokens valid through ten minutes plus the allowance', async () => {
    // Given the replacement published beside the old active key.
    const old = { id: 'old', privateKey: generateKeyPairSync('ed25519').privateKey };
    const replacement = { id: 'replacement', privateKey: generateKeyPairSync('ed25519').privateKey };
    const published = createSigner({ activeKeyId: old.id, keys: [old, replacement] });
    const oldToken = await published.sign(claims);
    const publicKeys = createLocalJWKSet(published.publicKeys);
    const verify = (token: string, seconds: number) => jwtVerify(token, publicKeys, { issuer: claims.iss, audience: claims.aud, typ: 'at+jwt', clockTolerance: 30, currentDate: new Date(seconds * 1000) });
    expect(published.publicKeys.keys.map((key) => key.kid)).toEqual(['old', 'replacement']);
    expect(JSON.stringify(published.publicKeys)).not.toContain('"d":');

    // When the replacement becomes active after core's one-minute cache interval.
    const activated = createSigner({ activeKeyId: replacement.id, keys: [old, replacement] });
    const freshToken = await activated.sign({ ...claims, iat: 61, exp: 661 });

    // Then cached published keys verify both generations through the overlap, but the old token ends at 630 seconds.
    expect((await verify(oldToken, 629)).protectedHeader.kid).toBe('old');
    expect((await verify(freshToken, 629)).protectedHeader.kid).toBe('replacement');
    await expect(verify(oldToken, 630)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    const retired = createSigner({ activeKeyId: replacement.id, keys: [replacement] });
    const options = { clockTolerance: 30, currentDate: new Date(630_000), issuer: claims.iss, audience: claims.aud, typ: 'at+jwt' };
    await expect(jwtVerify(oldToken, createLocalJWKSet(retired.publicKeys), options)).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    expect((await jwtVerify(freshToken, createLocalJWKSet(retired.publicKeys), options)).payload.sub).toBe('maya-opaque-account');
  });
});
