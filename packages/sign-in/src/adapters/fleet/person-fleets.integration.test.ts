/** The service reaches released core over public APIs and converges on its person commission key. */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { installationFleetsCreateOutputSchema, fleetListOutputSchema } from '@aeolus-fleet/common';
import { createApp } from '@aeolus-fleet/core/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createCoreCleanup } from './core-cleanup.js';
import { createPersonFleets } from './person-fleets.js';

const run = promisify(execFile);
const token = 'test-installation-token-not-a-deployment-secret';

describe('the released core person lifecycle', () => {
  it('resolves the existing fleet, grants all offered scopes and retries the installation person commission without duplication', async () => {
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

      // When durable removal reconciles this person's fleet and installation cut-off twice.
      const cleanup = createCoreCleanup({ url, installationToken: token });
      const target = { id: 'removal', attempts: 0, ...input, personShipId: first.personShipId, shouldReleaseOwnedTrierarchs: true };
      expect(await cleanup.acknowledge({ ...target, kind: 'cutOff', fleetId: null })).toBe(true);
      expect(await cleanup.acknowledge({ ...target, kind: 'fleet' })).toBe(true);
      expect(await cleanup.acknowledge({ ...target, kind: 'fleet' })).toBe(true);
      const listed = await fetch(`${url}/trpc/fleet.list`, { headers: { 'x-aeolus-installation-token': token, 'aeolus-fleet': fleet.fleetId } });
      const page = z.object({ result: z.object({ data: fleetListOutputSchema }) }).parse(await listed.json()).result.data;
      const person = page.items.find((ship) => ship.id === first.personShipId);

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
