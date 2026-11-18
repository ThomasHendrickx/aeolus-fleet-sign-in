/** Owner decision: expired records disappear and an anonymous visit writes no row. */
import { generateKeyPairSync } from 'node:crypto';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import type { Identity } from '../../core/shared/identity.js';

import { createService } from '../../app.js';
import { createSecrets } from '../crypto/secrets.js';
import { createSigner } from '../crypto/signer.js';
import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { openIdentity } from './identity.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let database: Awaited<ReturnType<typeof openIdentity>>;
let pool: Pool;
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  database = await openIdentity(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
}, 120_000);
afterAll(async () => { await pool.end(); await database.close(); await container.stop(); }, 60_000);

it('deletes expired sign-in records at startup and on repeated purges while preserving live records', async () => {
  // Given expired and live flows, codes, shared sign-ins and failed attempts.
  const { app, clock } = service();
  const accountId = aSetup().secrets.accountId();
  await database.identity.transaction(async (records) => {
    for (const { hash, expiresAt } of [{ hash: 'expired', expiresAt: 0 }, { hash: 'live', expiresAt: 7_200_000 }]) {
      await records.saveAuthorization({ hash, authorization: { clientId: 'console', redirectUri, state: 'state', codeChallenge: 'challenge', browser: 'browser', expiresAt } });
      await records.saveCode({ hash, code: { clientId: 'console', redirectUri, codeChallenge: 'challenge', signInHash: 'shared', expiresAt } });
      await records.saveSharedSignIn({ hash, sharedSignIn: { accountId, expiresAt } });
    }
    await records.saveSharedSignIn({ hash: 'retry', sharedSignIn: { accountId, expiresAt: 0, revokedAt: 900_000 } });
    await records.saveAttempts({ key: 'expired', attempts: { failures: [0], refusedUntil: 0 } });
    await records.saveAttempts({ key: 'live', attempts: { failures: [900_000], refusedUntil: 1_800_000 } });
  });
  try {
    // When the service starts and later purge retries run.
    clock.now = 900_000;
    await app.server.ready();
    expect(await keys()).toEqual(['attempts/live', 'authorization/live', 'code/live', 'shared-sign-in/live', 'shared-sign-in/retry']);
    clock.now = 7_200_000;
    await app.purge();
    await app.purge();

    // Then all expired records are physically deleted, including on an idempotent retry.
    expect(await keys()).toEqual([]);
  } finally { await app.server.close(); }
});

it('purges each hour, retries after failure, and stops when the service closes', async () => {
  // Given a running service backed by Postgres and a purge that can fail once.
  let shouldFail = false;
  let completed: (() => void) | undefined;
  const identity: Identity = {
    async transaction(work) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('database unavailable');
      }
      const result = await database.identity.transaction(work);
      completed?.();
      return result;
    },
  };
  const { app, clock } = service(identity);
  const hour = 3_600_000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await app.server.ready();
    const saveExpired = async (hash: string) => database.identity.transaction((records) => records.saveCode({ hash, code: { clientId: 'console', redirectUri, codeChallenge: 'challenge', signInHash: 'shared', expiresAt: 0 } }));
    const nextPurge = () => new Promise<void>((resolve) => { completed = resolve; });

    // When each hour passes, including an hour whose purge fails.
    await saveExpired('first-hour');
    clock.now = hour;
    let purged = nextPurge();
    await vi.advanceTimersByTimeAsync(hour);
    await purged;
    expect(await keys()).not.toContain('code/first-hour');

    await saveExpired('second-hour');
    clock.now = 2 * hour;
    purged = nextPurge();
    await vi.advanceTimersByTimeAsync(hour);
    await purged;
    expect(await keys()).not.toContain('code/second-hour');

    await saveExpired('after-failure');
    shouldFail = true;
    clock.now = 3 * hour;
    await vi.advanceTimersByTimeAsync(hour);
    expect(await keys()).toContain('code/after-failure');
    clock.now = 4 * hour;
    purged = nextPurge();
    await vi.advanceTimersByTimeAsync(hour);
    await purged;
    expect(await keys()).not.toContain('code/after-failure');

    // Then closing cancels the next purge.
    await app.server.close();
    await saveExpired('after-close');
    await vi.advanceTimersByTimeAsync(hour);
    expect(await keys()).toContain('code/after-close');
    await pool.query("DELETE FROM identity_records WHERE key = 'code/after-close'");
  } finally {
    await app.server.close();
    vi.useRealTimers();
  }
});

