/** Compatibility failures name safe version information before any migration or serving. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createPersonFleets } from './person-fleets.js';

describe('the sign-in minimum core version', () => {
  it('refuses an old core with the required and reported versions, without exposing installation credentials', async () => {
    // Given a reachable core older than the supported public contract.
    const server = Fastify();
    server.get('/api/version', () => Promise.resolve({ server: '0.38.0', common: '0.38.0' }));
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const fleet = createPersonFleets({ url, installationToken: 'server-only-fixture' });

      // When startup checks compatibility before opening its own database.
      const message = await fleet.checkCompatibility().then(() => '', (error: unknown) => error instanceof Error ? error.message : 'unknown');

      // Then the operator can diagnose the version mismatch without a token or private settings.
      expect(message).toContain('0.39.0');
      expect(message).toContain('0.38.0');
      expect(message).not.toContain('server-only-fixture');
    } finally { await server.close(); }
  });
});
