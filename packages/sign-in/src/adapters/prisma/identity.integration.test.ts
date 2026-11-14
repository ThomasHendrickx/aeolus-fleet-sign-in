/** Postgres proves setup convergence, transaction rollback and sign-in state after restart. */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createAccess } from '../../core/reconciliation/access.js';
import { createSetup } from '../../core/accounts/setup.js';
import { createSignIn } from '../../core/sign-in/sign-in.js';
import { createSignOut } from '../../core/sign-in/sign-out.js';
import { openIdentity } from './identity.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let database: Awaited<ReturnType<typeof openIdentity>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  database = await openIdentity(container.getConnectionUri());
}, 120_000);
afterAll(async () => { await database.close(); await container.stop(); }, 60_000);

describe('durable identity across rollback concurrency and restart', () => {
  it('serializes simultaneous setup and persists the original person mapping through restart', async () => {
    // Given one database and simultaneous setup retries.
    const fleet = fleetOfMaya();
    const { establish: setup } = createSetup({ identity: database.identity, fleet, secrets: aSetup().secrets });

    // When both commands run and the process reopens its database.
    const results = await Promise.all([setup(aSetup().input), setup(aSetup().input)]);
    await database.close();
    database = await openIdentity(container.getConnectionUri());

    // Then both found one account/person and the mapping remains durable.
    expect(results).toEqual([{ kind: 'ready', accountId: 'maya-opaque-account', personShipId: 'shp_00000000000000000000000001' }, { kind: 'ready', accountId: 'maya-opaque-account', personShipId: 'shp_00000000000000000000000001' }]);
    const account = await database.identity.transaction((records) => records.account('maya@example.test'));
    expect(account?.id).toBe('maya-opaque-account');
    expect(fleet.people.size).toBe(1);
    expect(await database.identity.transaction((records) => records.right({ accountId: aSetup().secrets.accountId(), fleetId: 'flt_00000000000000000000000001' }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001', isFleetManager: true });
  });

  it('rolls back partial identity changes and preserves code one-use and refusal counters after restart', async () => {
    // Given an account write interrupted before its transaction commits.
    const original = await database.identity.transaction((records) => records.account('maya@example.test'));
    if (original === null) throw new Error('Expected setup account');
    await expect(database.identity.transaction(async (records) => {
      await records.saveAccount({ ...original, email: 'rollback@example.test' });
      throw new Error('Interrupted');
    })).rejects.toThrow('Interrupted');
    expect(await database.identity.transaction((records) => records.account('rollback@example.test'))).toBeNull();
    let sequence = 0;
    const options = { now: () => 0, secrets: { token: () => `secret-${++sequence}`, digest: (value: string) => Promise.resolve(`digest:${value}`), verifyPassword: ({ password }: { password: string; hash: string | null }) => Promise.resolve(password === 'private-password') } };
    const signIn = createSignIn({ ...options, identity: database.identity });
    const authenticated = await signIn.authenticate({ email: original.email, password: 'private-password', address: 'address' });
    if (authenticated.kind !== 'authenticated') throw new Error('Expected authentication');
    const flow = await signIn.begin({ clientId: 'console', redirectUri: 'https://console.example.test/sign-in/done', state: 'state', codeChallenge: 'digest:verifier', browser: 'browser' });
    const authorized = await signIn.complete({ ...flow, browser: 'browser', signIn: authenticated.signIn });
    if (authorized.kind !== 'authorized') throw new Error('Expected authorization');
    for (let count = 0; count < 5; count += 1) await signIn.authenticate({ email: original.email, password: 'wrong', address: 'address' });

    // When the database is reopened and the same code is redeemed concurrently.
    await database.close();
    database = await openIdentity(container.getConnectionUri());
    const restarted = createSignIn({ ...options, identity: database.identity });
    const results = await Promise.all([1, 2].map(() => restarted.redeem({ code: authorized.code, clientId: 'console', redirectUri: 'https://console.example.test/sign-in/done', verifier: 'verifier' })));

    // Then the code succeeds only once, and both the shared sign-in and credential refusal remain durable.
    expect(results.map((result) => result.kind).sort()).toEqual(['invalidGrant', 'redeemed']);
    expect((await restarted.account(authenticated.signIn)).kind).toBe('account');
    expect(await restarted.authenticate({ email: original.email, password: 'private-password', address: 'address' })).toEqual({ kind: 'tooManyAttempts', retryAt: 900_000 });
  });
  it('preserves shared revocation through rollback, concurrent sign-out and restart before retrying core', async () => {
    // Given a durable account and shared sign-in, and unavailable core sign-out.
    const fleet = fleetOfMaya();
    await createSetup({ identity: database.identity, fleet, secrets: aSetup().secrets }).establish(aSetup().input);
    let sequence = 0;
    const options = { now: () => 900_000, secrets: { token: () => `revocation-${++sequence}`, digest: (value: string) => Promise.resolve(`digest:${value}`), verifyPassword: () => Promise.resolve(true) } };
    const signIn = createSignIn({ ...options, identity: database.identity });
    const shared = await signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'revocation-browser' });
    if (shared.kind !== 'authenticated') throw new Error('Expected authentication');
    const hash = `digest:${shared.signIn}`;
    await expect(database.identity.transaction(async (records) => {
      const held = await records.sharedSignIn(hash);
      if (held === null) throw new Error('Expected shared sign-in');
      await records.saveSharedSignIn({ hash, sharedSignIn: { ...held, expiresAt: 0 } });
      throw new Error('Rollback sign-out');
    })).rejects.toThrow('Rollback sign-out');
    expect((await signIn.account(shared.signIn)).kind).toBe('account');
    fleet.shouldFailSignOut = true;
    const signOut = createSignOut({ signIn, sessions: fleet, log: () => undefined });

    // When concurrent sign-outs commit locally, fail remotely, and the service restarts.
    expect(await Promise.all([signOut(shared.signIn), signOut(shared.signIn)])).toEqual([{ kind: 'unavailable' }, { kind: 'unavailable' }]);
    await database.close();
    database = await openIdentity(container.getConnectionUri());
    const restarted = createSignIn({ ...options, identity: database.identity });
    fleet.shouldFailSignOut = false;

    // Then neither app can use the shared sign-in, while retry still resolves its original account for core.
    expect(await restarted.account(shared.signIn)).toEqual({ kind: 'signedOut' });
    expect(await createSignOut({ signIn: restarted, sessions: fleet, log: () => undefined })(shared.signIn)).toEqual({ kind: 'signedOut' });
    expect(fleet.signedOutAccounts).toEqual(new Set(['maya-opaque-account']));
    expect(await database.identity.transaction((records) => records.sharedSignIn(hash))).toEqual({ accountId: 'maya-opaque-account', expiresAt: 0, revokedAt: 900_000 });
  });

});


describe('access cleanup durability', () => {
  it('saves the same person mapping resolved after a lost commission reply before acknowledging removal', async () => {
    // Given core created Maya's person but setup lost the reply before saving its mapping.
    const setup = aSetup();
    const accountId = setup.secrets.accountId();
    await createSetup({ identity: database.identity, fleet: fleetOfMaya(), secrets: setup.secrets }).establish(setup.input);
    await database.identity.transaction(async (records) => {
      const right = await records.right({ accountId, fleetId: setup.input.fleetId });
      if (right === null) throw new Error('Expected right');
      await records.saveRight({ ...right, personShipId: null });
    });
    const access = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: (target) => Promise.resolve(target.kind === 'fleet' && target.personShipId === null ? { personShipId: 'shp_00000000000000000000000001' } : true) } });

    // When removal resolves the original commission key and the service restarts.
    await access.remove({ accountId, fleetId: null });
    for (let index = 0; index < 3; index += 1) await access.reconcile();
    await database.close();
    database = await openIdentity(container.getConnectionUri());

    // Then the mapping is durable and only subsequent cleanup can acknowledge the remaining fleet target.
    expect(await database.identity.transaction((records) => records.right({ accountId, fleetId: setup.input.fleetId }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001', scopes: [] });
    expect(await database.identity.transaction((records) => records.pendingCleanup(accountId))).toMatchObject({ personShipId: 'shp_00000000000000000000000001', kind: 'fleet' });
    const retry = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: () => Promise.resolve(true) } });
    while ((await retry.reconcile()).kind === 'pending') { /* finish removal */ }
    expect(await retry.recover({ accountId, password: 'replacement-password', shouldEnable: true, fleetId: setup.input.fleetId })).toEqual({ kind: 'recovered' });
  });

  it('rolls back removal, survives restart and serialises concurrent cleanup acknowledgements', async () => {
    // Given Maya and an interrupted removal transaction.
    const setup = aSetup();
    const accountId = setup.secrets.accountId();
    await createSetup({ identity: database.identity, fleet: fleetOfMaya(), secrets: setup.secrets }).establish(setup.input);
    const original = await database.identity.transaction((records) => records.accountById(accountId));
    if (original === null) throw new Error('Expected Maya');
    await expect(database.identity.transaction(async (records) => {
      await records.saveAccount({ ...original, isDisabled: true });
      await records.saveCleanup({ id: 'rollback', attempts: 0, cursor: null, accountId, fleetId: null, personShipId: null, kind: 'cutOff', shouldReleaseOwnedTrierarchs: true });
      throw new Error('Interrupted removal');
    })).rejects.toThrow('Interrupted removal');
    expect(await database.identity.transaction((records) => records.pendingCleanup())).toBeNull();
    expect(await database.identity.transaction((records) => records.accountById(accountId))).toMatchObject({ isDisabled: false });
    const unavailable = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: () => Promise.resolve(false) } });

    // When concurrent commands remove access and the service restarts before acknowledgement.
    await Promise.all([unavailable.remove({ accountId, fleetId: null }), unavailable.remove({ accountId, fleetId: null })]);
    await unavailable.reconcile();
    const acknowledged = new Set<string>();
    const interrupted = createAccess({ identity: { transaction: (work) => database.identity.transaction(async (records) => {
      await work(records);
      throw new Error('Lost acknowledgement transaction');
    }) }, secrets: setup.secrets, cleanup: { acknowledge: (target) => { acknowledged.add(target.id); return Promise.resolve(true); } } });
    await expect(interrupted.reconcile()).rejects.toThrow('Lost acknowledgement transaction');
    await database.close();
    database = await openIdentity(container.getConnectionUri());
    const restarted = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: (target) => { acknowledged.add(target.id); return Promise.resolve(true); } } });
    while ((await restarted.reconcile()).kind === 'pending') await Promise.all([restarted.reconcile(), restarted.reconcile()]);

    // Then all targets from both removals were retained, acknowledged, and recovery keeps the same mapping.
    expect(acknowledged.size).toBe(6);
    expect(await database.identity.transaction((records) => records.pendingCleanup())).toBeNull();
    expect(await restarted.recover({ accountId, password: 'replacement-password', shouldEnable: true, fleetId: null })).toEqual({ kind: 'recovered' });
    expect(await database.identity.transaction((records) => records.right({ accountId, fleetId: setup.input.fleetId }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001' });
  });
});


