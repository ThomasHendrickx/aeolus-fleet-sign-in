/** Issues fresh fleet claims only for a live shared sign-in with an existing grant. */
import type { accountTokenClaimsSchema, FleetId, ShipId } from '@aeolus-fleet/common';
import type { z } from 'zod';

import type { createSignIn } from '../sign-in/sign-in.js';
import type { Identity, PersonFleets } from '../shared/identity.js';

export type FleetClaims = Omit<z.input<typeof accountTokenClaimsSchema>, 'aud' | 'person_ship'> & { readonly aud: FleetId; readonly person_ship?: ShipId };

export interface AccountTokenSigner {
  sign(claims: FleetClaims): Promise<string>;
}

const TOKEN_SECONDS = 600;
const MILLISECONDS = 1000;

export function createAccountToken(deps: { identity: Identity; fleet: PersonFleets; signIn: Pick<ReturnType<typeof createSignIn>, 'account'>; signer: AccountTokenSigner; issuer: string; now: () => number }) {
  return async (input: { signIn: string; fleetId: FleetId }) => {
    try {
      const shared = await deps.signIn.account(input.signIn);
      if (shared.kind === 'signedOut') return shared;
      const { account } = shared;
      const right = await deps.identity.transaction((records) => records.right({ accountId: account.id, fleetId: input.fleetId }));
      if (right === null || (right.scopes.length === 0 && !right.isFleetManager)) return { kind: 'noRights' as const };
      const fleetRight = right.isFleetManager ? await deps.fleet.reconcile({ accountId: account.id, fleetId: input.fleetId }) : { kind: 'reconciled' as const, right };
      if (fleetRight.kind === 'installationRefused') return { kind: 'unavailable' as const };
      const reconciled = fleetRight.right;
      await deps.identity.transaction((records) => records.saveRight(reconciled));
      const issuedAt = Math.floor(deps.now() / MILLISECONDS);
      const token = await deps.signer.sign({
        iss: deps.issuer, aud: input.fleetId, sub: account.id, org: account.organisationId,
        scope: reconciled.scopes.join(' '), group: [...reconciled.groupValues],
        ...(reconciled.personShipId === null ? {} : { person_ship: reconciled.personShipId }),
        argo: false, iat: issuedAt, exp: issuedAt + TOKEN_SECONDS,
      });
      return { kind: 'token' as const, token, expiresIn: TOKEN_SECONDS };
    } catch {
      return { kind: 'unavailable' as const };
    }
  };
}
