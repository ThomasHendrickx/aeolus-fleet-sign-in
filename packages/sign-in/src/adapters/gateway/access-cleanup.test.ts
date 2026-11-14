/** The existing gateway installation procedure acknowledges cleanup, never a failed response. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { cleanupTargetIdSchema, type CleanupTarget } from '../../core/shared/identity.js';
import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createAccessCleanup } from './access-cleanup.js';
import { acknowledged, unavailable } from '../../../test/support/cleanup-outcomes.js';

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
    const target: CleanupTarget = { id: cleanupTargetIdSchema.parse('removal'), attempts: 0, cursor: null, kind: 'gateway', accountId: secrets.accountId(), fleetId: input.fleetId, personShipId: null, shouldReleaseOwnedTrierarchs: true };
    const cleanup = createAccessCleanup({ installationToken: 'test-installation', gateways: [{ id: input.fleetId, gatewayUrl: url }], core: { acknowledge: () => Promise.resolve(acknowledged) }, log: () => undefined });
    try {
      // When the same notification is retried, including after recreating the sender.
      expect(await cleanup.acknowledge(target)).toEqual(unavailable);
      shouldFail = false;
      expect(await cleanup.acknowledge(target)).toEqual(acknowledged);
      expect(await cleanup.acknowledge(target)).toEqual(acknowledged);

      // Then only the stable fleet/account pair is invalidated, and refused authentication never acknowledges.
      expect(invalidated).toEqual(new Set([JSON.stringify({ fleetId: input.fleetId, accountId: secrets.accountId() })]));
      expect(await createAccessCleanup({ installationToken: 'wrong', gateways: [{ id: input.fleetId, gatewayUrl: url }], core: { acknowledge: () => Promise.resolve(acknowledged) }, log: () => undefined }).acknowledge(target)).toEqual(unavailable);
    } finally { await gateway.close(); }
  });

  it('logs an acknowledgement outside the gateway contract with what was received and keeps the target pending', async () => {
    // Given a gateway whose answer does not match the acknowledgement contract.
    const gateway = Fastify();
    gateway.post('/trpc/installation.accountDisabled', () => ({ result: { data: { unexpected: 'gateway-answer' } } }));
    const url = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const { input, secrets } = aSetup();
    const target: CleanupTarget = { id: cleanupTargetIdSchema.parse('removal'), attempts: 0, cursor: null, kind: 'gateway', accountId: secrets.accountId(), fleetId: input.fleetId, personShipId: null, shouldReleaseOwnedTrierarchs: true };
    const logged: string[] = [];
    const cleanup = createAccessCleanup({ installationToken: 'test-installation', gateways: [{ id: input.fleetId, gatewayUrl: url }], core: { acknowledge: () => Promise.resolve(acknowledged) }, log: (message) => { logged.push(message); } });
    try {
      // When the gateway notification is sent.
      const outcome = await cleanup.acknowledge(target);

      // Then the target stays pending and the log names the procedure and what it received.
      expect(outcome).toEqual(unavailable);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('installation.accountDisabled');
      expect(logged[0]).toContain('gateway-answer');
    } finally { await gateway.close(); }
  });
});
