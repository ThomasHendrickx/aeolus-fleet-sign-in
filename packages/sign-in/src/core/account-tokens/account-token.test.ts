/** Fleet tokens carry manager rights, the stable person mapping and no argo permission. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createAccountToken } from './account-token.js';

describe('a fresh fleet token for Maya', () => {
  it('reconciles offered manager scopes and signs a 10-minute token for the existing person ship', async () => {
    // Given Maya's shared sign-in and persisted fleet-manager grant.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const token = createAccountToken({ ...fixture, now: () => fixture.now, issuer: 'https://signin.example.test', signer: { sign: (claims) => Promise.resolve(JSON.stringify(claims)) } });

    // When the console or gateway exchanges the shared sign-in for workshop.
    const result = await token({ signIn: shared.signIn, fleetId: 'flt_00000000000000000000000001' });

    // Then the token names the same opaque identity and person, with explicit manager scopes and no argo.
    expect(result.kind).toBe('token');
    if (result.kind !== 'token') return;
    const claims: unknown = JSON.parse(result.token);
    expect(claims).toEqual({ iss: 'https://signin.example.test', aud: 'flt_00000000000000000000000001', sub: 'maya-opaque-account', org: 'local', group: ['fleet-manager'], scope: 'messages:send messages:receive fleet:read fleet:commission', person_ship: 'shp_00000000000000000000000001', argo: false, iat: 0, exp: 600 });
    expect(result.expiresIn).toBe(600);
    expect(fixture.fleet.people.size).toBe(1);
  });

  it('distinguishes no rights, signed out and unavailable without falling back to argo', async () => {
    // Given one valid sign-in with rights only in workshop.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const token = createAccountToken({ ...fixture, now: () => fixture.now, issuer: 'https://signin.example.test', signer: { sign: () => Promise.resolve('token') } });

    // When the fleet is unknown, the sign-in is absent, or provisioning is inaccessible.
    expect(await token({ signIn: shared.signIn, fleetId: 'flt_00000000000000000000000002' })).toEqual({ kind: 'noRights' });
    expect(await token({ signIn: 'not-a-shared-sign-in', fleetId: 'flt_00000000000000000000000001' })).toEqual({ kind: 'signedOut' });
    fixture.fleet.shouldLoseConfirmation = true;

    // Then only the service failure is unavailable, never a credential error or argo access.
    expect(await token({ signIn: shared.signIn, fleetId: 'flt_00000000000000000000000001' })).toEqual({ kind: 'unavailable' });
  });
});
