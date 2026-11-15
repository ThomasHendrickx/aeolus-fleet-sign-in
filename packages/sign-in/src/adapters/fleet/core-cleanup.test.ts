/** Core cleanup counts a person ship that is gone, or has nothing left to clear, as cleaned up. */
import { idSchema } from '@aeolus-fleet/common';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { acknowledged, unavailable } from '../../../test/support/cleanup-outcomes.js';
import { aSetup } from '../../../test/support/setup-fixtures.js';
import { cleanupTargetIdSchema, type CleanupTarget } from '../../core/shared/identity.js';
import { createCoreCleanup } from './core-cleanup.js';

const personShipId = idSchema('ship').parse('shp_00000000000000000000000001');

/** A core that lists the given person ships and no owned trierarchs, and records every release. */
async function aCore(people: readonly unknown[]) {
  const core = Fastify();
  const released: unknown[] = [];
  const logged: string[] = [];
  core.get<{ Querystring: { input: string } }>('/trpc/fleet.list', (request) => {
    const isPersonQuery = request.query.input.includes('shipIds');
    return { result: { data: { items: isPersonQuery ? people : [], nextCursor: null } } };
  });
  core.get('/trpc/fleet.labels', () => ({ result: { data: [] } }));
  core.post('/trpc/installation.accounts.cutOff', () => ({ result: { data: { unexpected: 'cut-off-answer' } } }));
  core.post('/trpc/fleet.release', (request) => { released.push(request.body); return { result: { data: {} } }; });
  const url = await core.listen({ host: '127.0.0.1', port: 0 });
  const { input, secrets } = aSetup();
  const target: CleanupTarget = { id: cleanupTargetIdSchema.parse('removal'), attempts: 0, cursor: null, kind: 'fleet', accountId: secrets.accountId(), fleetId: input.fleetId, personShipId, shouldReleaseOwnedTrierarchs: true };
  return { cleanup: createCoreCleanup({ url, installationToken: 'test-installation', log: (message) => { logged.push(message); } }), target, released, logged, close: () => core.close() };
}

describe('core person ship cleanup', () => {
  it('acknowledges a person ship that no longer exists in the fleet', async () => {
    // Given a core that no longer lists Maya's person ship.
    const core = await aCore([]);
    try {
      // When removal cleans up that person ship.
      const outcome = await core.cleanup.acknowledge(core.target);

      // Then the target counts as cleaned up.
      expect(outcome).toEqual(acknowledged);
    } finally { await core.close(); }
  });

  it('acknowledges a retired person ship that carries no labels to clear', async () => {
    // Given a core that lists Maya's person ship retired, without labels.
    const core = await aCore([{ id: personShipId, name: 'person-maya', type: 'person', status: 'retired', isInReadReach: false }]);
    try {
      // When removal cleans up that person ship.
      const outcome = await core.cleanup.acknowledge(core.target);

      // Then the target counts as cleaned up and nothing is released.
      expect(outcome).toEqual(acknowledged);
      expect(core.released).toEqual([]);
    } finally { await core.close(); }
  });

  it('logs an answer outside the cleanup contract with what was received and keeps the target pending', async () => {
    // Given a core whose cut-off answer does not match its contract.
    const core = await aCore([]);
    try {
      // When removal cuts off Maya's account.
      const outcome = await core.cleanup.acknowledge({ ...core.target, kind: 'cutOff', fleetId: null });

      // Then the target stays pending and the log names the procedure and what it received.
      expect(outcome).toEqual(unavailable);
      expect(core.logged).toHaveLength(1);
      expect(core.logged[0]).toContain('installation.accounts.cutOff');
      expect(core.logged[0]).toContain('cut-off-answer');
    } finally { await core.close(); }
  });
});
