ALTER TABLE accounts ADD COLUMN is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE cleanup_targets (
  id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,
  fleet_id TEXT,
  person_ship_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('cutOff', 'fleet', 'gateway')),
  should_release_owned_trierarchs BOOLEAN NOT NULL
);
CREATE INDEX cleanup_targets_account_id_id ON cleanup_targets(account_id, id);
CREATE INDEX shared_sign_in_account ON identity_records ((data->>'accountId')) WHERE key LIKE 'shared-sign-in/%';

CREATE INDEX cleanup_targets_attempts_id ON cleanup_targets(attempts, id);
