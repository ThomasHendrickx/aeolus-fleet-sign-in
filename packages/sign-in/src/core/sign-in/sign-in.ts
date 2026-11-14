/** Durable browser-bound authorization and fixed-lifetime shared sign-ins. */
import { normalisedEmail } from '../accounts/email.js';
import type { Authorization, FailedAttempts, Identity, IdentityRecords, SharedSignIn, SignInSecrets } from '../shared/identity.js';

/** Failures count within this window, and reaching a limit refuses attempts for as long. */
export const ATTEMPT_WINDOW = 15 * 60 * 1000;
const ACCOUNT_FAILURES = 5;
const ADDRESS_FAILURES = 20;
const SHARED_SIGN_IN_LIFE = 12 * 60 * 60 * 1000;
/** A revoked shared sign-in stays this long so a client can retry a sign-out that core did not finish. */
const REVOKED_RETRY_WINDOW = 15 * 60 * 1000;
const FLOW_LIFE = 10 * 60 * 1000;

export function createSignIn(deps: { identity: Identity; secrets: SignInSecrets; now: () => number }) {
  const digest = (value: string) => deps.secrets.digest(value);
  const transaction = deps.identity.transaction.bind(deps.identity);

  async function openFlow(records: IdentityRecords, input: { flowHash: string; browser: string }) {
    const flow = await records.authorization(input.flowHash);
    return flow !== null && flow.expiresAt > deps.now() && flow.browser === await digest(input.browser) ? flow : null;
  }

  /** An expired, other-browser or refused flow starts again at the client that began it, when known. */
  async function startAgain(flow: string) {
    const flowHash = await digest(flow);
    const held = await transaction((records) => records.authorization(flowHash));
    return { kind: 'startAgain' as const, clientId: held?.clientId ?? null };
  }

  async function accountIn(records: IdentityRecords, hash: string) {
    const held = await records.sharedSignIn(hash);
    if (held === null) return null;
    if (held.expiresAt <= deps.now()) {
      await dropUnlessRetryable(records, { hash, held });
      return null;
    }
    return records.accountById(held.accountId);
  }

  /** An ended record is kept only while a revoked one can still be retried; any other is deleted. */
  async function dropUnlessRetryable(records: IdentityRecords, input: { hash: string; held: SharedSignIn }) {
    if (isRetryable(input.held, deps.now())) return false;
    await records.deleteSharedSignIn(input.hash);
    return true;
  }

  const steps = {
    async authenticate(input: { email: string; password: string; address: string }) {
      const email = normalisedEmail(input.email);
      const accountKey = `account:${await digest(email)}`;
      const addressKey = `address:${await digest(input.address)}`;
      return transaction(async (records) => {
        const now = deps.now();
        const accountFailures = await records.attempts(accountKey);
        const addressFailures = await records.attempts(addressKey);
        const retryAt = Math.max(accountFailures?.refusedUntil ?? 0, addressFailures?.refusedUntil ?? 0);
        if (retryAt > now) return { kind: 'tooManyAttempts' as const, retryAt };
        const account = await records.account(email);
        const isAccepted = await deps.secrets.verifyPassword({ password: input.password, hash: account?.passwordHash ?? null });
        if (!isAccepted || account === null) {
          const failedAccount = failed(accountFailures, { now, maximum: ACCOUNT_FAILURES });
          const failedAddress = failed(addressFailures, { now, maximum: ADDRESS_FAILURES });
          await records.saveAttempts({ key: accountKey, attempts: failedAccount });
          await records.saveAttempts({ key: addressKey, attempts: failedAddress });
          const refusedUntil = Math.max(failedAccount.refusedUntil, failedAddress.refusedUntil);
          return refusedUntil > now ? { kind: 'tooManyAttempts' as const, retryAt: refusedUntil } : { kind: 'wrongCredential' as const };
        }
        const signIn = deps.secrets.token();
        const expiresAt = now + SHARED_SIGN_IN_LIFE;
        await records.saveSharedSignIn({ hash: await digest(signIn), sharedSignIn: { accountId: account.id, expiresAt } });
        return { kind: 'authenticated' as const, signIn, expiresAt };
      });
    },
    async account(signIn: string) {
      const hash = await digest(signIn);
      return transaction(async (records) => {
        const account = await accountIn(records, hash);
        return account === null ? { kind: 'signedOut' as const } : { kind: 'account' as const, account };
      });
    },
    async begin(input: Omit<Authorization, 'expiresAt'>) {
      const flow = deps.secrets.token();
      await transaction(async (records) => records.saveAuthorization({ hash: await digest(flow), authorization: { ...input, browser: await digest(input.browser), expiresAt: deps.now() + FLOW_LIFE } }));
      return { flow };
    },
    async inspect(input: { flow: string; browser: string }) {
      const flowHash = await digest(input.flow);
      return transaction(async (records) => await openFlow(records, { flowHash, browser: input.browser }) !== null);
    },
    async complete(input: { flow: string; browser: string; signIn: string }) {
      const flowHash = await digest(input.flow);
      return transaction(async (records) => {
        const flow = await openFlow(records, { flowHash, browser: input.browser });
        if (flow === null) return { kind: 'invalidFlow' as const };
        const signInHash = await digest(input.signIn);
        if (await accountIn(records, signInHash) === null) return { kind: 'signedOut' as const };
        const code = deps.secrets.token();
        await records.saveCode({ hash: await digest(code), code: { clientId: flow.clientId, redirectUri: flow.redirectUri, codeChallenge: flow.codeChallenge, signInHash, expiresAt: flow.expiresAt } });
        await records.deleteAuthorization(flowHash);
        return { kind: 'authorized' as const, code, redirectUri: flow.redirectUri, state: flow.state };
      });
    },
    async redeem(input: { code: string; clientId: string; redirectUri: string; verifier: string }) {
      const hash = await digest(input.code);
      return transaction(async (records) => {
        const code = await records.code(hash);
        if (code === null) return { kind: 'invalidGrant' as const };
        await records.deleteCode(hash);
        if (code.expiresAt <= deps.now() || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri || code.codeChallenge !== await digest(input.verifier) || await accountIn(records, code.signInHash) === null) return { kind: 'invalidGrant' as const };
        return { kind: 'redeemed' as const };
      });
    },
    async revoke(signIn: string) {
      const hash = await digest(signIn);
      return transaction(async (records) => {
        const held = await records.sharedSignIn(hash);
        if (held === null) return null;
        const now = deps.now();
        // Core is contacted for a live record, or for a recent revocation whose sign-out may not have finished.
        if (held.expiresAt > now) {
          await records.saveSharedSignIn({ hash, sharedSignIn: { ...held, expiresAt: 0, revokedAt: now } });
          return held.accountId;
        }
        if (isRetryable(held, now)) return held.accountId;
        await records.deleteSharedSignIn(hash);
        return null;
      });
    },
  };

  return {
    ...steps,
    /** A browser arrives from a registered client: setup comes first, then a live shared sign-in skips the credential form. */
    async authorize(input: Omit<Authorization, 'expiresAt'> & { signIn: string | null }) {
      if (!await transaction((records) => records.hasAccounts())) return { kind: 'setupRequired' as const };
      const { flow } = await steps.begin(input);
      if (input.signIn !== null) {
        const completed = await steps.complete({ flow, browser: input.browser, signIn: input.signIn });
        if (completed.kind === 'authorized') return completed;
      }
      return { kind: 'credentialNeeded' as const, flow };
    },
    /** The credential form completes only its own open flow, from the browser and origin that began it. */
    async submitCredential(input: { flow: string; browser: string | null; isSameOrigin: boolean; email: string; password: string; address: string }) {
      if (!input.isSameOrigin || input.browser === null || !await steps.inspect({ flow: input.flow, browser: input.browser })) return startAgain(input.flow);
      const authenticated = await steps.authenticate(input);
      if (authenticated.kind !== 'authenticated') return authenticated;
      const completed = await steps.complete({ flow: input.flow, browser: input.browser, signIn: authenticated.signIn });
      if (completed.kind !== 'authorized') return startAgain(input.flow);
      return { ...completed, signIn: authenticated.signIn, expiresAt: authenticated.expiresAt };
    },
  };
}

function isRetryable(held: SharedSignIn, now: number): boolean {
  return held.revokedAt !== undefined && now - held.revokedAt < REVOKED_RETRY_WINDOW;
}

function failed(previous: FailedAttempts | null, input: { now: number; maximum: number }): FailedAttempts {
  const failures = [...(previous?.failures ?? []).filter((at) => at > input.now - ATTEMPT_WINDOW), input.now];
  return { failures, refusedUntil: failures.length >= input.maximum ? input.now + ATTEMPT_WINDOW : 0 };
}
