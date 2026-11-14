CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  organisation_id TEXT NOT NULL
);
CREATE TABLE fleet_rights (
  fleet_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  person_ship_id TEXT,
  scopes TEXT[] NOT NULL,
  group_values TEXT[] NOT NULL,
  is_fleet_manager BOOLEAN NOT NULL,
  PRIMARY KEY (fleet_id, account_id)
);
CREATE INDEX fleet_rights_account ON fleet_rights(account_id);
CREATE TABLE identity_records (key TEXT PRIMARY KEY, data JSONB NOT NULL);
