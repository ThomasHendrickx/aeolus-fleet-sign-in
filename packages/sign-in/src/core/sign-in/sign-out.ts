/** Shared revocation commits before core is contacted; retained identity makes a client retry safe. */
import type { AccountId } from '@aeolus-fleet/common';

import type { createSignIn } from './sign-in.js';

export interface AccountSessions {
  signOut(accountId: AccountId): Promise<void>;
}

export function createSignOut(deps: { signIn: Pick<ReturnType<typeof createSignIn>, 'revoke'>; sessions: AccountSessions }) {
  return async (signIn: string) => {
    try {
      const accountId = await deps.signIn.revoke(signIn);
      if (accountId !== null) await deps.sessions.signOut(accountId);
      return { kind: 'signedOut' as const };
    } catch {
      return { kind: 'unavailable' as const };
    }
  };
}
