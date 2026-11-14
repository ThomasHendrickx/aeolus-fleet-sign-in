/** Handwritten transactional identity boundary, with rollback and serialized concurrency. */
import type { AccountId } from '@aeolus-fleet/common';

import type { Account, FleetRight, IdentityRecords } from '../../src/core/shared/identity.js';

export function memoryIdentity() {
  const accounts = new Map<string, Account>();
  const rights = new Map<string, FleetRight>();
  let previous: Promise<unknown> = Promise.resolve();
  const records: IdentityRecords = {
    account: (email) => Promise.resolve(accounts.get(email) ?? null),
    accountById: (id: AccountId) => Promise.resolve([...accounts.values()].find((account) => account.id === id) ?? null),
    saveAccount: (account) => { accounts.set(account.email, account); return Promise.resolve(); },
    right: ({ accountId, fleetId }) => Promise.resolve(rights.get(`${fleetId}/${accountId}`) ?? null),
    saveRight: (right) => { rights.set(`${right.fleetId}/${right.accountId}`, right); return Promise.resolve(); },
  };
  return {
    accounts, rights,
    async transaction<T>(work: (records: IdentityRecords) => Promise<T>): Promise<T> {
      const held = previous;
      const released = Promise.withResolvers<undefined>();
      previous = released.promise;
      await held;
      const savedAccounts = new Map(accounts);
      const savedRights = new Map(rights);
      try { return await work(records); }
      catch (error) {
        accounts.clear(); savedAccounts.forEach((account, key) => accounts.set(key, account));
        rights.clear(); savedRights.forEach((right, key) => rights.set(key, right));
        throw error;
      } finally { released.resolve(undefined); }
    },
  };
}
