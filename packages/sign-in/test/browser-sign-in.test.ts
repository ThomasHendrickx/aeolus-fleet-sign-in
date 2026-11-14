/** The public console/gateway wire contract uses browser binding, shared cookies and server-only secrets. */
import { generateKeyPairSync } from 'node:crypto';

import { accountTokenClaimsSchema } from '@aeolus-fleet/common';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createService } from '../src/app.js';
import { createSecrets } from '../src/adapters/crypto/secrets.js';
import { createSigner } from '../src/adapters/crypto/signer.js';
import { approvedNotice, noticeIn } from './support/approved-mockups.js';
import { aSetup, fleetOfMaya } from './support/setup-fixtures.js';
import { memoryIdentity } from './support/memory-identity.js';

const origin = 'https://signin.example.test';
const redirectUri = 'https://console.example.test/sign-in/done';
const client = { id: 'console', secret: 'fixture-client-secret', redirectUri };
const gatewayClient = { id: 'gateway', secret: 'fixture-gateway-secret', redirectUri: 'https://bridge.example.test/sign-in/done' };

async function serviceOfMaya(options: { shouldSetUp?: boolean; trustedProxy?: string; now?: () => number; isUnavailable?: () => boolean } = {}) {
  const { shouldSetUp = true, trustedProxy, now = () => Date.now(), isUnavailable = () => false } = options;
  const identity = memoryIdentity();
  const fleet = fleetOfMaya(identity);
  const real = createSecrets();
  const secrets = { ...real, verifyPassword: (input: { password: string; hash: string | null }) => isUnavailable() ? Promise.reject(new Error('Credential processing failed')) : real.verifyPassword(input) };
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createSigner({ activeKeyId: 'first', keys: [{ id: 'first', privateKey }] });
  const app = createService({ identity, fleet, secrets, signer, now, config: {
    origin, cookieDomain: 'example.test', ...(trustedProxy === undefined ? {} : { trustedProxy }), clients: [client, gatewayClient], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
  } });
  if (shouldSetUp) expect((await app.setup.establish(aSetup().input)).kind).toBe('ready');
  return { app, secrets, signer, identity };
}

function form(fields: Record<string, string>) { return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() }; }

function basicOf(registered: { id: string; secret: string }) { return `Basic ${Buffer.from(`${registered.id}:${registered.secret}`).toString('base64')}`; }

