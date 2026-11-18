/** Expected core outages stay retryable; malformed answers and configuration defects surface. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createPersonFleets } from './person-fleets.js';

const input = { accountId: aSetup().secrets.accountId(), fleetId: aSetup().input.fleetId };

describe('person provisioning failure boundaries', () => {
  it.each([401, 403, 404, 429, 500, 503])('preserves the expected refusal for HTTP %s', async (status) => {
    // Given core refuses an installation request.
    const server = Fastify();
    server.get('/trpc/installation.fleets.get', (_request, reply) => reply.code(status).send({ error: 'refused' }));
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      // When provisioning calls core.
      const result = await createPersonFleets({ url, installationToken: 'fixture' }).reconcile(input);

      // Then authentication refusal stays distinct from an unavailable request.
      expect(result).toEqual({ kind: status === 401 || status === 403 ? 'installationRefused' : 'unavailable' });
    } finally { await server.close(); }
  });

  it('reports core redirects as unavailable without following them', async () => {
    // Given core redirects an installation request to a working endpoint.
    const server = Fastify();
    server.get('/trpc/installation.fleets.get', (_request, reply) => reply.redirect('/redirected'));
    server.get('/redirected', () => ({ result: { data: {} } }));
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      // When provisioning calls core.
      const result = await createPersonFleets({ url, installationToken: 'fixture' }).reconcile(input);

      // Then the redirect is a retryable outage, without parsing the destination.
      expect(result).toEqual({ kind: 'unavailable' });
    } finally { await server.close(); }
  });

  it.each(['disconnect', 'timeout'])('reports unavailable after a network %s', async (failure) => {
    // Given core disconnects or never answers the request.
    const server = Fastify();
    server.get('/trpc/installation.fleets.get', (request, reply) => {
      if (failure === 'disconnect') request.raw.socket.destroy();
      return reply.hijack();
    });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      // When provisioning waits for core.
      const result = await createPersonFleets({ url, installationToken: 'fixture' }).reconcile(input);

      // Then the outage can be retried.
      expect(result).toEqual({ kind: 'unavailable' });
    } finally { await server.close(); }
  }, 15_000);

  it.each(['invalid JSON', 'invalid envelope', 'invalid fleet'])('surfaces a malformed %s response', async (answer) => {
    // Given core answers outside its published contract.
    const server = Fastify();
    server.get('/trpc/installation.fleets.get', (_request, reply) => answer === 'invalid JSON'
      ? reply.type('application/json').send('{')
      : answer === 'invalid envelope' ? {} : { result: { data: {} } });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      // When provisioning parses the response.
      const result = createPersonFleets({ url, installationToken: 'fixture' }).reconcile(input);

      // Then the contract error reaches the caller.
      await expect(result).rejects.toBeInstanceOf(Error);
    } finally { await server.close(); }
  });

  it('surfaces an invalid core URL as a configuration error', async () => {
    // Given an invalid core address.
    const fleet = createPersonFleets({ url: 'not a URL', installationToken: 'fixture' });

    // When provisioning attempts a request.
    const result = fleet.reconcile(input);

    // Then the invalid configuration is not reported as an outage.
    await expect(result).rejects.toBeInstanceOf(TypeError);
  });
});
