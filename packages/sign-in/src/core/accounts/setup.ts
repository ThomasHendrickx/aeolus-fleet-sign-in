/** Trusted setup persists identity before any network provisioning, making restart safe. */
import type { AccountId, FleetId } from '@aeolus-fleet/common';

import type { Identity, PersonFleets, Secrets } from '../shared/identity.js';

export interface SetupInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly fleetId: FleetId;
}

export function createSetup(deps: { identity: Identity; fleet: PersonFleets; secrets: Secrets }) {
  return async (input: SetupInput) => {
    try {
      const account = await deps.identity.transaction(async (records) => {
        const existing = await records.account(input.email);
        if (existing !== null) return existing;
        const created = {
          id: deps.secrets.accountId(), email: input.email, displayName: input.displayName,
          passwordHash: await deps.secrets.hashPassword(input.password), organisationId: 'local',
        };
        await records.saveAccount(created);
        return created;
      });
      return await provision(account.id, input.fleetId);
    } catch {
      return { kind: 'unavailable' as const };
    }
  };

  async function provision(accountId: AccountId, fleetId: FleetId) {
    const right = await deps.fleet.reconcile({ accountId, fleetId });
    await deps.identity.transaction((records) => records.saveRight(right));
    return { kind: 'ready' as const, accountId, personShipId: right.personShipId };
  }
}
