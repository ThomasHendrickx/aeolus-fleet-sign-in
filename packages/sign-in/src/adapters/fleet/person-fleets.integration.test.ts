/** The service reaches released core over public APIs and converges on its person commission key. */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { installationFleetsCreateOutputSchema, fleetListOutputSchema, commissionShipOutputSchema, registerOutputSchema } from '@aeolus-fleet/common';
import { createApp } from '@aeolus-fleet/core/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createCoreCleanup } from './core-cleanup.js';
import { createPersonFleets } from './person-fleets.js';
import { acknowledged, personShipFound } from '../../../test/support/cleanup-outcomes.js';
import { cleanupTargetIdSchema } from '../../core/shared/identity.js';

const run = promisify(execFile);
const token = 'test-installation-token-not-a-deployment-secret';

describe('the released core person lifecycle', () => {
  it('preserves the person, releases only owned trierarchs across pages and keeps one-use argo recovery independent', async () => {
    // Given a fresh released core installation with one existing fleet.
    const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    const require = createRequire(import.meta.url);
    const packageEntry = require.resolve('@aeolus-fleet/core');
    const executable = new URL('./bin/aeolus-core.js', `file://${packageEntry}`).pathname;
    const databaseUrl = postgres.getConnectionUri();
    let core: ReturnType<typeof createApp> | undefined;
    try {
      await run(process.execPath, [executable, 'migrate'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
      core = createApp({ databaseUrl, publicUrl: 'https://core.example.test', installationToken: token, logger: false });
      const url = await core.listen({ host: '127.0.0.1', port: 0 });
      const made = await fetch(`${url}/trpc/installation.fleets.create`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': token }, body: JSON.stringify({ requestId: 'workshop-setup', name: 'workshop', operatorEmail: 'operator@example.test' }) });
      const fleet = z.object({ result: z.object({ data: installationFleetsCreateOutputSchema }) }).parse(await made.json()).result.data;
      const adapter = createPersonFleets({ url, installationToken: token });

      // When the same account is provisioned twice, including after recreating the adapter.
      const input = { accountId: aSetup().secrets.accountId(), fleetId: fleet.fleetId };
      const first = rightOf(await adapter.reconcile(input));
      const retried = rightOf(await createPersonFleets({ url, installationToken: token }).reconcile(input));

      // Then it is the same person, with fleet-manager rights, and bad installation credentials never admit access.
      expect(retried.personShipId).toBe(first.personShipId);
      expect(first.scopes).toContain('fleet:commission');
      expect(first.scopes).toContain('fleet:person');
      expect(first.groupValues).toEqual(['fleet-manager']);
      expect(first.isFleetManager).toBe(true);
      expect(await createPersonFleets({ url, installationToken: 'wrong' }).reconcile(input)).toEqual({ kind: 'installationRefused' });

      // Given owned trierarch app ships across more than one cleanup page, plus an ordinary agent.
      if (first.personShipId === null) throw new Error('Expected person mapping');
      let actorHeaders: Record<string, string> = { 'x-aeolus-installation-token': token, 'aeolus-fleet': fleet.fleetId };
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...actorHeaders }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Fixture ${path} refused (${response.status}): ${await response.text()}`);
        const data: unknown = await response.json();
        return path.startsWith('/trpc/') ? z.object({ result: z.object({ data: z.unknown() }) }).parse(data).result.data : data;
      };
      const ticket = z.object({ ticket: z.string() }).parse(await post('/trpc/installation.operators.issueSignInTicket', { fleetId: fleet.fleetId })).ticket;
      const redeemed = await fetch(`${url}/trpc/console.redeemSignInTicket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
      actorHeaders = { origin: 'https://core.example.test', cookie: redeemed.headers.get('set-cookie')?.split(';')[0] ?? '' };
      const personPrompt = z.object({ secret: z.string() }).parse(await post('/trpc/fleet.getStartingPrompt', { shipId: first.personShipId }));
      const personToken = registerOutputSchema.parse(await post('/api/v1/ship/register', { shipId: first.personShipId, secret: personPrompt.secret, location: { kind: 'SERVER' } })).crewToken;
      const gatewayShip = commissionShipOutputSchema.parse(await post('/trpc/fleet.commission', { name: 'gateway', type: 'gateway', kind: 'app', owner: first.personShipId, scopes: ['fleet:commission', 'fleet:on-behalf'], idempotencyKey: 'gateway' }));
      const gatewayToken = registerOutputSchema.parse(await post('/api/v1/ship/register', { shipId: gatewayShip.shipId, secret: gatewayShip.secret, location: { kind: 'SERVER' } })).crewToken;
      actorHeaders = { authorization: `Bearer ${gatewayToken}` };
      let trierarchToken = '';
      for (let index = 0; index < 21; index += 1) {
        const ship = commissionShipOutputSchema.parse(await post('/trpc/fleet.commission', { name: `computer-${index.toString().padStart(2, '0')}`, type: 'trierarch', kind: 'app', owner: first.personShipId, idempotencyKey: `computer-${index}` }));
        if (index === 0) trierarchToken = registerOutputSchema.parse(await post('/api/v1/ship/register', { shipId: ship.shipId, secret: ship.secret, location: { kind: 'SERVER' } })).crewToken;
      }
      const agent = commissionShipOutputSchema.parse(await post('/trpc/fleet.commission', { name: 'researcher', type: 'researcher', ownerOf: first.personShipId, idempotencyKey: 'researcher' }));
      const agentToken = registerOutputSchema.parse(await post('/api/v1/ship/register', { shipId: agent.shipId, secret: agent.secret, location: { kind: 'SERVER' } })).crewToken;

      // When durable removal reconciles a bounded page, then resumes at its saved cursor.
      const cleanup = createCoreCleanup({ url, installationToken: token, log: () => undefined });
      const target = { id: cleanupTargetIdSchema.parse('removal'), attempts: 0, cursor: null, ...input, personShipId: first.personShipId, shouldReleaseOwnedTrierarchs: true };
      expect(await cleanup.acknowledge({ ...target, kind: 'fleet', personShipId: null })).toEqual(personShipFound(first.personShipId));
      expect(await cleanup.acknowledge({ ...target, kind: 'cutOff', fleetId: null })).toEqual(acknowledged);
      const firstPage = await cleanup.acknowledge({ ...target, kind: 'fleet' });
      if (!firstPage.isOk || firstPage.value.kind !== 'pageReleased') throw new Error('Expected another cleanup page');
      expect(await cleanup.acknowledge({ ...target, cursor: firstPage.value.cursor, kind: 'fleet' })).toEqual(acknowledged);
      expect(await cleanup.acknowledge({ ...target, cursor: firstPage.value.cursor, kind: 'fleet' })).toEqual(acknowledged);
      expect((await fetch(`${url}/api/v1/ship/whoami`, { headers: { authorization: `Bearer ${personToken}` } })).status).toBe(401);
      expect((await fetch(`${url}/api/v1/ship/whoami`, { headers: { authorization: `Bearer ${trierarchToken}` } })).status).toBe(401);
      expect((await fetch(`${url}/api/v1/ship/whoami`, { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(200);
      const listed = await fetch(`${url}/trpc/fleet.list?input=${encodeURIComponent(JSON.stringify({ shipIds: [first.personShipId] }))}`, { headers: { 'x-aeolus-installation-token': token, 'aeolus-fleet': fleet.fleetId } });
      const page = z.object({ result: z.object({ data: fleetListOutputSchema }) }).parse(await listed.json()).result.data;
      const person = page.items.find((ship) => ship.id === first.personShipId);

      // Independent server recovery still issues a one-use argo link without an account issuer.
      const recovery = await run(process.execPath, [executable, 'sign-in'], { env: { ...process.env, DATABASE_URL: databaseUrl, PUBLIC_URL: 'https://core.example.test' } });
      const link = /https?:\/\/\S+/.exec(recovery.stdout)?.[0];
      if (link === undefined) throw new Error('Expected a private recovery link');
      const recoveryTicket = new URL(link).searchParams.get('ticket');
      const redeem = () => fetch(`${url}/trpc/console.redeemSignInTicket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: recoveryTicket }) });
      expect((await redeem()).status).toBe(200);
      expect((await redeem()).status).not.toBe(200);

      // Then removal preserved the same ship and owner, while clearing its group reach.
      expect(person).toMatchObject({ id: first.personShipId, ownerShipId: first.personShipId, labels: [] });

    } finally {
      await core?.close();
      await postgres.stop();
    }
  }, 120_000);
});

function rightOf(reconciled: Awaited<ReturnType<ReturnType<typeof createPersonFleets>['reconcile']>>) {
  if (reconciled.kind !== 'reconciled') throw new Error('Core refused the installation');
  return reconciled.right;
}
