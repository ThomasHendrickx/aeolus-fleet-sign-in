/** Handwritten transactional identity boundary, with rollback and serialized concurrency. */
import type { AccountId } from '@aeolus-fleet/common';

import type { Account, Authorization, AuthorizationCode, FailedAttempts, FleetRight, IdentityRecords, SharedSignIn } from '../../src/core/shared/identity.js';

export function memoryIdentity() {
  const accounts = new Map<string, Account>();
  const rights = new Map<string, FleetRight>();
  const sharedSignIns = new Map<string, SharedSignIn>();
  const authorizations = new Map<string, Authorization>();
  const codes = new Map<string, AuthorizationCode>();
  const attempts = new Map<string, FailedAttempts>();
  let previous: Promise<unknown> = Promise.resolve();
  const records: IdentityRecords = {
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
    saveRight: (right) => { rights.set(`${right.fleetId}/${right.accountId}`, right); return Promise.resolve(); },
  };
  return {
    accounts, rights, sharedSignIns, authorizations, codes, attempts,
    async transaction<T>(work: (records: IdentityRecords) => Promise<T>): Promise<T> {
      const held = previous;
      const released = Promise.withResolvers<undefined>();
      previous = released.promise;
      await held;
      const savedSharedSignIns = new Map(sharedSignIns);
      const savedAuthorizations = new Map(authorizations);
      const savedCodes = new Map(codes);
      const savedAttempts = new Map(attempts);
      const savedAccounts = new Map(accounts);
      const savedRights = new Map(rights);
      try { return await work(records); }
      catch (error) {
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
