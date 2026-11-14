/** Actual sign-in HTTPS, released core and separate Postgres databases prove the service-to-agent identity path. */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { commissionShipOutputSchema, installationFleetsCreateOutputSchema, receiveOutputSchema, registerOutputSchema, sendOutputSchema, whoamiOutputSchema } from '@aeolus-fleet/common';
import { createApp } from '@aeolus-fleet/core/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createService } from '../src/app.js';
import { createSecrets } from '../src/adapters/crypto/secrets.js';
import { createSigner } from '../src/adapters/crypto/signer.js';
import { createPersonFleets } from '../src/adapters/fleet/person-fleets.js';
import { openIdentity } from '../src/adapters/prisma/identity.js';

const run = promisify(execFile);
const installationToken = 'installation-fixture-only';
const json = { 'content-type': 'application/json' };

async function post(url: string, input: { headers?: Record<string, string>; body: unknown }) {
  const response = await fetch(url, { method: 'POST', headers: { ...json, ...input.headers }, body: JSON.stringify(input.body) });
  if (!response.ok) throw new Error(`Test boundary refused HTTP ${response.status}: ${await response.text()}`);
  const body: unknown = await response.json();
  return body;
}

describe('the first person owns and answers the same agent', () => {
  it('uses the real HTTPS sign-in issuer to commission once, crew researcher and answer its owner question as the stable person', async () => {
    // Given fresh separate core/sign-in databases and a trusted local HTTPS sibling deployment.
    const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    const directory = await mkdtemp(join(tmpdir(), 'aeolus-sign-in-journey-'));
    const previousDispatcher = getGlobalDispatcher();
    let dispatcher: Agent | undefined;
    let core: ReturnType<typeof createApp> | undefined;
    let service: ReturnType<typeof createService> | undefined;
    let database: Awaited<ReturnType<typeof openIdentity>> | undefined;
    let https: ReturnType<typeof createServer> | undefined;
    try {
      const keyFile = join(directory, 'https-key.pem');
      const certificateFile = join(directory, 'https-certificate.pem');
      await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=signin.example.test', '-addext', 'subjectAltName=DNS:signin.example.test', '-keyout', keyFile, '-out', certificateFile]);
      const certificate = await readFile(certificateFile, 'utf8');
      dispatcher = new Agent({ connect: { autoSelectFamily: false, ca: certificate, lookup: (...args) => { args[2](null, '127.0.0.1', 4); } } });
      setGlobalDispatcher(dispatcher);
      https = createServer({ key: await readFile(keyFile, 'utf8'), cert: certificate }, (request, response) => {
        const chunks: string[] = [];
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { chunks.push(chunk); });
        request.on('end', () => {
          if (service === undefined) { response.writeHead(503).end(); return; }
          void service.server.inject({ method: z.enum(['GET', 'POST']).parse(request.method), url: request.url ?? '/', headers: request.headers, ...(chunks.length === 0 ? {} : { payload: chunks.join('') }) }).then((result) => { response.writeHead(result.statusCode, result.headers).end(result.body); }).catch(() => { response.writeHead(503).end(); });
        });
      });
      await new Promise<undefined>((resolve) => { https?.listen(0, '127.0.0.1', () => { resolve(undefined); }); });
      const address = https.address();
      if (address === null || typeof address === 'string') throw new Error('HTTPS test boundary did not listen');
      const origin = `https://signin.example.test:${address.port}`;
      const coreEntry = createRequire(import.meta.url).resolve('@aeolus-fleet/core');
      await run(process.execPath, [new URL('./bin/aeolus-core.js', `file://${coreEntry}`).pathname, 'migrate'], { env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() } });
      await postgres.exec(['psql', '-U', postgres.getUsername(), '-d', postgres.getDatabase(), '-c', 'CREATE DATABASE sign_in_identity']);
      const identityUrl = new URL(postgres.getConnectionUri());
      identityUrl.pathname = '/sign_in_identity';
      database = await openIdentity(identityUrl.toString());
      core = createApp({ databaseUrl: postgres.getConnectionUri(), publicUrl: 'https://core.example.test', accountTokenIssuer: origin, installationToken, logger: false, receiveWaitMs: 50 });
      const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
      const made = await post(`${coreUrl}/trpc/installation.fleets.create`, { headers: { 'x-aeolus-installation-token': installationToken }, body: { requestId: 'existing-workshop', name: 'workshop', operatorEmail: 'operator@example.test' } });
      const fleet = z.object({ result: z.object({ data: installationFleetsCreateOutputSchema }) }).parse(made).result.data;
      const secrets = createSecrets();
      const { privateKey } = generateKeyPairSync('ed25519');
      service = createService({ identity: database.identity, fleet: createPersonFleets({ url: coreUrl, installationToken }), secrets, signer: createSigner({ activeKeyId: 'journey', keys: [{ id: 'journey', privateKey }] }), now: () => Date.now(), config: {
        origin, cookieDomain: 'example.test', clients: [{ id: 'console', secret: 'client-fixture', redirectUri: 'https://console.example.test/sign-in/done' }], fleets: [{ id: fleet.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
      } });
      const setupInput = { fleetId: fleet.fleetId, email: 'maya@example.test', displayName: 'Maya', password: 'journey-password-fixture' };
      const first = await service.setup.establish(setupInput);
      expect(first.kind).toBe('ready');
      if (first.kind !== 'ready' || first.personShipId === null) throw new Error('Setup did not resolve Maya');
      expect(await service.setup.establish(setupInput)).toEqual(first);
      const shared = await service.signIn.authenticate({ email: setupInput.email, password: setupInput.password, address: 'local-test' });
      if (shared.kind !== 'authenticated') throw new Error('Expected Maya authentication');
      const exchanged = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token_type: 'urn:aeolus:params:oauth:token-type:sign-in', subject_token: shared.signIn, resource: fleet.fleetId, client_id: 'console', client_secret: 'client-fixture' }) });
      expect(exchanged.status).toBe(200);
      const account = z.object({ access_token: z.string() }).parse(await exchanged.json());
      const accountHeaders = { 'aeolus-account-token': account.access_token };

      // When Maya commissions researcher with one key and crews it, then answers its owner question.
      const commission = { name: 'researcher', type: 'researcher', idempotencyKey: 'maya-first-agent' };
      const agent = commissionShipOutputSchema.parse(await post(`${coreUrl}/api/v1/fleet/commission`, { headers: accountHeaders, body: commission }));
      const retry = commissionShipOutputSchema.parse(await post(`${coreUrl}/api/v1/fleet/commission`, { headers: accountHeaders, body: commission }));
      const agentCrew = registerOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/register`, { body: { shipId: agent.shipId, secret: agent.secret, location: { kind: 'SERVER' }, harness: 'codex' } }));
      const agentHeaders = { authorization: `Bearer ${agentCrew.crewToken}` };
      const who = await fetch(`${coreUrl}/api/v1/ship/whoami`, { headers: agentHeaders });
      const personPrompt = z.object({ result: z.object({ data: z.object({ secret: z.string() }) }) }).parse(await post(`${coreUrl}/trpc/fleet.getStartingPrompt`, { headers: accountHeaders, body: { shipId: first.personShipId } })).result.data;
      const personCrew = registerOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/register`, { body: { shipId: first.personShipId, secret: personPrompt.secret, location: { kind: 'SERVER' } } }));
      const personHeaders = { authorization: `Bearer ${personCrew.crewToken}` };
      const questionId = '4b9eafc9-5795-42fb-9321-f3eeb8ece2da';
      const question = sendOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/ask`, { headers: agentHeaders, body: { selector: { kind: 'ship', shipId: first.personShipId }, id: questionId, title: 'Release the research?', context: 'The report is ready.', options: [{ key: 1, label: 'Release' }], pick: { option: 1, why: 'The report is ready.' }, model: 'gpt-6.1-sol', idempotencyKey: 'research-question' } }));
      const delivered = receiveOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/receive`, { headers: personHeaders, body: { max: 10 } })).deliveries[0];
      if (delivered === undefined) throw new Error('Owner did not receive the question');
      await post(`${coreUrl}/api/v1/ship/ack`, { headers: personHeaders, body: { deliveryId: delivered.deliveryId } });
      const answerInput = { selector: { kind: 'ship', shipId: agent.shipId }, contentType: 'application/vnd.aeolus.answer+json', payload: JSON.stringify({ questionId, option: 1 }), inReplyTo: question.messageId, idempotencyKey: 'maya-answer' };
      const answer = sendOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/send`, { headers: personHeaders, body: answerInput }));
      const repeatedAnswer = sendOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/send`, { headers: personHeaders, body: answerInput }));
      const received = receiveOutputSchema.parse(await post(`${coreUrl}/api/v1/ship/receive`, { headers: agentHeaders, body: { max: 10 } })).deliveries[0];
      if (received === undefined) throw new Error('Agent did not receive the answer');
      await post(`${coreUrl}/api/v1/ship/ack`, { headers: agentHeaders, body: { deliveryId: received.deliveryId } });

      // Then retries duplicate neither identity nor agent nor answer; the same person owns and answers it.
      expect(retry.shipId).toBe(agent.shipId);
      expect(repeatedAnswer.messageId).toBe(answer.messageId);
      expect(whoamiOutputSchema.parse(await who.json()).ownerShipId).toBe(first.personShipId);
      expect(received).toMatchObject({ senderShipId: first.personShipId, inReplyTo: question.messageId, contentType: 'application/vnd.aeolus.answer+json', payload: JSON.stringify({ questionId, option: 1 }) });
    } finally {
      await dispatcher?.close();
      setGlobalDispatcher(previousDispatcher);
      await service?.server.close();
      await core?.close();
      await database?.close();
      https?.closeAllConnections();
      if (https !== undefined) await new Promise<undefined>((resolve) => { https?.close(() => { resolve(undefined); }); });
      await postgres.stop({ timeout: 30_000 });
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
