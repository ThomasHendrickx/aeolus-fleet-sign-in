/** Installation identity records; rights and person mappings are fleet-scoped. */
import type { AccountId, FleetId, ShipId } from '@aeolus-fleet/common';

export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly organisationId: string;
}

export interface FleetRight {
  readonly accountId: AccountId;
  readonly fleetId: FleetId;
  readonly personShipId: ShipId | null;
  readonly scopes: readonly string[];
  readonly groupValues: readonly string[];
  readonly isFleetManager: boolean;
}

export interface IdentityRecords {
  account(email: string): Promise<Account | null>;
  accountById(id: AccountId): Promise<Account | null>;
  saveAccount(account: Account): Promise<void>;
  right(input: { accountId: AccountId; fleetId: FleetId }): Promise<FleetRight | null>;
  saveRight(right: FleetRight): Promise<void>;
  session(hash: string): Promise<SharedSignIn | null>;
  saveSession(input: { hash: string; session: SharedSignIn }): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  authorization(hash: string): Promise<Authorization | null>;
  saveAuthorization(input: { hash: string; authorization: Authorization }): Promise<void>;
  deleteAuthorization(hash: string): Promise<void>;
  code(hash: string): Promise<AuthorizationCode | null>;
  saveCode(input: { hash: string; code: AuthorizationCode }): Promise<void>;
  deleteCode(hash: string): Promise<void>;
  attempts(key: string): Promise<FailedAttempts | null>;
  saveAttempts(input: { key: string; attempts: FailedAttempts }): Promise<void>;
}

export interface Identity {
  /** Atomic, serialised state transition; adapters roll back on any failure. */
  transaction<T>(work: (records: IdentityRecords) => Promise<T>): Promise<T>;
}

export interface Secrets {
  accountId(): AccountId;
  hashPassword(password: string): Promise<string>;
}

export interface PersonFleets {
  /** Reconciles every offered scope and the existing person installation commission key. */
  reconcile(input: { accountId: AccountId; fleetId: FleetId }): Promise<FleetRight>;
}

export interface SharedSignIn {
  readonly accountId: AccountId;
  readonly expiresAt: number;
}

export interface Authorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly browser: string;
  readonly expiresAt: number;
}

export interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly signInHash: string;
  readonly expiresAt: number;
}

export interface FailedAttempts {
  readonly since: number;
  readonly failures: number;
  readonly refusedUntil: number;
}

export interface SignInSecrets {
  token(): string;
  digest(value: string): Promise<string>;
  verifyPassword(input: { password: string; hash: string | null }): Promise<boolean>;
}
