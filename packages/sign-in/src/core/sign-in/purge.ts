/** Expired identity records have no further role after refusal and sign-out retry windows. */
import type { Identity } from '../shared/identity.js';
import { ATTEMPT_WINDOW, REVOKED_RETRY_WINDOW } from './sign-in.js';

export function createPurge(deps: { identity: Identity; now: () => number }) {
  return async () => {
    const now = deps.now();
    await deps.identity.transaction((records) => records.purgeExpired({ now, attemptsBefore: now - ATTEMPT_WINDOW, revokedBefore: now - REVOKED_RETRY_WINDOW }));
  };
}