describe('protected identity backup restore', () => {
  it('restores the same identity and pending cleanup page before reconciling acknowledgements', async () => {
    // Given a saved account, person mapping and partially completed cleanup in a protected database backup.
    const setup = aSetup();
    await createSetup({ identity: database.identity, fleet: fleetOfMaya(), secrets: setup.secrets }).establish(setup.input);
    const accountId = setup.secrets.accountId();
    const access = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: () => Promise.resolve({ cursor: 'saved-page' }) } });
    await access.remove({ accountId, fleetId: null });
    await access.reconcile();
    const dump = await container.exec(['pg_dump', '-U', container.getUsername(), '-d', container.getDatabase(), '-f', '/tmp/sign-in-backup.sql']);
    expect(dump.exitCode).toBe(0);
    const created = await container.exec(['createdb', '-U', container.getUsername(), 'restored']);
    expect(created.exitCode).toBe(0);
    const restored = await container.exec(['psql', '-U', container.getUsername(), '-d', 'restored', '-f', '/tmp/sign-in-backup.sql', '-v', 'ON_ERROR_STOP=1']);
    expect(restored.exitCode).toBe(0);

    // When that backup is restored on the matching installation and reconciliation restarts.
    await database.close();
    const restoredUrl = new URL(container.getConnectionUri());
    restoredUrl.pathname = '/restored';
    database = await openIdentity(restoredUrl.toString());
    const target = await database.identity.transaction((records) => records.pendingCleanup(accountId));
    // The partial page must not be acknowledged merely because it made progress.
    expect(await database.identity.transaction(async (records) => {
      const targets = [];
      let held = await records.pendingCleanup(accountId);
      while (held !== null) { targets.push(held); await records.deleteCleanup(held.id); held = await records.pendingCleanup(accountId); }
      for (const saved of targets) await records.saveCleanup(saved);
      return targets.some((saved) => saved.cursor === 'saved-page');
    })).toBe(true);
    expect(target).not.toBeNull();
    const retry = createAccess({ identity: database.identity, secrets: setup.secrets, cleanup: { acknowledge: () => Promise.resolve(true) } });
    while ((await retry.reconcile()).kind === 'pending') { /* drain restored retry records */ }

    // Then acknowledgement completes without changing the account, person ship or ownership mapping.
    expect(await retry.hasPending()).toBe(false);
    expect(await database.identity.transaction((records) => records.accountById(accountId))).toMatchObject({ id: accountId, organisationId: 'local', isDisabled: true });
    expect(await database.identity.transaction((records) => records.right({ accountId, fleetId: setup.input.fleetId }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001' });
  });
});
