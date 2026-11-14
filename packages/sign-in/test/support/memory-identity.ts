/** Handwritten transactional identity boundary, with rollback and serialized concurrency. */
import type { AccountId } from '@aeolus-fleet/common';

import type { Account, CleanupTarget, Authorization, AuthorizationCode, FailedAttempts, FleetRight, IdentityRecords, SharedSignIn } from '../../src/core/shared/identity.js';

export function memoryIdentity() {
  const cleanup = new Map<string, CleanupTarget>();
  const accounts = new Map<string, Account>();
  const rights = new Map<string, FleetRight>();
  const sharedSignIns = new Map<string, SharedSignIn>();
  const authorizations = new Map<string, Authorization>();
  const codes = new Map<string, AuthorizationCode>();
  const attempts = new Map<string, FailedAttempts>();
  let previous: Promise<unknown> = Promise.resolve();
  const records: IdentityRecords = {
    rights: (accountId) => Promise.resolve([...rights.values()].filter((right) => right.accountId === accountId)),
    revokeSharedSignIns: (accountId) => { for (const [hash, shared] of sharedSignIns) if (shared.accountId === accountId) sharedSignIns.delete(hash); return Promise.resolve(); },
    pendingCleanup: (accountId) => Promise.resolve([...cleanup.values()].sort((left, right) => left.attempts - right.attempts).find((target) => accountId === undefined || target.accountId === accountId) ?? null),
    saveCleanup: (target) => { cleanup.set(target.id, target); return Promise.resolve(); },
    deleteCleanup: (id) => { cleanup.delete(id); return Promise.resolve(); },
    hasAccounts: () => Promise.resolve(accounts.size > 0),
    sharedSignIn: (hash) => Promise.resolve(sharedSignIns.get(hash) ?? null),
    saveSharedSignIn: ({ hash, sharedSignIn }) => { sharedSignIns.set(hash, sharedSignIn); return Promise.resolve(); },
    deleteSharedSignIn: (hash) => { sharedSignIns.delete(hash); return Promise.resolve(); },
    authorization: (hash) => Promise.resolve(authorizations.get(hash) ?? null),
    saveAuthorization: ({ hash, authorization }) => { authorizations.set(hash, authorization); return Promise.resolve(); },
    deleteAuthorization: (hash) => { authorizations.delete(hash); return Promise.resolve(); },
    code: (hash) => Promise.resolve(codes.get(hash) ?? null),
    saveCode: ({ hash, code }) => { codes.set(hash, code); return Promise.resolve(); },
    deleteCode: (hash) => { codes.delete(hash); return Promise.resolve(); },
    attempts: (key) => Promise.resolve(attempts.get(key) ?? null),
    saveAttempts: ({ key, attempts: saved }) => { attempts.set(key, saved); return Promise.resolve(); },
    account: (email) => Promise.resolve(accounts.get(email) ?? null),
    accountById: (id: AccountId) => Promise.resolve([...accounts.values()].find((account) => account.id === id) ?? null),
    saveAccount: (account) => { accounts.set(account.email, account); return Promise.resolve(); },
    right: ({ accountId, fleetId }) => Promise.resolve(rights.get(`${fleetId}/${accountId}`) ?? null),
    pendingRight: (fleetId) => Promise.resolve([...rights.values()].find((right) => right.fleetId === fleetId && right.isFleetManager && right.personShipId === null) ?? null),
    saveRight: (right) => { rights.set(`${right.fleetId}/${right.accountId}`, right); return Promise.resolve(); },
  };
  return {
    cleanup, accounts, rights, sharedSignIns, authorizations, codes, attempts,
    async transaction<T>(work: (records: IdentityRecords) => Promise<T>): Promise<T> {
      const held = previous;
      const released = Promise.withResolvers<undefined>();
      previous = released.promise;
      await held;
      const savedCleanup = new Map(cleanup);
      const savedSharedSignIns = new Map(sharedSignIns);
      const savedAuthorizations = new Map(authorizations);
      const savedCodes = new Map(codes);
      const savedAttempts = new Map(attempts);
      const savedAccounts = new Map(accounts);
      const savedRights = new Map(rights);
      try { return await work(records); }
      catch (error) {
        cleanup.clear(); savedCleanup.forEach((value, key) => cleanup.set(key, value));
        sharedSignIns.clear(); savedSharedSignIns.forEach((value, key) => sharedSignIns.set(key, value));
        authorizations.clear(); savedAuthorizations.forEach((value, key) => authorizations.set(key, value));
        codes.clear(); savedCodes.forEach((value, key) => codes.set(key, value));
        attempts.clear(); savedAttempts.forEach((value, key) => attempts.set(key, value));
        accounts.clear(); savedAccounts.forEach((account, key) => accounts.set(key, account));
        rights.clear(); savedRights.forEach((right, key) => rights.set(key, right));
        throw error;
      } finally { released.resolve(undefined); }
    },
  };
}
