/** The owner's retention deadline preserves live lockouts and sign-out retries. */
import { expect, it } from 'vitest';

import { memoryIdentity } from '../../../test/support/memory-identity.js';
import { aSetup } from '../../../test/support/setup-fixtures.js';
import { createPurge } from './purge.js';

it('purges expired records while keeping active failed attempts and recent sign-out retries', async () => {
  // Given expired records and records that still protect sign-in or allow sign-out retry.
  const identity = memoryIdentity();
  identity.authorizations.set('expired', { clientId: 'console', redirectUri: 'https://console.example.test', state: 'state', codeChallenge: 'challenge', browser: 'browser', expiresAt: 900_000 });
  identity.codes.set('expired', { clientId: 'console', redirectUri: 'https://console.example.test', codeChallenge: 'challenge', signInHash: 'shared', expiresAt: 900_000 });
  const accountId = aSetup().secrets.accountId();
  identity.sharedSignIns.set('expired', { accountId, expiresAt: 900_000 });
  identity.sharedSignIns.set('retry', { accountId, expiresAt: 0, revokedAt: 1 });
  identity.attempts.set('expired', { failures: [0], refusedUntil: 900_000 });
  identity.attempts.set('recent', { failures: [1], refusedUntil: 0 });
  identity.attempts.set('locked', { failures: [0], refusedUntil: 900_001 });
  let now = 900_000;
  const purge = createPurge({ identity, now: () => now });

  // When the deadline is reached and purge retries at the next deadline.
  await purge();
  expect(identity.authorizations.size).toBe(0);
  expect(identity.codes.size).toBe(0);
  expect([...identity.sharedSignIns.keys()]).toEqual(['retry']);
  expect([...identity.attempts.keys()]).toEqual(['recent', 'locked']);
  now = 900_001;
  await purge();
  await purge();

  // Then expired records are gone without a request touching them.
  expect(identity.sharedSignIns.size).toBe(0);
  expect(identity.attempts.size).toBe(0);
});
