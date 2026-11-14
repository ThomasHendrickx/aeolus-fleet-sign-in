/** Shared revocation commits before core is contacted; retained identity makes a client retry safe. */
import type { AccountId } from '@aeolus-fleet/common';

import type { createSignIn } from './sign-in.js';

export interface AccountSessions {
  signOut(accountId: AccountId): Promise<void>;
}

export function createSignOut(deps: { signIn: Pick<ReturnType<typeof createSignIn>, 'revoke'>; sessions: AccountSessions; log: (error: unknown) => void }) {
  return async (signIn: string) => {
    let accountId: AccountId | null;
    try {
      accountId = await deps.signIn.revoke(signIn);
    } catch (error) {
      deps.log(error);
      return { kind: 'failed' as const };
    }
    if (accountId === null) return { kind: 'signedOut' as const };
    try {
      await deps.sessions.signOut(accountId);
      return { kind: 'signedOut' as const };
    } catch {
      return { kind: 'unavailable' as const };
    }
  };
}
