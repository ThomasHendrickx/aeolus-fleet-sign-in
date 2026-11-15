/** Installation identity records; rights and person mappings are fleet-scoped. */
import type { AccountId, FleetId, ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { Result } from './result.js';

export interface Account {
  readonly id: AccountId;
  readonly isDisabled: boolean;
  readonly accessVersion: number;
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
  rights(accountId: AccountId): Promise<readonly FleetRight[]>;
  revokeSharedSignIns(accountId: AccountId): Promise<void>;
  pendingCleanup(accountId?: AccountId): Promise<CleanupTarget | null>;
  saveCleanup(target: CleanupTarget): Promise<void>;
  deleteCleanup(id: CleanupTargetId): Promise<void>;
  hasAccounts(): Promise<boolean>;
  account(email: string): Promise<Account | null>;
  accountById(id: AccountId): Promise<Account | null>;
  saveAccount(account: Account): Promise<void>;
  right(input: { accountId: AccountId; fleetId: FleetId }): Promise<FleetRight | null>;
  saveRight(right: FleetRight): Promise<void>;
  /** A fleet-manager right on this fleet whose person ship is not yet mapped. */
  pendingRight(fleetId: FleetId): Promise<FleetRight | null>;
  sharedSignIn(hash: string): Promise<SharedSignIn | null>;
  saveSharedSignIn(input: { hash: string; sharedSignIn: SharedSignIn }): Promise<void>;
  deleteSharedSignIn(hash: string): Promise<void>;
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
  /** Reconciles every offered scope and the existing person installation commission key; core may refuse the installation. */
  reconcile(input: { accountId: AccountId; fleetId: FleetId }): Promise<{ readonly kind: 'reconciled'; readonly right: FleetRight } | { readonly kind: 'installationRefused' }>;
}

export interface SharedSignIn {
  readonly accountId: AccountId;
  readonly expiresAt: number;
  /** Set when revoked: a retry of that sign-out may still end the account's core sessions for a short while. */
  readonly revokedAt?: number;
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
  readonly failures: readonly number[];
  readonly refusedUntil: number;
}

export interface SignInSecrets {
  token(): string;
  digest(value: string): Promise<string>;
  verifyPassword(input: { password: string; hash: string | null }): Promise<boolean>;
}

/** One removal's target: account, access version, kind and fleet, so a retry saves the same target. */
export const cleanupTargetIdSchema = z.string().min(1).brand<'CleanupTargetId'>();
export type CleanupTargetId = z.infer<typeof cleanupTargetIdSchema>;

/** Each removal target remains durable until the remote side acknowledges it. */
export interface CleanupTarget {
  readonly attempts: number;
  readonly cursor: string | null;
  readonly id: CleanupTargetId;
  readonly accountId: AccountId;
  readonly fleetId: FleetId | null;
  readonly personShipId: ShipId | null;
  readonly kind: 'cutOff' | 'fleet' | 'gateway';
  readonly shouldReleaseOwnedTrierarchs: boolean;
}

/** What one attempt achieved: the whole target, one page of owned trierarchs, or the person ship found first. */
export type CleanupProgress =
  | { readonly kind: 'acknowledged' }
  | { readonly kind: 'pageReleased'; readonly cursor: string }
  | { readonly kind: 'personShipFound'; readonly personShipId: ShipId };

/** The remote side did not acknowledge; the target stays pending for a retry. */
export interface CleanupFailure { readonly kind: 'unavailable' }

export interface AccessCleanup {
  acknowledge(target: CleanupTarget): Promise<Result<CleanupProgress, CleanupFailure>>;
}
