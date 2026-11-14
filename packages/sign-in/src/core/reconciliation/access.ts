/** Removal and its remote acknowledgements are serialised with recovery and issuance. */
import type { AccountId, FleetId } from '@aeolus-fleet/common';

import { cleanupTargetIdSchema, type AccessCleanup, type CleanupFailure, type CleanupProgress, type CleanupTarget, type Identity, type Secrets } from '../shared/identity.js';
import type { Result } from '../shared/result.js';

export function createAccess(deps: { identity: Identity; secrets: Secrets; cleanup: AccessCleanup }) {
  return {
    hasPending: (accountId?: AccountId) => deps.identity.transaction(async (records) => await records.pendingCleanup(accountId) !== null),
    remove: (input: { accountId: AccountId; fleetId: FleetId | null }) => deps.identity.transaction(async (records) => {
      const account = await records.accountById(input.accountId);
      if (account === null) return { kind: 'notFound' as const };
      const accessVersion = account.accessVersion + 1;
      await records.saveAccount({ ...account, accessVersion, isDisabled: input.fleetId === null || account.isDisabled });
      await records.revokeSharedSignIns(account.id);
      const rights = await records.rights(account.id);
      const save = (target: Omit<CleanupTarget, 'id' | 'accountId' | 'shouldReleaseOwnedTrierarchs' | 'attempts' | 'cursor'>) => records.saveCleanup({ ...target, attempts: 0, cursor: null, accountId: account.id, id: cleanupTargetIdSchema.parse(`${account.id}/${accessVersion}/${target.kind}/${target.fleetId ?? 'installation'}`), shouldReleaseOwnedTrierarchs: input.fleetId === null });
      if (input.fleetId === null) await save({ kind: 'cutOff', fleetId: null, personShipId: null });
      for (const right of rights.filter((right) => input.fleetId === null || right.fleetId === input.fleetId)) {
        await records.saveRight({ ...right, scopes: [], groupValues: [], isFleetManager: false });
        await save({ kind: 'fleet', fleetId: right.fleetId, personShipId: right.personShipId });
        await save({ kind: 'gateway', fleetId: right.fleetId, personShipId: right.personShipId });
      }
      return { kind: 'saved' as const };
    }),
    /**
     * One target per transaction bounds work. Holding the lock prevents late cleanup racing recovery.
     * Pending means this attempt made progress and more may wait; failed means the target stays unacknowledged.
     */
    reconcile: (accountId?: AccountId) => deps.identity.transaction(async (records) => {
      const target = await records.pendingCleanup(accountId);
      if (target === null) return { kind: 'complete' as const };
      const outcome = await acknowledge({ cleanup: deps.cleanup, target });
      if (!outcome.isOk) { await records.saveCleanup({ ...target, attempts: target.attempts + 1 }); return { kind: 'failed' as const }; }
      const progress = outcome.value;
      switch (progress.kind) {
        case 'acknowledged': await records.deleteCleanup(target.id); break;
        case 'pageReleased': await records.saveCleanup({ ...target, attempts: target.attempts + 1, cursor: progress.cursor }); break;
        case 'personShipFound': {
          if (target.fleetId !== null) {
            const right = await records.right({ accountId: target.accountId, fleetId: target.fleetId });
            if (right === null) return { kind: 'failed' as const };
            await records.saveRight({ ...right, personShipId: progress.personShipId });
          }
          await records.saveCleanup({ ...target, attempts: target.attempts + 1, personShipId: progress.personShipId });
          break;
        }
      }
      return { kind: 'pending' as const };
    }),
    recover: async (input: { accountId: AccountId; password: string; shouldEnable: boolean; fleetId: FleetId | null }) => {
      const passwordHash = await deps.secrets.hashPassword(input.password);
      return deps.identity.transaction(async (records) => {
        const account = await records.accountById(input.accountId);
        if (account === null) return { kind: 'notFound' as const };
        if (await records.pendingCleanup(account.id) !== null) return { kind: 'pending' as const };
        await records.saveAccount({ ...account, passwordHash, isDisabled: input.shouldEnable ? false : account.isDisabled, accessVersion: account.accessVersion + 1 });
        await records.revokeSharedSignIns(account.id);
        if (input.fleetId !== null) {
          const right = await records.right({ accountId: account.id, fleetId: input.fleetId });
          await records.saveRight({ accountId: account.id, fleetId: input.fleetId, personShipId: right?.personShipId ?? null, scopes: [], groupValues: [], isFleetManager: true });
        }
        return { kind: 'recovered' as const };
      });
    },
  };
}

/** A remote call that fails outright leaves the target pending, as an unacknowledged one does. */
async function acknowledge(input: { cleanup: AccessCleanup; target: CleanupTarget }): Promise<Result<CleanupProgress, CleanupFailure>> {
  try { return await input.cleanup.acknowledge(input.target); }
  catch { return { isOk: false, error: { kind: 'unavailable' } }; }
}
