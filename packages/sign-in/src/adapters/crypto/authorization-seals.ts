/** Signed form state survives restarts and sibling instances without anonymous database writes. */
import { randomBytes, type KeyObject } from 'node:crypto';

import { createLocalJWKSet, errors, jwtVerify, SignJWT, type JWK } from 'jose';
import { z } from 'zod';

import type { AuthorizationSeals } from '../../core/shared/identity.js';

const authorizationSchema = z.object({ clientId: z.string(), redirectUri: z.url(), state: z.string(), codeChallenge: z.string(), browser: z.string(), expiresAt: z.number() });
const NONCE_BYTES = 32;
const FLOW_TYPE = 'aeolus-sign-in-flow+jwt';

export function createAuthorizationSeals(input: { active: { id: string; privateKey: KeyObject }; keys: JWK[] }): AuthorizationSeals {
  const publicKeys = createLocalJWKSet({ keys: input.keys });
  return {
    seal: (authorization) => new SignJWT({ authorization, nonce: randomBytes(NONCE_BYTES).toString('base64url') }).setProtectedHeader({ alg: 'EdDSA', typ: FLOW_TYPE, kid: input.active.id }).sign(input.active.privateKey),
    async open(flow) {
      try {
        const verified = await jwtVerify(flow, publicKeys, { algorithms: ['EdDSA'], typ: FLOW_TYPE });
        const parsed = authorizationSchema.safeParse(verified.payload.authorization);
        return parsed.success ? parsed.data : null;
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}
