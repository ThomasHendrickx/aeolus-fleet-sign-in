/** The existing gateway installation procedure acknowledges cleanup, never a failed response. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { CleanupTarget } from '../../core/shared/identity.js';
import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createAccessCleanup } from './access-cleanup.js';

describe('gateway cleanup notification', () => {
  it('authenticates the existing per-fleet notification and retains work until a valid acknowledgement', async () => {
    // Given a gateway that is temporarily unavailable.
    const gateway = Fastify();
    const invalidated = new Set<string>();
    let shouldFail = true;
    gateway.post('/trpc/installation.accountDisabled', async (request, reply) => {
      if (request.headers['x-aeolus-installation-token'] !== 'test-installation') return reply.code(401).send({});
      if (shouldFail) return reply.code(503).send({});
      invalidated.add(JSON.stringify(request.body));
      return { result: { data: {} } };
    });
    const url = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const { input, secrets } = aSetup();
    const target: CleanupTarget = { id: 'removal', attempts: 0, cursor: null, kind: 'gateway', accountId: secrets.accountId(), fleetId: input.fleetId, personShipId: null, shouldReleaseOwnedTrierarchs: true };
    const cleanup = createAccessCleanup({ installationToken: 'test-installation', gateways: [{ id: input.fleetId, gatewayUrl: url }], core: { acknowledge: () => Promise.resolve(true) } });
    try {
      // When the same notification is retried, including after recreating the sender.
      expect(await cleanup.acknowledge(target)).toBe(false);
      shouldFail = false;
      expect(await cleanup.acknowledge(target)).toBe(true);
      expect(await cleanup.acknowledge(target)).toBe(true);

      // Then only the stable fleet/account pair is invalidated, and refused authentication never acknowledges.
      expect(invalidated).toEqual(new Set([JSON.stringify({ fleetId: input.fleetId, accountId: secrets.accountId() })]));
      expect(await createAccessCleanup({ installationToken: 'wrong', gateways: [{ id: input.fleetId, gatewayUrl: url }], core: { acknowledge: () => Promise.resolve(true) } }).acknowledge(target)).toBe(false);
    } finally { await gateway.close(); }
  });
});
