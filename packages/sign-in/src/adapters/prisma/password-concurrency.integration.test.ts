/** Separate Postgres clients prove credential re-checks after password verification. */
import { accountIdSchema } from '@aeolus-fleet/common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createSetup } from '../../core/accounts/setup.js';
import { createSignIn } from '../../core/sign-in/sign-in.js';
import { openIdentity } from './identity.js';

const ACCOUNT_THRESHOLD = 5;
const AFTER_FAILURES = 1000;
const TEST_TIMEOUT = 15_000;
let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let database: Awaited<ReturnType<typeof openIdentity>>;
let inspection: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  database = await openIdentity(container.getConnectionUri());
  inspection = new Pool({ connectionString: container.getConnectionUri() });
  await createSetup({ identity: database.identity, fleet: fleetOfMaya(), secrets: aSetup().secrets }).establish(aSetup().input);
}, 120_000);
afterAll(async () => { await inspection.end(); await database.close(); await container.stop(); }, 60_000);

async function pausedVerification(name: string) {
  const email = `${name}@example.test`;
  await database.identity.transaction(async (records) => {
    const account = await records.account('maya@example.test');
    if (account === null) throw new Error('Expected setup account');
    await records.saveAccount({ ...account, id: accountIdSchema.parse(name), email });
  });
  const connection = await openIdentity(container.getConnectionUri());
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<boolean>();
  const clock = { now: 0 };
  const signIn = createSignIn({ identity: connection.identity, now: () => clock.now, secrets: {
    token: () => name,
    digest: (value) => Promise.resolve(`digest:${value}`),
    verifyPassword: () => { entered.resolve(undefined); return released.promise; },
  } });
  return { email, connection, entered, released, clock, signIn };
}

async function sharedSignInCount() {
  const result = await inspection.query("SELECT key FROM identity_records WHERE key LIKE 'shared-sign-in/%'");
  return result.rowCount;
}

describe('Postgres credential re-check under the advisory lock', () => {
  it('counts concurrent failures exactly and refuses an in-flight correct password without extending lockout', async () => {
    // Given a correct password paused on a separate database client.
    const fixture = await pausedVerification('concurrent-lockout');
    const pending = fixture.signIn.authenticate({ email: fixture.email, password: 'private-password', address: 'waiting-browser' });
    const connections = await Promise.all(Array.from({ length: ACCOUNT_THRESHOLD }, () => openIdentity(container.getConnectionUri())));
    await fixture.entered.promise;
    try {
      // When concurrent wrong passwords on other clients reach the threshold first.
      const allFailuresEntered = Promise.withResolvers<boolean>();
      let enteredFailures = 0;
      const failures = await Promise.all(connections.map((connection, index) => createSignIn({ identity: connection.identity, now: () => 0, secrets: {
        token: () => `failure-${index}`, digest: (value) => Promise.resolve(`digest:${value}`), verifyPassword: () => {
          enteredFailures += 1;
          if (enteredFailures === ACCOUNT_THRESHOLD) allFailuresEntered.resolve(false);
          return allFailuresEntered.promise;
        },
      } }).authenticate({ email: fixture.email, password: 'wrong', address: `failure-browser-${index}` })));
      fixture.clock.now = AFTER_FAILURES;
      fixture.released.resolve(true);
      const result = await pending;

      // Then the second transaction retains exactly five failures and the original deadline, with no sign-in.
      expect(failures.map((failure) => failure.kind).sort()).toEqual(['tooManyAttempts', 'wrongCredential', 'wrongCredential', 'wrongCredential', 'wrongCredential']);
      expect(result).toEqual({ kind: 'tooManyAttempts', retryAt: 900_000 });
      expect(await database.identity.transaction((records) => records.attempts(`account:digest:${fixture.email}`))).toEqual({ failures: [0, 0, 0, 0, 0], refusedUntil: 900_000 });
      expect(await database.identity.transaction((records) => records.attempts('address:digest:waiting-browser'))).toBeNull();
      expect(await sharedSignInCount()).toBe(0);
    } finally {
      fixture.released.resolve(true);
      await pending;
      await Promise.all(connections.map((connection) => connection.close()));
      await fixture.connection.close();
    }
  }, TEST_TIMEOUT);

  it.each(['password', 'disabled', 'accessVersion'] as const)('refuses stale verification after %s changes on another Postgres client', async (change) => {
    // Given verification of the original credential paused outside the transaction.
    const fixture = await pausedVerification(`stale-${change}`);
    const pending = fixture.signIn.authenticate({ email: fixture.email, password: 'private-password', address: `browser-${change}` });
    await fixture.entered.promise;
    try {
      // When a separate client commits credential recovery or access removal before verification finishes.
      await database.identity.transaction(async (records) => {
        const account = await records.account(fixture.email);
        if (account === null) throw new Error('Expected credential account');
        await records.saveAccount({ ...account, passwordHash: change === 'password' ? 'replacement-hash' : account.passwordHash, isDisabled: change === 'disabled', accessVersion: account.accessVersion + (change === 'accessVersion' ? 1 : 0) });
      });
      fixture.released.resolve(true);
      const result = await pending;

      // Then the re-check refuses the stale success and persists no shared sign-in.
      expect(result).toEqual({ kind: 'wrongCredential' });
      expect(await sharedSignInCount()).toBe(0);
    } finally {
      fixture.released.resolve(true);
      await pending;
      await fixture.connection.close();
    }
  }, TEST_TIMEOUT);
});
