/** The public console/gateway wire contract uses browser binding, shared cookies and server-only secrets. */
import { generateKeyPairSync } from 'node:crypto';

import { accountTokenClaimsSchema } from '@aeolus-fleet/common';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createService } from '../src/app.js';
import { createSecrets } from '../src/adapters/crypto/secrets.js';
import { createSigner } from '../src/adapters/crypto/signer.js';
import { aSetup, fleetOfMaya } from './support/setup-fixtures.js';
import { memoryIdentity } from './support/memory-identity.js';

const origin = 'https://signin.example.test';
const redirectUri = 'https://console.example.test/sign-in/done';
const client = { id: 'console', secret: 'fixture-client-secret', redirectUri };

async function serviceOfMaya() {
  const identity = memoryIdentity();
  const fleet = fleetOfMaya(identity);
  const secrets = createSecrets();
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createSigner({ activeKeyId: 'first', keys: [{ id: 'first', privateKey }] });
  const app = createService({ identity, fleet, secrets, signer, now: () => Date.now(), config: {
    origin, cookieDomain: 'example.test', clients: [client], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
  } });
  expect((await app.setup(aSetup().input)).kind).toBe('ready');
  return { app, secrets, signer, identity };
}

function form(fields: Record<string, string>) { return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() }; }

function cookieOf(response: { headers: Record<string, unknown> }, name: string) {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header.filter((value): value is string => typeof value === 'string') : typeof header === 'string' ? [header] : [];
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0] ?? '';
}

describe('first browser sign-in over the existing wire contract', () => {
  it('authenticates Maya, redirects only to a registered callback, redeems once, and signs a fresh fleet token', async () => {
    // Given trusted setup, a console browser and an S256 verifier.
    const { app, secrets } = await serviceOfMaya();
    try {
      const challenge = await secrets.digest('browser-verifier');
      const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'browser-state', code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid' });
      const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
      expect(started.statusCode).toBe(200);
      expect(started.body).toContain('Sign in to Aeolus');
      const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';
      const browser = cookieOf(started, 'aeolus_sign_in_browser');

      // When the local credential form is submitted by the initiating browser.
      const signed = await app.server.inject({ method: 'POST', url: '/sign-in', ...form({ flow, email: 'maya@example.test', password: aSetup().input.password }), headers: { ...form({}).headers, cookie: browser, origin } });
      expect(signed.statusCode).toBe(303);
      const callback = new URL(String(signed.headers.location));
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get('state')).toBe('browser-state');
      const sharedCookie = cookieOf(signed, 'aeolus_account_session');
      expect(String(signed.headers['set-cookie'])).toContain('Domain=example.test; Path=/; HttpOnly; Secure; SameSite=Lax');
      const codeForm = { ...form({ grant_type: 'authorization_code', client_id: client.id, client_secret: client.secret, code: callback.searchParams.get('code') ?? '', redirect_uri: redirectUri, code_verifier: 'browser-verifier' }) };
      expect((await app.server.inject({ method: 'POST', url: '/oauth/token', ...codeForm })).statusCode).toBe(200);
      expect((await app.server.inject({ method: 'POST', url: '/oauth/token', ...codeForm })).json()).toMatchObject({ error: 'invalid_grant' });
      const shared = sharedCookie.slice('aeolus_account_session='.length);
      const exchanged = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token_type: 'urn:aeolus:params:oauth:token-type:sign-in', subject_token: shared, resource: aSetup().input.fleetId, client_id: client.id, client_secret: client.secret }) });

      // Then public keys verify the exact account/person claims; no server secret crosses the browser boundary.
      expect(exchanged.statusCode).toBe(200);
      const token = z.object({ access_token: z.string(), expires_in: z.literal(600) }).parse(exchanged.json());
      const keys = await app.server.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      const verified = await jwtVerify(token.access_token, createLocalJWKSet(z.object({ keys: z.array(z.object({ kty: z.string() }).catchall(z.unknown())) }).parse(keys.json<unknown>())), { issuer: origin, audience: aSetup().input.fleetId, typ: 'at+jwt' });
      expect(accountTokenClaimsSchema.parse(verified.payload)).toMatchObject({ personShipId: 'shp_00000000000000000000000001', isArgoAllowed: false });
      expect(keys.body).not.toContain('"d":');
      expect(signed.body + started.body + keys.body).not.toContain(client.secret);
      expect(signed.body).not.toContain(aSetup().input.password);
      const apps = await app.server.inject({ method: 'GET', url: '/api/apps', headers: { authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`, 'aeolus-sign-in': shared } });
      expect(apps.json()).toMatchObject({ account: { email: 'maya@example.test', firstName: 'Maya' }, fleets: [{ id: aSetup().input.fleetId, name: 'workshop' }] });
    } finally { await app.server.close(); }
  });

  it('refuses an unregistered callback, another browser, invalid client and unsigned sign-in attempts', async () => {
    // Given a real configured service and a browser flow.
    const { app, secrets } = await serviceOfMaya();
    try {
      const base = { response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'browser-state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' };
      const badCallback = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://attacker.example/callback' }).toString()}` });
      expect(badCallback.statusCode).toBe(400);
      expect(badCallback.headers.location).toBeUndefined();
      const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(base).toString()}` });
      const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';

      // When a different browser submits credentials, or a server exchange has wrong client credentials.
      const other = await app.server.inject({ method: 'POST', url: '/sign-in', ...form({ flow, email: 'maya@example.test', password: aSetup().input.password }), headers: { ...form({}).headers, cookie: 'aeolus_sign_in_browser=another-browser', origin } });
      const invalidClient = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', client_id: client.id, client_secret: 'wrong' }) });

      // Then no shared cookie or redirect is granted, and no password hash or secret is disclosed.
      expect(other.statusCode).toBe(400);
      expect(cookieOf(other, 'aeolus_account_session')).toBe('');
      expect(invalidClient.json()).toEqual({ error: 'invalid_client' });
      expect((await app.server.inject({ method: 'POST', url: '/sign-in', ...form({ email: 'maya@example.test', password: aSetup().input.password }) })).statusCode).toBe(400);
      expect(other.body + invalidClient.body).not.toContain('passwordHash');
    } finally { await app.server.close(); }
  });
});
