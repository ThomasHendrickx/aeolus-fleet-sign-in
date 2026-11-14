/** Maya's approved first-setup scenario, with a fleet boundary that can lose confirmation. */
import { accountIdSchema, type AccountId, type FleetId, type ShipId } from '@aeolus-fleet/common';

import type { SetupInput } from '../../src/core/accounts/setup.js';
import type { Identity, Secrets } from '../../src/core/shared/identity.js';

export function aSetup(): { input: SetupInput; secrets: Secrets } {
  return {
    input: { fleetId: 'flt_00000000000000000000000001', email: 'maya@example.test', displayName: 'Maya', password: 'private-password' },
    secrets: { accountId: () => accountIdSchema.parse('maya-opaque-account'), hashPassword: () => Promise.resolve('hash-of-private-password') },
  };
}

export function fleetOfMaya(identity: Identity) {
  const people = new Map<string, ShipId>();
  const fleet = {
    people, shouldLoseConfirmation: false, shouldRefuseInstallation: false,
    async reconcile(input: { accountId: AccountId; fleetId: FleetId }) {
      const account = await identity.transaction((records) => records.accountById(input.accountId));
      if (account === null) throw new Error('Account must already be durable');
      if (fleet.shouldRefuseInstallation) return { kind: 'installationRefused' as const };
      const key = `person-${input.accountId}`;
      const personShipId = people.get(key) ?? 'shp_00000000000000000000000001';
      people.set(key, personShipId);
      if (fleet.shouldLoseConfirmation) throw new Error('Confirmation lost');
      return { kind: 'reconciled' as const, right: { ...input, personShipId, scopes: ['messages:send', 'messages:receive', 'fleet:read', 'fleet:commission'], groupValues: ['fleet-manager'], isFleetManager: true } };
    },
  };
  return fleet;
}
