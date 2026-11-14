/** Deterministic clock, secrets and in-memory ports for approved sign-in scenarios. */
import { createSetup } from '../../src/core/accounts/setup.js';
import { createSignIn } from '../../src/core/sign-in/sign-in.js';
import { memoryIdentity } from './memory-identity.js';
import { aSetup, fleetOfMaya } from './setup-fixtures.js';

export async function signInOfMaya() {
  const identity = memoryIdentity();
  const fleet = fleetOfMaya(identity);
  await createSetup({ identity, fleet, secrets: aSetup().secrets }).establish(aSetup().input);
  let sequence = 0;
  const fixture = { now: 0 };
  const signIn = createSignIn({ identity, now: () => fixture.now, secrets: {
    token: () => `secret-${++sequence}`,
    digest: (value) => Promise.resolve(`digest:${value}`),
    verifyPassword: ({ password, hash }) => Promise.resolve(hash !== null && password === 'private-password'),
  } });
  return Object.assign(fixture, { identity, fleet, signIn, async authenticate() {
    const result = await signIn.authenticate({ email: 'maya@example.test', password: 'private-password', address: 'trusted-address' });
    if (result.kind !== 'authenticated') throw new Error('Fixture authentication refused');
    return result;
  } });
}
