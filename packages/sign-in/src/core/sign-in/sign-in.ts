/** Durable browser-bound authorization and fixed-lifetime shared sign-ins. */
import type { Authorization, FailedAttempts, Identity, IdentityRecords, SignInSecrets } from '../shared/identity.js';

const ATTEMPT_WINDOW = 15 * 60 * 1000;
const ACCOUNT_FAILURES = 5;
const ADDRESS_FAILURES = 20;
const SESSION_LIFE = 12 * 60 * 60 * 1000;
const FLOW_LIFE = 10 * 60 * 1000;

export function createSignIn(deps: { identity: Identity; secrets: SignInSecrets; now: () => number }) {
  const digest = (value: string) => deps.secrets.digest(value);
  const transaction = deps.identity.transaction.bind(deps.identity);

  async function accountIn(records: IdentityRecords, hash: string) {
    const held = await records.session(hash);
    if (held === null || held.expiresAt <= deps.now()) return null;
    return records.accountById(held.accountId);
  }

  return {
    async authenticate(input: { email: string; password: string; address: string }) {
      const accountKey = `account:${await digest(input.email)}`;
      const addressKey = `address:${await digest(input.address)}`;
      return transaction(async (records) => {
        const now = deps.now();
        const accountFailures = await records.attempts(accountKey);
        const addressFailures = await records.attempts(addressKey);
        const retryAt = Math.max(accountFailures?.refusedUntil ?? 0, addressFailures?.refusedUntil ?? 0);
        if (retryAt > now) return { kind: 'tooManyAttempts' as const, retryAt };
        const account = await records.account(input.email);
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
        const expiresAt = now + SESSION_LIFE;
        await records.saveSession({ hash: await digest(signIn), session: { accountId: account.id, expiresAt } });
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
      return transaction(async (records) => {
        const flow = await records.authorization(await digest(input.flow));
        return flow !== null && flow.expiresAt > deps.now() && flow.browser === await digest(input.browser);
      });
    },
    async complete(input: { flow: string; browser: string; signIn: string }) {
      const flowHash = await digest(input.flow);
      return transaction(async (records) => {
        const flow = await records.authorization(flowHash);
        if (flow === null || flow.expiresAt <= deps.now() || flow.browser !== await digest(input.browser)) return { kind: 'invalidFlow' as const };
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
      return transaction(async (records) => records.deleteSession(await digest(signIn)));
    },
  };
}

function failed(previous: FailedAttempts | null, input: { now: number; maximum: number }): FailedAttempts {
  const isOld = previous === null || previous.since + ATTEMPT_WINDOW <= input.now;
  const failures = (isOld ? 0 : previous.failures) + 1;
  return { since: isOld ? input.now : previous.since, failures, refusedUntil: failures >= input.maximum ? input.now + ATTEMPT_WINDOW : 0 };
}
