/** The fleets a shared sign-in may open: only those where its account holds fleet rights. */
import type { FleetId } from '@aeolus-fleet/common';

import type { createSignIn } from '../sign-in/sign-in.js';
import type { Identity } from '../shared/identity.js';

export function createOpenableFleets(deps: { identity: Identity; signIn: Pick<ReturnType<typeof createSignIn>, 'account'> }) {
  return async (input: { signIn: string; fleetIds: readonly FleetId[] }) => {
    const shared = await deps.signIn.account(input.signIn);
    if (shared.kind === 'signedOut') return shared;
    const { account } = shared;
    const rights = await deps.identity.transaction((records) => Promise.all(input.fleetIds.map((fleetId) => records.right({ accountId: account.id, fleetId }))));
    const fleetIds = rights.flatMap((right) => right !== null && right.scopes.length > 0 ? [right.fleetId] : []);
    return { kind: 'fleets' as const, account, fleetIds };
  };
}
