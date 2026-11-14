/** Approved first setup: durable identity precedes provisioning and retries converge. */
import { describe, expect, it } from 'vitest';

import { memoryIdentity } from '../../../test/support/memory-identity.js';
import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createSetup } from './setup.js';

describe('first trusted setup', () => {
  it('persists the opaque account before provisioning and gives Maya fleet-manager rights without argo', async () => {
    // Given an existing fleet and trusted setup with a privately supplied password.
    const identity = memoryIdentity();
    const fleet = fleetOfMaya(identity);
    const setup = createSetup({ identity, fleet, secrets: aSetup().secrets });

    // When Maya is set up, then setup is retried with the same email.
    const first = await setup(aSetup().input);
    const retry = await setup(aSetup().input);

    // Then the same opaque identity, person mapping and all offered scopes survive the retry.
    expect(first).toEqual({ kind: 'ready', accountId: 'maya-opaque-account', personShipId: 'shp_00000000000000000000000001' });
    expect(retry).toEqual(first);
    expect(identity.accounts.size).toBe(1);
    expect(identity.rights.get('flt_00000000000000000000000001/maya-opaque-account')).toEqual({
      fleetId: 'flt_00000000000000000000000001', accountId: 'maya-opaque-account', personShipId: 'shp_00000000000000000000000001',
      scopes: ['messages:send', 'messages:receive', 'fleet:read', 'fleet:commission'],
      groupValues: ['fleet-manager'], isFleetManager: true,
    });
    expect(fleet.people.size).toBe(1);
    expect(identity.accounts.get('maya@example.test')?.passwordHash).toBe('hash-of-private-password');
  });

  it('resumes a saved account after a lost commission response without creating a second person', async () => {
    // Given the person commission succeeds but its confirmation is lost.
    const identity = memoryIdentity();
    const fleet = fleetOfMaya(identity);
    fleet.shouldLoseConfirmation = true;
    const setup = createSetup({ identity, fleet, secrets: aSetup().secrets });

    // When the command is retried after the service restarts.
    expect(await setup(aSetup().input)).toEqual({ kind: 'unavailable' });
    fleet.shouldLoseConfirmation = false;
    const restarted = createSetup({ identity, fleet, secrets: aSetup().secrets });
    const result = await restarted(aSetup().input);

    // Then the persisted id and installation commission key resolve the original person.
    expect(result).toEqual({ kind: 'ready', accountId: 'maya-opaque-account', personShipId: 'shp_00000000000000000000000001' });
    expect(identity.accounts.size).toBe(1);
    expect(fleet.people.size).toBe(1);
    expect([...fleet.people.keys()]).toEqual(['person-maya-opaque-account']);
  });
});
