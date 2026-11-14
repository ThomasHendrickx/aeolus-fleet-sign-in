/** Shared sign-out revokes locally before core and remains retryable without restoring access. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createSignOut } from './sign-out.js';

describe('Maya signs out across apps', () => {
  it('revokes locally before contacting core and retries the same account after core fails', async () => {
    // Given Maya's shared sign-in and a core outage.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const signOut = createSignOut({ signIn: fixture.signIn, sessions: fixture.fleet });
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
});
