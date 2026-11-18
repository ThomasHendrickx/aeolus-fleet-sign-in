/** Signed form state survives restarts and sibling instances without anonymous database writes. */
import { createPublicKey, randomBytes, type KeyObject } from 'node:crypto';

import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import type { AuthorizationSeals } from '../../core/shared/identity.js';

const authorizationSchema = z.object({ clientId: z.string(), redirectUri: z.url(), state: z.string(), codeChallenge: z.string(), browser: z.string(), expiresAt: z.number() });
const NONCE_BYTES = 32;
const FLOW_TYPE = 'aeolus-sign-in-flow+jwt';

export function createAuthorizationSeals(privateKey: KeyObject): AuthorizationSeals {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid flow signing key configuration');
  const publicKey = createPublicKey(privateKey);
  return {
    seal: (authorization) => new SignJWT({ authorization, nonce: randomBytes(NONCE_BYTES).toString('base64url') }).setProtectedHeader({ alg: 'EdDSA', typ: FLOW_TYPE }).sign(privateKey),
    async open(flow) {
      try {
        const verified = await jwtVerify(flow, publicKey, { algorithms: ['EdDSA'], typ: FLOW_TYPE });
        const parsed = authorizationSchema.safeParse(verified.payload.authorization);
        return parsed.success ? parsed.data : null;
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}
