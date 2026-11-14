/** Trusted setup persists identity before any network provisioning, making restart safe and resumable. */
import type { AccountId, FleetId } from '@aeolus-fleet/common';

import type { Identity, PersonFleets, Secrets } from '../shared/identity.js';
import { normalisedEmail } from './email.js';

export interface SetupInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly fleetId: FleetId;
}

export function createSetup(deps: { identity: Identity; fleet: PersonFleets; secrets: Secrets }) {
  /** Provisioning failures leave the saved identity pending; a failure to save it is a system failure and propagates. */
  async function provision(input: { accountId: AccountId; fleetId: FleetId }) {
    return deps.identity.transaction(async (records) => {
      const account = await records.accountById(input.accountId);
      const held = await records.right(input);
      if (account === null || account.isDisabled || !held?.isFleetManager) return { kind: 'pending' as const, reason: 'accessRemoved' as const };
      let reconciled;
      try { reconciled = await deps.fleet.reconcile(input); }
      catch { return { kind: 'pending' as const, reason: 'unavailable' as const }; }
      if (reconciled.kind === 'installationRefused') return { kind: 'pending' as const, reason: 'installationRefused' as const };
      const { right } = reconciled;
      await records.saveRight(right);
      return { kind: 'ready' as const, accountId: input.accountId, personShipId: right.personShipId };
    });
  }

  return {
    establish: async (input: SetupInput) => {
      const email = normalisedEmail(input.email);
      const account = await deps.identity.transaction(async (records) => {
        const existing = await records.account(email);
        const created = existing ?? {
          id: deps.secrets.accountId(), email, displayName: input.displayName,
          isDisabled: false, accessVersion: 0, passwordHash: await deps.secrets.hashPassword(input.password), organisationId: 'local',
        };
        if (existing === null) await records.saveAccount(created);
        if (!created.isDisabled && await records.right({ accountId: created.id, fleetId: input.fleetId }) === null) await records.saveRight({ accountId: created.id, fleetId: input.fleetId, personShipId: null, scopes: [], groupValues: [], isFleetManager: true });
        return created;
      });
      return provision({ accountId: account.id, fleetId: input.fleetId });
    },
    /** The saved fleet-manager account whose person ship is not yet mapped on this fleet, if any. */
    pendingAccount: async (fleetId: FleetId) => {
      return deps.identity.transaction(async (records) => {
        const right = await records.pendingRight(fleetId);
        return right === null ? null : records.accountById(right.accountId);
      });
    },
    resume: provision,
  };
}
