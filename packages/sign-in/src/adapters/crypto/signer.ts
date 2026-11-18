/** Only public Ed25519 material is published; each JWT identifies its active key. */
import { createPublicKey, type KeyObject } from 'node:crypto';

import { SignJWT, type JWK } from 'jose';

import { createAuthorizationSeals } from './authorization-seals.js';

import type { FleetClaims } from '../../core/account-tokens/account-token.js';

export function createSigner(input: { flowPrivateKey: KeyObject; activeKeyId: string; keys: readonly { id: string; privateKey: KeyObject }[] }) {
  const active = input.keys.find((key) => key.id === input.activeKeyId);
  if (active === undefined || input.keys.some((key) => key.privateKey.type !== 'private' || key.privateKey.asymmetricKeyType !== 'ed25519') || new Set(input.keys.map((key) => key.id)).size !== input.keys.length) throw new Error('Invalid signing key configuration');
  const keys: JWK[] = input.keys.map((key) => ({ ...createPublicKey(key.privateKey).export({ format: 'jwk' }), kid: key.id, alg: 'EdDSA', use: 'sig' }));
  const flowPublicKey = createPublicKey(input.flowPrivateKey).export({ format: 'jwk' });
  if (keys.some((key) => key.x === flowPublicKey.x)) throw new Error('Flow signing key must be separate from account signing keys');
  return {
    publicKeys: { keys },
    flows: createAuthorizationSeals(input.flowPrivateKey),
    sign: (claims: FleetClaims) => new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: active.id }).sign(active.privateKey),
  };
}
