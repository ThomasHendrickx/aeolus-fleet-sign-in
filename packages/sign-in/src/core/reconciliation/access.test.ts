/** Approved removal and recovery preserve the same person and retry cleanup. */
import { describe, expect, it } from 'vitest';

import { memoryIdentity } from '../../../test/support/memory-identity.js';
import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createSetup } from '../accounts/setup.js';
import { createAccess } from './access.js';

async function aRemoval() {
  const identity = memoryIdentity();
  const setup = aSetup();
  await createSetup({ identity, fleet: fleetOfMaya(), secrets: setup.secrets }).establish(setup.input);
  const accountId = setup.secrets.accountId();
  const acknowledged = new Set<string>();
  let isUnavailable = true;
  const access = createAccess({ identity, secrets: setup.secrets, cleanup: { acknowledge(target) {
    if (isUnavailable) return Promise.resolve(false);
    acknowledged.add(`${target.kind}/${target.fleetId ?? 'installation'}`);
    return Promise.resolve(true);
  } } });
  return { identity, access, accountId, fleetId: setup.input.fleetId, acknowledged, available: () => { isUnavailable = false; } };
}

describe('durable access removal and recovery', () => {
  it('retries every target even while another target is unavailable', async () => {
    // Given core unavailable and gateway able to acknowledge removal.
    const given = await aRemoval();
    const gateway = new Set<string>();
    const access = createAccess({ identity: given.identity, secrets: aSetup().secrets, cleanup: { acknowledge: (target) => {
      if (target.kind !== 'gateway') return Promise.resolve(false);
      gateway.add(target.accountId);
      return Promise.resolve(true);
    } } });

    // When the worker retries a bounded batch.
    await access.remove({ accountId: given.accountId, fleetId: null });
    await access.reconcile(); await access.reconcile(); await access.reconcile();

    // Then core remains pending without starving gateway invalidation.
    expect(gateway).toEqual(new Set([given.accountId]));
    expect(await given.identity.transaction((records) => records.pendingCleanup())).not.toBeNull();
  });

  it('disables the account atomically and retries all cleanup before recovery of the same identity', async () => {
    // Given Maya with a stable person ship and a shared sign-in.
    const given = await aRemoval();
    await given.identity.transaction((records) => records.saveSharedSignIn({ hash: 'shared', sharedSignIn: { accountId: given.accountId, expiresAt: 1000 } }));

    // When the account is disabled while cleanup is unavailable.
    expect(await given.access.remove({ accountId: given.accountId, fleetId: null })).toEqual({ kind: 'saved' });
    await given.access.reconcile();

    // Then local access is revoked durably and recovery waits for all targets.
    expect(await given.identity.transaction((records) => records.accountById(given.accountId))).toMatchObject({ isDisabled: true });
    expect(await given.identity.transaction((records) => records.sharedSignIn('shared'))).toBeNull();
    expect(await given.access.recover({ accountId: given.accountId, password: 'replacement-password', shouldEnable: true, fleetId: null })).toEqual({ kind: 'pending' });
    given.available();
    while ((await given.access.reconcile()).kind === 'pending') { /* bounded single-target retries */ }
    expect(given.acknowledged).toEqual(new Set(['cutOff/installation', `fleet/${given.fleetId}`, `gateway/${given.fleetId}`]));
    expect(await given.access.recover({ accountId: given.accountId, password: 'replacement-password', shouldEnable: true, fleetId: null })).toEqual({ kind: 'recovered' });
    expect(await given.identity.transaction((records) => records.accountById(given.accountId))).toMatchObject({ id: given.accountId, isDisabled: false });
    expect(await given.identity.transaction((records) => records.right({ accountId: given.accountId, fleetId: given.fleetId }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001', scopes: [], isFleetManager: false });
  });

  it('removes only the requested fleet rights without an installation-wide cut-off', async () => {
    // Given Maya with fleet rights.
    const given = await aRemoval();
    given.available();

    // When only workshop rights are removed twice concurrently.
    await Promise.all([given.access.remove({ accountId: given.accountId, fleetId: given.fleetId }), given.access.remove({ accountId: given.accountId, fleetId: given.fleetId })]);
    while ((await given.access.reconcile()).kind === 'pending') { /* drain */ }

    // Then no installation-wide cut-off was requested and the mapping remains.
    expect(given.acknowledged).toEqual(new Set([`fleet/${given.fleetId}`, `gateway/${given.fleetId}`]));
    expect(await given.identity.transaction((records) => records.accountById(given.accountId))).toMatchObject({ isDisabled: false });
    expect(await given.identity.transaction((records) => records.right({ accountId: given.accountId, fleetId: given.fleetId }))).toMatchObject({ personShipId: 'shp_00000000000000000000000001', scopes: [] });
  });
});