async function codeFor(app: Awaited<ReturnType<typeof serviceOfMaya>>['app'], input: { registered: { id: string; redirectUri: string }; challenge: string }) {
  const query = new URLSearchParams({ response_type: 'code', client_id: input.registered.id, redirect_uri: input.registered.redirectUri, state: 'browser-state', code_challenge: input.challenge, code_challenge_method: 'S256' });
  const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
  const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';
  const signed = await app.server.inject({ method: 'POST', url: '/sign-in', ...form({ flow, email: 'maya@example.test', password: aSetup().input.password }), headers: { ...form({}).headers, cookie: cookieOf(started, 'aeolus_sign_in_browser'), origin } });
  return new URL(String(signed.headers.location)).searchParams.get('code') ?? '';
}

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

  it.each([undefined, '127.0.0.1'])('counts addresses through configured trusted proxies only (%s)', async (trustedProxy) => {
    // Given one HTTPS proxy and the approved per-address limit.
    const { app, secrets } = await serviceOfMaya(trustedProxy === undefined ? {} : { trustedProxy });
    try {
      const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
      const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';
      const browser = cookieOf(started, 'aeolus_sign_in_browser');
      for (let index = 0; index < 20; index += 1) await app.server.inject({ method: 'POST', url: '/sign-in', remoteAddress: '127.0.0.1', ...form({ flow, email: `unknown-${index}@example.test`, password: 'wrong' }), headers: { ...form({}).headers, cookie: browser, origin, 'x-forwarded-for': '203.0.113.1' } });

      // When another forwarded address presents Maya's correct credential.
      const result = await app.server.inject({ method: 'POST', url: '/sign-in', remoteAddress: '127.0.0.1', ...form({ flow, email: 'maya@example.test', password: aSetup().input.password }), headers: { ...form({}).headers, cookie: browser, origin, 'x-forwarded-for': '203.0.113.2' } });

      // Then only an explicitly trusted proxy may supply that different address.
      expect(result.statusCode).toBe(trustedProxy === undefined ? 429 : 303);
    } finally { await app.server.close(); }
  });

  it('shows setup required to a public browser before trusted setup, without offering public signup', async () => {
    // Given a configured service whose trusted setup has not run.
    const { app, secrets } = await serviceOfMaya({ shouldSetUp: false });
    try {
      // When the first public browser arrives.
      const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      const result = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });

      // Then it cannot claim the installation or submit a first-account password.
      expect(result.statusCode).toBe(503);
      expect(result.body).toContain('Sign-in is not ready');
      expect(result.body).not.toContain('type="password"');
      expect((await app.server.inject({ method: 'POST', url: '/setup' })).statusCode).toBe(404);
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

  it('redeems a code only for the client that authenticated, by Basic or form credentials', async () => {
    // Given a code issued to the gateway client and the gateway's verifier.
    const { app, secrets } = await serviceOfMaya();
    try {
      const challenge = await secrets.digest('gateway-verifier');
      const codes = { gateway: [await codeFor(app, { registered: gatewayClient, challenge }), await codeFor(app, { registered: gatewayClient, challenge })], console: [await codeFor(app, { registered: client, challenge }), await codeFor(app, { registered: client, challenge })] };
      const redemption = (code: string, registered: { redirectUri: string }) => ({ grant_type: 'authorization_code', code, redirect_uri: registered.redirectUri, code_verifier: 'gateway-verifier' });

      // When another client presents each code, then its owner does: by Basic without client_id, and by form credentials.
      const byConsole = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form({ ...redemption(codes.gateway[0] ?? '', gatewayClient), client_id: gatewayClient.id }), headers: { ...form({}).headers, authorization: basicOf(client) } });
      const byGateway = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form(redemption(codes.gateway[1] ?? '', gatewayClient)), headers: { ...form({}).headers, authorization: basicOf(gatewayClient) } });
      const byGatewayForm = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form({ ...redemption(codes.console[0] ?? '', client), client_id: gatewayClient.id, client_secret: gatewayClient.secret }) });
      const byConsoleForm = await app.server.inject({ method: 'POST', url: '/oauth/token', ...form({ ...redemption(codes.console[1] ?? '', client), client_id: client.id, client_secret: client.secret }) });

      // Then only the authenticated owner of each code redeems it.
      expect(byConsole.json()).toEqual({ error: 'invalid_grant' });
      expect(byGateway.statusCode).toBe(200);
      expect(byGatewayForm.json()).toEqual({ error: 'invalid_grant' });
      expect(byConsoleForm.statusCode).toBe(200);
    } finally { await app.server.close(); }
  });

  it.each(['expired', 'another browser', 'no Origin'] as const)('shows the start-again page without script for a flow from %s', async (refusal) => {
    // Given a credential page whose flow is then refused.
    const clock = { now: Date.now() };
    const { app, secrets } = await serviceOfMaya({ now: () => clock.now });
    try {
      const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'browser-state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
      const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';
      if (refusal === 'expired') clock.now += 10 * 60 * 1000;
      const browser = refusal === 'another browser' ? 'aeolus_sign_in_browser=another-browser' : cookieOf(started, 'aeolus_sign_in_browser');

      // When the form posts Maya's correct credential.
      const result = await app.server.inject({ method: 'POST', url: '/sign-in', ...form({ flow, email: 'maya@example.test', password: aSetup().input.password }), headers: { ...form({}).headers, cookie: browser, ...(refusal === 'no Origin' ? {} : { origin }) } });

      // Then the page starts again at the console that began the flow.
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('We couldn’t sign you in');
      expect(result.body).toContain('Your sign-in didn’t go through. Sign in again.');
      expect(result.body).toMatch(/<a [^>]*href="https:\/\/console\.example\.test\/"[^>]*>Sign in again<\/a>/);
    } finally { await app.server.close(); }
  });
  describe('approved credential refusals without script', () => {
    async function credentialPageOf(app: Awaited<ReturnType<typeof serviceOfMaya>>['app'], challenge: string) {
      const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'browser-state', code_challenge: challenge, code_challenge_method: 'S256' });
      const started = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
      const flow = /name="flow" value="([^"]+)"/.exec(started.body)?.[1] ?? '';
      const browser = cookieOf(started, 'aeolus_sign_in_browser');
      return (password: string) => app.server.inject({ method: 'POST', url: '/sign-in', ...form({ flow, email: 'maya@example.test', password }), headers: { ...form({}).headers, cookie: browser, origin } });
    }

    it('shows scene 04, the wrong-credential notice with its alert icon', async () => {
      // Given Maya's credential page.
      const { app, secrets } = await serviceOfMaya();
      try {
        const submit = await credentialPageOf(app, await secrets.digest('verifier'));

        // When she submits a wrong password.
        const refused = await submit('wrong');

        // Then the page shows the approved notice.
        expect(refused.statusCode).toBe(401);
        expect(noticeIn(refused.body)).toBe(approvedNotice('04-wrong-credential'));
      } finally { await app.server.close(); }
    });

    it('shows scene 05, the paused notice with its timer icon and a disabled-looking button', async () => {
      // Given server time 14:30 and four failed attempts on Maya's account.
      const { app, secrets } = await serviceOfMaya({ now: () => Date.UTC(2026, 10, 14, 14, 30) });
      try {
        const submit = await credentialPageOf(app, await secrets.digest('verifier'));
        for (let count = 0; count < 4; count += 1) await submit('wrong');

        // When the fifth failure reaches the limit.
        const paused = await submit('wrong');

        // Then the page shows the approved two-line notice and a disabled button in the approved disabled style.
        expect(paused.statusCode).toBe(429);
        expect(noticeIn(paused.body)).toBe(approvedNotice('05-too-many-attempts'));
        expect(paused.body).toMatch(/<button [^>]*data-testid="sign-in-submit"[^>]*\bdata-disabled=""[^>]*\bdisabled[^>]*>/);
        expect(paused.body).toContain('data-disabled:not-data-loading:opacity-45');
      } finally { await app.server.close(); }
    });

    it('shows scene 23, the credential form with the two-line unavailable notice', async () => {
      // Given Maya's credential page and credential processing that then fails.
      const state = { isUnavailable: false };
      const { app, secrets } = await serviceOfMaya({ isUnavailable: () => state.isUnavailable });
      try {
        const submit = await credentialPageOf(app, await secrets.digest('verifier'));
        state.isUnavailable = true;

        // When she submits her credential.
        const unavailable = await submit(aSetup().input.password);

        // Then she keeps the form and her email, with the approved notice, not another page.
        expect(unavailable.statusCode).toBe(503);
        expect(noticeIn(unavailable.body)).toBe(approvedNotice('23-credential-unavailable'));
        expect(unavailable.body).toContain('data-testid="sign-in-form"');
        expect(unavailable.body).toContain('value="maya@example.test"');
      } finally { await app.server.close(); }
    });

    it('shows scene 11 with its Try again button back to the same sign-in', async () => {
      // Given a service whose trusted setup has not run.
      const { app, secrets } = await serviceOfMaya({ shouldSetUp: false });
      try {
        const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state: 'state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' }).toString()}`;

        // When a browser arrives.
        const result = await app.server.inject({ method: 'GET', url });

        // Then the approved refusal offers Try again on the same request.
        expect(result.body).toContain('Sign-in is not ready');
        const tryAgain = /<a [^>]*href="([^"]+)"[^>]*>Try again<\/a>/.exec(result.body)?.[1];
        expect(tryAgain?.replaceAll('&amp;', '&')).toBe(url);
      } finally { await app.server.close(); }
    });
  });
});
