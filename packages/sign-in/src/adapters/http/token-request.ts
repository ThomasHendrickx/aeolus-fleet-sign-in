/** Parses each server-to-server form at the edge, one schema per grant type, into its OAuth error when refused. */
import { idSchema, type FleetId } from '@aeolus-fleet/common';
import { z } from 'zod';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SHARED_SIGN_IN_TOKEN_TYPE = 'urn:aeolus:params:oauth:token-type:sign-in';
const FIELD_LIMIT = 4096;

const field = z.string().min(1).max(FIELD_LIMIT);
const grantSchema = z.object({ grant_type: field });
const codeGrantSchema = z.object({ code: field, redirect_uri: field, code_verifier: field });
const tokenExchangeSchema = z.object({ subject_token_type: z.literal(SHARED_SIGN_IN_TOKEN_TYPE), subject_token: field, resource: idSchema('fleet') });

export type TokenRequest =
  | { readonly kind: 'authorizationCode'; readonly code: string; readonly redirectUri: string; readonly verifier: string }
  | { readonly kind: 'tokenExchange'; readonly signIn: string; readonly fleetId: FleetId }
  | { readonly kind: 'refused'; readonly error: 'invalid_request' | 'unsupported_grant_type' | 'invalid_target' };

export function tokenRequestOf(fields: unknown): TokenRequest {
  const grant = grantSchema.safeParse(fields);
  if (!grant.success) return { kind: 'refused', error: 'invalid_request' };
  if (grant.data.grant_type === 'authorization_code') {
    const parsed = codeGrantSchema.safeParse(fields);
    return parsed.success ? { kind: 'authorizationCode', code: parsed.data.code, redirectUri: parsed.data.redirect_uri, verifier: parsed.data.code_verifier } : { kind: 'refused', error: 'invalid_request' };
  }
  if (grant.data.grant_type !== TOKEN_EXCHANGE_GRANT) return { kind: 'refused', error: 'unsupported_grant_type' };
  const parsed = tokenExchangeSchema.safeParse(fields);
  if (parsed.success) return { kind: 'tokenExchange', signIn: parsed.data.subject_token, fleetId: parsed.data.resource };
  const refusedFields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  if (refusedFields.has('subject_token_type')) return { kind: 'refused', error: 'unsupported_grant_type' };
  return { kind: 'refused', error: refusedFields.has('resource') ? 'invalid_target' : 'invalid_request' };
}