it('stores no row for an anonymous visit and completes only a submitted browser-bound flow once', async () => {
  // Given an installation with Maya and no sign-in records.
  let { app, clock } = service();
  clock.now = 8_000_000;
  await app.setup.establish(aSetup().input);
  try {
    await app.server.ready();
    const before = await keys();
    const query = new URLSearchParams({ response_type: 'code', client_id: 'console', redirect_uri: redirectUri, state: 'state', code_challenge: await createSecrets().digest('verifier'), code_challenge_method: 'S256' });

    // When an anonymous browser visits repeatedly, without submitting the form.
    const visit = await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });
    await app.server.inject({ method: 'GET', url: `/oauth/authorize?${query.toString()}` });

    // Then no row is written until submission, which remains browser bound and one use.
    expect(visit.statusCode).toBe(200);
    expect(await keys()).toEqual(before);
    const flow = /name="flow" value="([^"]+)"/.exec(visit.body)?.[1] ?? '';
    const cookie = visit.cookies.find((held) => held.name === 'aeolus_sign_in_browser');
    // The configured signing key and browser binding survive a process/database restart.
    await app.server.close();
    await database.close();
    database = await openIdentity(container.getConnectionUri());
    ({ app, clock } = service());
    clock.now = 8_000_000;
    await app.server.ready();
    const tampered = await app.server.inject({ method: 'POST', url: '/sign-in', payload: { flow: `x${flow.slice(1)}`, email: 'maya@example.test', password: aSetup().input.password }, headers: { origin, cookie: `aeolus_sign_in_browser=${cookie?.value ?? ''}` } });
    expect(tampered.statusCode).toBe(400);
    expect(await keys()).toEqual(before);
    const payload = { flow, email: 'maya@example.test', password: aSetup().input.password };
    const foreign = await app.server.inject({ method: 'POST', url: '/sign-in', payload, headers: { origin } });
    expect(foreign.statusCode).toBe(400);
    expect(await keys()).toEqual(before);
    const submit = () => app.server.inject({ method: 'POST', url: '/sign-in', payload, headers: { origin, cookie: `aeolus_sign_in_browser=${cookie?.value ?? ''}` } });
    expect((await submit()).statusCode).toBe(303);
    await app.server.close();
    await database.close();
    database = await openIdentity(container.getConnectionUri());
    ({ app, clock } = service());
    clock.now = 8_000_000;
    expect((await submit()).statusCode).toBe(400);
    expect((await keys()).length).toBeGreaterThan(before.length);
  } finally { await app.server.close(); }
});

const origin = 'https://signin.example.test';
const redirectUri = 'https://console.example.test/sign-in/done';
const { privateKey } = generateKeyPairSync('ed25519');
const flowPrivateKey = generateKeyPairSync('ed25519').privateKey;
function service(identity: Identity = database.identity) {
  const clock = { now: 0 };
  const app = createService({ identity, fleet: fleetOfMaya(), now: () => clock.now, secrets: createSecrets(), signer: createSigner({ flowPrivateKey, activeKeyId: 'first', keys: [{ id: 'first', privateKey }] }), config: {
    origin, cookieDomain: 'example.test', clients: [{ id: 'console', secret: 'fixture-secret', redirectUri }], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
  } });
  return { app, clock };
}
async function keys() {
  const result = await pool.query<{ key: string }>('SELECT key FROM identity_records ORDER BY key');
  return result.rows.map((row) => row.key);
}
