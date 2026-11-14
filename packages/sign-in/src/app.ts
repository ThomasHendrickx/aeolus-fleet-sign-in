/** Wires pure identity use cases to the existing console and gateway HTTP contract. */
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';

import { idSchema } from '@aeolus-fleet/common';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createSetup } from './core/accounts/setup.js';
import { createAccountToken } from './core/account-tokens/account-token.js';
import { createSignIn } from './core/sign-in/sign-in.js';
import type { Identity, PersonFleets } from './core/shared/identity.js';
import { serviceConfigSchema, type ServiceConfig } from './config.js';
import type { createSecrets } from './adapters/crypto/secrets.js';
import type { createSigner } from './adapters/crypto/signer.js';
import { credentialPage, refusalPage, signInStyles } from './adapters/http/pages.js';

const sharedCookie = 'aeolus_account_session';
const browserCookie = 'aeolus_sign_in_browser';
/** The browser-binding cookie lives as long as a sign-in flow: 10 minutes. */
const BROWSER_BINDING_SECONDS = 600;
const BODY_LIMIT_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 15_000;
const BASIC_PREFIX = 'Basic ';
const authorizeSchema = z.object({ response_type: z.literal('code'), client_id: z.string(), redirect_uri: z.url(), state: z.string().min(1).max(1024), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') });
const credentialSchema = z.object({ flow: z.string().min(1).max(256), email: z.email().max(320), password: z.string().min(1).max(1024) });
const fieldsSchema = z.record(z.string(), z.string());
const script = await readFile(new URL('./adapters/http/assets/sign-in.js', import.meta.url), 'utf8');

export function createService(deps: { identity: Identity; fleet: PersonFleets; secrets: ReturnType<typeof createSecrets>; signer: ReturnType<typeof createSigner>; config: ServiceConfig; now: () => number }) {
  const config = serviceConfigSchema.parse(deps.config);
  const server = Fastify({ logger: false, trustProxy: config.trustedProxy ?? false, bodyLimit: BODY_LIMIT_BYTES, requestTimeout: REQUEST_TIMEOUT_MS });
  const signIn = createSignIn(deps);
  const token = createAccountToken({ ...deps, issuer: config.origin, signIn });
  const setup = createSetup(deps);
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request: FastifyRequest, body: string) => Promise.resolve(Object.fromEntries(new URLSearchParams(body))));
  server.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; style-src 'self'; script-src 'self'; font-src data:; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  });
  server.setErrorHandler((...args) => {
    const [, request, reply] = args;
    const isForm = request.url === '/sign-in' && !request.headers.accept?.includes('application/json');
    if (isForm) return reply.code(503).type('text/html').send(refusalPage({ heading: 'Can’t reach the sign-in service', text: 'Nothing changed in the fleet. Try again in a moment.' }));
    return reply.code(503).send({ error: 'temporarily_unavailable', message: 'Sign-in is unavailable. Try again in a moment.' });
  });
  server.get('/health', () => Promise.resolve({ status: 'ok' }));
  server.get('/sign-in.css', async (_request, reply) => reply.type('text/css').send(signInStyles));
  server.get('/sign-in.js', async (_request, reply) => reply.type('text/javascript').send(script));
  server.get('/.well-known/jwks.json', () => Promise.resolve(deps.signer.publicKeys));
  server.get('/', async (_request, reply) => reply.type('text/html').send(refusalPage({ heading: 'Sign in to Aeolus', text: 'Open your console or Bridge to start signing in.' })));
  server.get('/oauth/authorize', async (request, reply) => {
    const parsed = authorizeSchema.safeParse(request.query);
    if (!parsed.success) return invalidConfiguration(reply);
    const input = parsed.data;
    const client = config.clients.find((candidate) => candidate.id === input.client_id && candidate.redirectUri === input.redirect_uri);
    if (client === undefined) return invalidConfiguration(reply);
    if (!await deps.identity.transaction((records) => records.hasAccounts())) return reply.code(503).type('text/html').send(refusalPage({ heading: 'Sign-in is not ready', text: 'The person who runs this installation must finish setup on the server before you can sign in.' }));
    const browser = cookiesOf(request)[browserCookie] ?? deps.secrets.token();
    reply.header('set-cookie', cookie({ name: browserCookie, value: browser, seconds: BROWSER_BINDING_SECONDS }));
    const flow = await signIn.begin({ clientId: client.id, redirectUri: client.redirectUri, state: input.state, codeChallenge: input.code_challenge, browser });
    const shared = cookiesOf(request)[sharedCookie];
    if (shared !== undefined) {
      const completed = await signIn.complete({ ...flow, browser, signIn: shared });
      if (completed.kind === 'authorized') return reply.code(303).header('location', callbackOf(completed)).send();
    }
    return reply.type('text/html').send(credentialPage(flow));
  });
  server.post('/sign-in', async (request, reply) => {
    const parsed = credentialSchema.safeParse(request.body);
    const browser = cookiesOf(request)[browserCookie];
    if (!parsed.success || browser === undefined || request.headers.origin !== config.origin || !await signIn.inspect({ flow: parsed.data.flow, browser })) return reply.code(400).type('text/html').send(refusalPage({ heading: 'We couldn’t sign you in', text: 'Your sign-in didn’t go through. Sign in again.' }));
    const input = parsed.data;
    const authenticated = await signIn.authenticate({ email: input.email, password: input.password, address: request.ip });
    if (authenticated.kind !== 'authenticated') {
      const retryAt = authenticated.kind === 'tooManyAttempts' ? authenticated.retryAt : undefined;
      const message = retryAt === undefined ? 'Wrong email or password.' : `Too many attempts. Try again at ${new Date(retryAt).toISOString().slice(11, 16)} UTC. Sign-in is paused for 15 minutes.`;
      reply.code(retryAt === undefined ? 401 : 429);
      if (retryAt !== undefined) reply.header('retry-after', String(Math.ceil((retryAt - deps.now()) / 1000)));
      return request.headers.accept?.includes('application/json') ? { kind: authenticated.kind, message, retryAt } : reply.type('text/html').send(credentialPage({ flow: input.flow, email: input.email, message, ...(retryAt === undefined ? {} : { retryAt }) }));
    }
    const completed = await signIn.complete({ flow: input.flow, browser, signIn: authenticated.signIn });
    if (completed.kind !== 'authorized') return reply.code(400).send({ error: 'invalid_grant' });
    reply.header('set-cookie', cookie({ name: sharedCookie, value: authenticated.signIn, domain: config.cookieDomain, seconds: Math.max(0, Math.floor((authenticated.expiresAt - deps.now()) / 1000)) }));
    return request.headers.accept?.includes('application/json') ? { kind: 'authorized', redirect: callbackOf(completed) } : reply.code(303).header('location', callbackOf(completed)).send();
  });
  server.post('/oauth/token', async (request, reply) => {
    const fields = fieldsSchema.safeParse(request.body);
    if (!fields.success || !clientOf(request, { config, fields: fields.data })) return reply.code(401).send({ error: 'invalid_client' });
    const form = fields.data;
    if (form.grant_type === 'authorization_code') {
      const redeemed = await signIn.redeem({ code: form.code ?? '', clientId: form.client_id ?? '', redirectUri: form.redirect_uri ?? '', verifier: form.code_verifier ?? '' });
      return redeemed.kind === 'redeemed' ? { token_type: 'Bearer' } : reply.code(400).send({ error: 'invalid_grant' });
    }
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange' || form.subject_token_type !== 'urn:aeolus:params:oauth:token-type:sign-in') return reply.code(400).send({ error: 'unsupported_grant_type' });
    const fleet = idSchema('fleet').safeParse(form.resource);
    if (!fleet.success) return reply.code(400).send({ error: 'invalid_target' });
    const exchanged = await token({ signIn: form.subject_token ?? '', fleetId: fleet.data });
    switch (exchanged.kind) {
      case 'token': return { access_token: exchanged.token, token_type: 'Bearer', expires_in: exchanged.expiresIn };
      case 'signedOut': return reply.code(400).send({ error: 'invalid_grant' });
      case 'noRights': return reply.code(400).send({ error: 'invalid_target' });
      case 'unavailable': return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  });
  server.get('/api/apps', async (request, reply) => {
    if (!clientOf(request, { config, fields: {} })) return reply.code(401).send({ error: 'invalid_client' });
    const shared = await signIn.account(headerOf(request, 'aeolus-sign-in'));
    if (shared.kind === 'signedOut') return reply.code(401).send({ error: 'invalid_grant' });
    const rights = await deps.identity.transaction((records) => Promise.all(config.fleets.map(async (fleet) => ({ fleet, right: await records.right({ accountId: shared.account.id, fleetId: fleet.id }) }))));
    return { account: { id: shared.account.id, email: shared.account.email, firstName: shared.account.displayName }, apps: [], fleets: rights.filter(({ right }) => right !== null && right.scopes.length > 0).map(({ fleet }) => ({ id: fleet.id, name: fleet.name, argo: false, apps: [{ app: 'console', url: fleet.consoleUrl }, { app: 'gateway', url: fleet.gatewayUrl }] })) };
  });
  server.post('/oauth/revoke', async (request, reply) => {
    const fields = fieldsSchema.safeParse(request.body);
    if (!fields.success || !clientOf(request, { config, fields: fields.data })) return reply.code(401).send({ error: 'invalid_client' });
    await signIn.revoke(fields.data.token ?? '');
    return {};
  });
  return { server, setup, signIn };
}

