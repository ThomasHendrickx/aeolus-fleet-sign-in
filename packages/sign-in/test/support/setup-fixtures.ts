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

export function fleetOfMaya(identity?: Identity) {
  const people = new Map<string, ShipId>();
  const fleet = {
    identity, people, shouldLoseConfirmation: false, shouldRefuseInstallation: false,
    signedOutAccounts: new Set<AccountId>(), shouldFailSignOut: false,
    signOut(accountId: AccountId) {
      if (fleet.shouldFailSignOut) return Promise.reject(new Error('Core sign-out unavailable'));
      fleet.signedOutAccounts.add(accountId);
      return Promise.resolve();
    },
    reconcile(input: { accountId: AccountId; fleetId: FleetId }) {
      if (fleet.shouldRefuseInstallation) return Promise.resolve({ kind: 'installationRefused' as const });
      const key = `person-${input.accountId}`;
      const personShipId = people.get(key) ?? 'shp_00000000000000000000000001';
      people.set(key, personShipId);
      if (fleet.shouldLoseConfirmation) return Promise.reject(new Error('Confirmation lost'));
      return Promise.resolve({ kind: 'reconciled' as const, right: { ...input, personShipId, scopes: ['messages:send', 'messages:receive', 'fleet:read', 'fleet:commission'], groupValues: ['fleet-manager'], isFleetManager: true } });
    },
  };
  return fleet;
}

/** Node's default scrypt work: tests that make many credential attempts stay within their time limits. */
export const FIXTURE_PASSWORD_COST = { log2N: 14, r: 8, p: 1 };
