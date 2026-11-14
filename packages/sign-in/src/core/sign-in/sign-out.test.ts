/** Shared sign-out revokes locally before core and remains retryable without restoring access. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createSignOut } from './sign-out.js';

describe('Maya signs out across apps', () => {
  it('revokes locally before contacting core and retries the same account after core fails', async () => {
    // Given Maya's shared sign-in and a core outage.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const signOut = createSignOut({ signIn: fixture.signIn, sessions: fixture.fleet, log: () => undefined });
    fixture.fleet.shouldFailSignOut = true;

    // When sign-out fails remotely, local access is already revoked, and a retry can finish.
    expect(await signOut(shared.signIn)).toEqual({ kind: 'unavailable' });
    expect(await fixture.signIn.account(shared.signIn)).toEqual({ kind: 'signedOut' });
    fixture.fleet.shouldFailSignOut = false;
    expect(await signOut(shared.signIn)).toEqual({ kind: 'signedOut' });

    // Then core ended the existing account's linked sessions, while identity and mapping remain.
    expect(fixture.fleet.signedOutAccounts).toEqual(new Set(['maya-opaque-account']));
    expect(fixture.identity.accounts.size).toBe(1);
    expect(fixture.fleet.people.size).toBe(1);
    expect(await signOut('unknown-sign-in')).toEqual({ kind: 'signedOut' });
  });

  it('does not end the account sessions for a shared sign-in that ended naturally or was revoked long ago', async () => {
    // Given Maya's current console sessions and two old shared sign-ins: one expired, one revoked.
    const fixture = await signInOfMaya();
    const signOut = createSignOut({ signIn: fixture.signIn, sessions: fixture.fleet, log: () => undefined });
    const expired = await fixture.authenticate();
    const revoked = await fixture.authenticate();
    expect(await signOut(revoked.signIn)).toEqual({ kind: 'signedOut' });
    fixture.fleet.signedOutAccounts.clear();

    // When a stale token is sent for sign-out a day later.
    fixture.now = 24 * 60 * 60 * 1000;
    expect(await signOut(expired.signIn)).toEqual({ kind: 'signedOut' });
    expect(await signOut(revoked.signIn)).toEqual({ kind: 'signedOut' });

    // Then core is not contacted and the ended records are gone.
    expect(fixture.fleet.signedOutAccounts.size).toBe(0);
    expect(fixture.identity.sharedSignIns.size).toBe(0);
  });

  it('logs a local failure and reports it as failed instead of reporting core unavailable', async () => {
    // Given local revocation that fails.
    const failure = new Error('Database unavailable');
    const logged: unknown[] = [];
    const signOut = createSignOut({ signIn: { revoke: () => Promise.reject(failure) }, sessions: { signOut: () => Promise.resolve() }, log: (error) => logged.push(error) });
    // When Maya signs out, then the failure is logged and reported as failed, not as core unavailable.
    // When Maya signs out, then the failure is logged and 
    expect(await signOut('any-sign-in')).toEqual({ kind: 'failed' });
    expect(logged).toEqual([failure]);
  });
});