function headerOf(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function cookiesOf(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(headerOf(request, 'cookie').split(';').flatMap((part) => { const split = part.indexOf('='); return split < 0 ? [] : [[part.slice(0, split).trim(), part.slice(split + 1)]]; }));
}

function cookie(input: { name: string; value: string; seconds: number; domain?: string }): string {
  return `${input.name}=${input.value}; Max-Age=${input.seconds}; ${input.domain === undefined ? '' : `Domain=${input.domain}; `}Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function callbackOf(input: { redirectUri: string; state: string; code: string }): string {
  const url = new URL(input.redirectUri);
  url.searchParams.set('code', input.code);
  url.searchParams.set('state', input.state);
  return url.toString();
}

function invalidConfiguration(reply: FastifyReply) {
  return reply.code(400).type('text/html').send(refusalPage({ heading: 'Sign-in configuration needs attention', text: 'This sign-in cannot continue. Ask the person who runs this installation to check its settings.' }));
}

function clientOf(request: FastifyRequest, input: { config: ServiceConfig; fields: Record<string, string> }): boolean {
  let id = input.fields.client_id;
  let secret = input.fields.client_secret;
  const authorization = headerOf(request, 'authorization');
  if (authorization.startsWith(BASIC_PREFIX)) {
    const decoded = Buffer.from(authorization.slice(BASIC_PREFIX.length), 'base64').toString();
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    try { id = decodeURIComponent(decoded.slice(0, separator)); secret = decodeURIComponent(decoded.slice(separator + 1)); } catch { return false; }
  }
  const client = input.config.clients.find((candidate) => candidate.id === id);
  if (client === undefined || secret === undefined) return false;
  return timingSafeEqual(createHash('sha256').update(client.secret).digest(), createHash('sha256').update(secret).digest());
}
