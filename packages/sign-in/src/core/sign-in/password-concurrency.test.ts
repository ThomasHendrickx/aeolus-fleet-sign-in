/** Issue #3: password work leaves identity transitions available without weakening credential or lockout checks. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createSignIn } from './sign-in.js';

const credential = { email: 'maya@example.test', password: 'private-password', address: 'slow-address' };

async function pausedPassword() {
  const fixture = await signInOfMaya();
  const original = fixture.signIn;
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<boolean>();
  const signIn = createSignIn({ identity: fixture.identity, now: () => fixture.now, secrets: {
    token: () => 'slow-sign-in',
    digest: (value) => Promise.resolve(`digest:${value}`),
    verifyPassword: () => { entered.resolve(undefined); return released.promise; },
  } });
  return Object.assign(fixture, { signIn, entered, released, authenticateWrong: (index: number) => original.authenticate({ ...credential, password: 'wrong', address: `address-${index}` }) });
}

describe('password verification outside the identity lock', () => {
  it('allows another sign-in and single-use code redemption while a password check waits', async () => {
    // Given a password check held at the secrets boundary.
    const fixture = await pausedPassword();
    const pending = fixture.signIn.authenticate(credential);
    await fixture.entered.promise;
    try {
      // When another browser authenticates and concurrently redeems its code.
      const shared = await fixture.authenticate();
      const flow = await fixture.signIn.begin({ clientId: 'console', redirectUri: 'https://console.example.test/done', state: 'state', codeChallenge: 'digest:verifier', browser: 'browser' });
      const completed = await fixture.signIn.complete({ flow: flow.flow, browser: 'browser', signIn: shared.signIn });
      expect(completed.kind).toBe('authorized');
      if (completed.kind !== 'authorized') return;
      const redeem = () => fixture.signIn.redeem({ code: completed.code, clientId: 'console', redirectUri: completed.redirectUri, verifier: 'verifier' });
      const results = await Promise.all([redeem(), redeem()]);

      // Then identity access continues, and the code still succeeds only once.
      expect(results.map((result) => result.kind).sort()).toEqual(['invalidGrant', 'redeemed']);
      expect((await fixture.signIn.account(shared.signIn)).kind).toBe('account');
    } finally {
      fixture.released.resolve(true);
      await pending;
    }
  }, 1000);

  it.each(['password', 'disabled', 'accessVersion'] as const)('refuses a credential when %s changes during verification', async (change) => {
    // Given verification against the old account state.
    const fixture = await pausedPassword();
    const pending = fixture.signIn.authenticate(credential);
    await fixture.entered.promise;

    // When recovery or removal changes that state before verification finishes.
    try {
      await fixture.identity.transaction(async (records) => {
        const account = await records.account(credential.email);
        expect(account).not.toBeNull();
        if (account === null) return;
        await records.saveAccount({ ...account, passwordHash: change === 'password' ? 'replacement-hash' : account.passwordHash, isDisabled: change === 'disabled', accessVersion: account.accessVersion + (change === 'accessVersion' ? 1 : 0) });
      });
    } finally { fixture.released.resolve(true); }
    const result = await pending;

    // Then stale verification cannot create a shared sign-in.
    expect(result.kind).toBe('wrongCredential');
    expect(fixture.identity.sharedSignIns.size).toBe(0);
  }, 1000);

  it('counts concurrent failures once and refuses an in-flight correct password after lockout without extending it', async () => {
    // Given a correct password waiting while other attempts can complete.
    const fixture = await pausedPassword();
    const pending = fixture.signIn.authenticate(credential);
    await fixture.entered.promise;
    let failures;

    // When five concurrent failures reach the account threshold before it finishes.
    try {
      failures = await Promise.all(Array.from({ length: 5 }, (_, index) => fixture.authenticateWrong(index)));
      fixture.now = 1000;
    } finally { fixture.released.resolve(true); }
    const result = await pending;

    // Then all five failures are retained, and the waiting attempt respects the original deadline.
    expect(failures.map((failure) => failure.kind).sort()).toEqual(['tooManyAttempts', 'wrongCredential', 'wrongCredential', 'wrongCredential', 'wrongCredential']);
    expect(result).toEqual({ kind: 'tooManyAttempts', retryAt: 900_000 });
    expect(fixture.identity.attempts.get('account:digest:maya@example.test')).toEqual({ failures: [0, 0, 0, 0, 0], refusedUntil: 900_000 });
    expect(fixture.identity.sharedSignIns.size).toBe(0);
  }, 1000);
});
