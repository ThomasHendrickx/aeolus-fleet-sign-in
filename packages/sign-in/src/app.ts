/** Wires pure identity use cases to the existing console and gateway HTTP contract. */
import { readFile } from 'node:fs/promises';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createOpenableFleets } from './core/accounts/openable-fleets.js';
import { createSetup } from './core/accounts/setup.js';
import { createAccountToken } from './core/account-tokens/account-token.js';
import { createSignIn } from './core/sign-in/sign-in.js';
import type { Identity, PersonFleets } from './core/shared/identity.js';
import { serviceConfigSchema, type ServiceConfig } from './config.js';
import type { createSecrets } from './adapters/crypto/secrets.js';
import type { createSigner } from './adapters/crypto/signer.js';
import { clientOf } from './adapters/http/client-authentication.js';
import { tokenRequestOf } from './adapters/http/token-request.js';
import { credentialPage, refusalPage, signInStyles } from './adapters/http/pages.js';

const sharedCookie = 'aeolus_account_session';
const browserCookie = 'aeolus_sign_in_browser';
/** The browser-binding cookie lives as long as a sign-in flow: 10 minutes. */
const BROWSER_BINDING_SECONDS = 600;
const BODY_LIMIT_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 15_000;
const authorizeSchema = z.object({ response_type: z.literal('code'), client_id: z.string(), redirect_uri: z.url(), state: z.string().min(1).max(1024), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') });
const credentialSchema = z.object({ flow: z.string().min(1).max(256), email: z.email().max(320), password: z.string().min(1).max(1024) });
const revokeRequestSchema = z.object({ token: z.string().min(1).max(4096) });
const script = await readFile(new URL('./adapters/http/assets/sign-in.js', import.meta.url), 'utf8');

export function createService(deps: { identity: Identity; fleet: PersonFleets; secrets: ReturnType<typeof createSecrets>; signer: ReturnType<typeof createSigner>; config: ServiceConfig; now: () => number }) {
  const config = serviceConfigSchema.parse(deps.config);
  const server = Fastify({ logger: false, trustProxy: config.trustedProxy ?? false, bodyLimit: BODY_LIMIT_BYTES, requestTimeout: REQUEST_TIMEOUT_MS });
  const signIn = createSignIn(deps);
  const token = createAccountToken({ ...deps, issuer: config.origin, signIn });
  const setup = createSetup(deps);
  const openableFleets = createOpenableFleets({ identity: deps.identity, signIn });
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
    const browser = cookiesOf(request)[browserCookie] ?? deps.secrets.token();
    const authorized = await signIn.authorize({ clientId: client.id, redirectUri: client.redirectUri, state: input.state, codeChallenge: input.code_challenge, browser, signIn: cookiesOf(request)[sharedCookie] ?? null });
    if (authorized.kind === 'setupRequired') return reply.code(503).type('text/html').send(refusalPage({ heading: 'Sign-in is not ready', text: 'The person who runs this installation must finish setup on the server before you can sign in.' }));
    reply.header('set-cookie', cookie({ name: browserCookie, value: browser, seconds: BROWSER_BINDING_SECONDS }));
    if (authorized.kind === 'authorized') return reply.code(303).header('location', callbackOf(authorized)).send();
    return reply.type('text/html').send(credentialPage(authorized));
  });
  server.post('/sign-in', async (request, reply) => {
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).type('text/html').send(refusalPage({ heading: 'We couldn’t sign you in', text: 'Your sign-in didn’t go through. Sign in again.' }));
    const input = parsed.data;
    const submitted = await signIn.submitCredential({ ...input, browser: cookiesOf(request)[browserCookie] ?? null, isSameOrigin: request.headers.origin === config.origin, address: request.ip });
    if (submitted.kind === 'startAgain') return reply.code(400).type('text/html').send(refusalPage({ heading: 'We couldn’t sign you in', text: 'Your sign-in didn’t go through. Sign in again.' }));
    if (submitted.kind !== 'authorized') {
      const retryAt = submitted.kind === 'tooManyAttempts' ? submitted.retryAt : undefined;
      const message = retryAt === undefined ? 'Wrong email or password.' : `Too many attempts. Try again at ${new Date(retryAt).toISOString().slice(11, 16)} UTC. Sign-in is paused for 15 minutes.`;
      reply.code(retryAt === undefined ? 401 : 429);
      if (retryAt !== undefined) reply.header('retry-after', String(Math.ceil((retryAt - deps.now()) / 1000)));
      return request.headers.accept?.includes('application/json') ? { kind: submitted.kind, message, retryAt } : reply.type('text/html').send(credentialPage({ flow: input.flow, email: input.email, message, ...(retryAt === undefined ? {} : { retryAt }) }));
    }
    reply.header('set-cookie', cookie({ name: sharedCookie, value: submitted.signIn, domain: config.cookieDomain, seconds: Math.max(0, Math.floor((submitted.expiresAt - deps.now()) / 1000)) }));
    return request.headers.accept?.includes('application/json') ? { kind: 'authorized', redirect: callbackOf(submitted) } : reply.code(303).header('location', callbackOf(submitted)).send();
  });
  server.post('/oauth/token', async (request, reply) => {
    const authenticated = clientOf(request, config);
    if (authenticated === null) return reply.code(401).send({ error: 'invalid_client' });
    const tokenRequest = tokenRequestOf(request.body);
    switch (tokenRequest.kind) {
      case 'refused': return reply.code(400).send({ error: tokenRequest.error });
      case 'authorizationCode': {
        const redeemed = await signIn.redeem({ code: tokenRequest.code, clientId: authenticated.id, redirectUri: tokenRequest.redirectUri, verifier: tokenRequest.verifier });
        return redeemed.kind === 'redeemed' ? { token_type: 'Bearer' } : reply.code(400).send({ error: 'invalid_grant' });
      }
      case 'tokenExchange': {
        const exchanged = await token({ signIn: tokenRequest.signIn, fleetId: tokenRequest.fleetId });
        switch (exchanged.kind) {
          case 'token': return { access_token: exchanged.token, token_type: 'Bearer', expires_in: exchanged.expiresIn };
          case 'signedOut': return reply.code(400).send({ error: 'invalid_grant' });
          case 'noRights': return reply.code(400).send({ error: 'invalid_target' });
          case 'unavailable': return reply.code(503).send({ error: 'temporarily_unavailable' });
        }
      }
    }
  });
  server.get('/api/apps', async (request, reply) => {
    if (clientOf(request, config) === null) return reply.code(401).send({ error: 'invalid_client' });
    const openable = await openableFleets({ signIn: headerOf(request, 'aeolus-sign-in'), fleetIds: config.fleets.map((fleet) => fleet.id) });
    if (openable.kind === 'signedOut') return reply.code(401).send({ error: 'invalid_grant' });
    const { account } = openable;
    return { account: { id: account.id, email: account.email, firstName: account.displayName }, apps: [], fleets: config.fleets.filter((fleet) => openable.fleetIds.includes(fleet.id)).map((fleet) => ({ id: fleet.id, name: fleet.name, argo: false, apps: [{ app: 'console', url: fleet.consoleUrl }, { app: 'gateway', url: fleet.gatewayUrl }] })) };
  });
  server.post('/oauth/revoke', async (request, reply) => {
    if (clientOf(request, config) === null) return reply.code(401).send({ error: 'invalid_client' });
    const revoked = revokeRequestSchema.safeParse(request.body);
    if (!revoked.success) return reply.code(400).send({ error: 'invalid_request' });
    await signIn.revoke(revoked.data.token);
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
