/** Fleet tokens carry manager rights, the stable person mapping and no argo permission. */
import { describe, expect, it } from 'vitest';

import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createAccess } from '../reconciliation/access.js';
import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createAccountToken } from './account-token.js';
import { unavailable } from '../../../test/support/cleanup-outcomes.js';

describe('a fresh fleet token for Maya', () => {
  it.each(['shared sign-in', 'identity', 'reconciliation', 'signing'])('surfaces an unexpected %s error instead of reporting unavailable', async (boundary) => {
    // Given a live shared sign-in and a programming error at a dependency boundary.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const failure = new TypeError('Unexpected defect');
    const reject = () => Promise.reject(failure);
    const token = createAccountToken({ ...fixture, now: () => fixture.now, issuer: 'https://signin.example.test',
      ...(boundary === 'shared sign-in' ? { signIn: { account: reject } } : {}),
      ...(boundary === 'identity' ? { identity: { transaction: reject } } : {}),
      ...(boundary === 'reconciliation' ? { fleet: { reconcile: reject } } : {}),
      signer: { sign: boundary === 'signing' ? reject : () => Promise.resolve('token') },
    });

    // When the shared sign-in is exchanged for a fleet token.
    const exchange = token({ signIn: shared.signIn, fleetId: aSetup().input.fleetId });

    // Then the original error reaches the caller.
    await expect(exchange).rejects.toBe(failure);
  });

  it('refuses a new credential sign-in after disable and prevents an in-flight exchange restoring removed rights', async () => {
    // Given an exchange paused at core while Maya still has rights.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const accountId = aSetup().secrets.accountId();
    const fleetId = aSetup().input.fleetId;
    const access = createAccess({ identity: fixture.identity, secrets: aSetup().secrets, cleanup: { acknowledge: () => Promise.resolve(unavailable) } });
    const reached = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const token = createAccountToken({ ...fixture, now: () => fixture.now, issuer: 'https://signin.example.test', signer: { sign: () => Promise.resolve('must-not-be-issued') }, fleet: { async reconcile(input) {
      const result = await fixture.fleet.reconcile(input);
      reached.resolve(undefined);
      await resume.promise;
      return result;
    } } });
    const exchange = token({ signIn: shared.signIn, fleetId });
    await reached.promise;

    // When removal commits is serialised behind the in-flight exchange.
    const removal = access.remove({ accountId, fleetId: null });
    resume.resolve(undefined);
    await exchange;
    await removal;

    // Then no subsequent token or grant is restored and the old credential cannot open another session.
    expect(await token({ signIn: shared.signIn, fleetId })).toEqual({ kind: 'signedOut' });
    expect(await fixture.signIn.authenticate({ email: aSetup().input.email, password: aSetup().input.password, address: 'new-browser' })).toEqual({ kind: 'wrongCredential' });
    expect(await fixture.identity.transaction((records) => records.right({ accountId, fleetId }))).toMatchObject({ scopes: [], isFleetManager: false });
  });

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
