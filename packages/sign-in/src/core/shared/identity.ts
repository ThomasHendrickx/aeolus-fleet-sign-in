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
