/** Approved credential limits, fixed session lifetime and one-use browser-bound code/PKCE. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';

const request = { clientId: 'console', redirectUri: 'https://console.example.test/sign-in/done', state: 'console-state', codeChallenge: 'digest:verifier', browser: 'first-browser' };

describe('Maya signs in to her local account', () => {
  it('refuses the fifth failed account attempt for 15 minutes, including correct credentials', async () => {
    // Given Maya's local account and four failed attempts.
    const fixture = await signInOfMaya();
    for (let count = 0; count < 4; count += 1) expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: `address-${count}` })).kind).toBe('wrongCredential');

    // When the fifth failure reaches the account threshold.
    expect(await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: 'address-5' })).toEqual({ kind: 'tooManyAttempts', retryAt: 900_000 });
    fixture.now = 899_999;

    // Then even the right password waits, but the exact retry time allows authentication.
    expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'new-address' })).kind).toBe('tooManyAttempts');
    fixture.now = 900_000;
    expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'new-address' })).kind).toBe('authenticated');
  });

  it('refuses the twentieth failed address attempt across unknown identifiers without disclosing accounts', async () => {
    // Given a single address trying different emails.
    const fixture = await signInOfMaya();
    for (let count = 0; count < 19; count += 1) expect((await fixture.signIn.authenticate({ email: `unknown-${count}@example.test`, password: 'wrong', address: 'one-address' })).kind).toBe('wrongCredential');

    // When the twentieth address attempt fails.
    const refused = await fixture.signIn.authenticate({ email: 'unknown-20@example.test', password: 'wrong', address: 'one-address' });

    // Then the address has the same 15-minute refusal, regardless of account existence.
    expect(refused).toEqual({ kind: 'tooManyAttempts', retryAt: 900_000 });
    expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'one-address' })).kind).toBe('tooManyAttempts');
    expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'different-address' })).kind).toBe('authenticated');
  });

  it('counts failures within the previous 15 minutes across the first failure window boundary', async () => {
    // Given an old failure followed by three recent failures.
    const fixture = await signInOfMaya();
    await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: 'address' });
    fixture.now = 840_000;
    for (let count = 0; count < 3; count += 1) await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: 'address' });

    // When the oldest failure ages out, but two more failures join the recent three.
    fixture.now = 900_001;
    expect((await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: 'address' })).kind).toBe('wrongCredential');
    const refused = await fixture.signIn.authenticate({ email: 'maya@example.test', password: 'wrong', address: 'address' });

    // Then five failures in the previous 15 minutes enforce the approved refusal.
    expect(refused).toEqual({ kind: 'tooManyAttempts', retryAt: 1_800_001 });
  });

  it('expires a shared sign-in exactly 12 hours from authentication without extending it on use', async () => {
    // Given a successful local authentication.
    const fixture = await signInOfMaya();
    const authenticated = await fixture.authenticate();

    // When it is used shortly before the fixed deadline.
    fixture.now = 43_199_999;
    expect((await fixture.signIn.account(authenticated.signIn)).kind).toBe('account');
    fixture.now = 43_200_000;

    // Then it is signed out, despite that recent use.
    expect(await fixture.signIn.account(authenticated.signIn)).toEqual({ kind: 'signedOut' });
  });

  it('binds authorization to the initiating browser and redeems a code once with its verifier', async () => {
    // Given an authorization request with a specific browser and PKCE challenge.
    const fixture = await signInOfMaya();
    const flow = await fixture.signIn.begin(request);
    const authenticated = await fixture.authenticate();

    // When another browser or verifier tries the same flow/code.
    expect(await fixture.signIn.complete({ flow: flow.flow, browser: 'another-browser', signIn: authenticated.signIn })).toEqual({ kind: 'invalidFlow' });
    const completed = await fixture.signIn.complete({ flow: flow.flow, browser: request.browser, signIn: authenticated.signIn });
    expect(completed.kind).toBe('authorized');
    if (completed.kind !== 'authorized') return;
    const redemption = { code: completed.code, clientId: request.clientId, redirectUri: request.redirectUri, verifier: 'wrong' };
    expect(await fixture.signIn.redeem(redemption)).toEqual({ kind: 'invalidGrant' });

    // Then a new code with its own verifier succeeds only once, including concurrent redemption.
    const next = await fixture.signIn.begin(request);
    const authorized = await fixture.signIn.complete({ flow: next.flow, browser: request.browser, signIn: authenticated.signIn });
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    const results = await Promise.all([1, 2].map(() => fixture.signIn.redeem({ ...redemption, code: authorized.code, verifier: 'verifier' })));
    expect(results.map((result) => result.kind).sort()).toEqual(['invalidGrant', 'redeemed']);
    expect(await fixture.signIn.complete({ flow: next.flow, browser: request.browser, signIn: authenticated.signIn })).toEqual({ kind: 'invalidFlow' });
  });

  it('refuses expired flows and revokes the shared sign-in across clients', async () => {
    // Given a pending flow and an authenticated shared sign-in.
    const fixture = await signInOfMaya();
    const flow = await fixture.signIn.begin(request);
    const authenticated = await fixture.authenticate();

    // When the flow expires, then the shared sign-in is revoked.
    fixture.now = 600_000;
    expect(await fixture.signIn.complete({ flow: flow.flow, browser: request.browser, signIn: authenticated.signIn })).toEqual({ kind: 'invalidFlow' });
    await fixture.signIn.revoke(authenticated.signIn);

    // Then neither client can use it again.
    expect(await fixture.signIn.account(authenticated.signIn)).toEqual({ kind: 'signedOut' });
  });
});
