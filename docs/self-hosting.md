# Run sign-in beside an existing fleet

Use Node 26, a dedicated Postgres database, core 0.39.0 or newer, the existing console and gateway with the contract in gateway PR 367. Start and connect gateway to the fleet before claiming Bridge is ready. This service neither creates a second fleet nor runs an agent when it commissions one.

## HTTPS and trusted sibling addresses

Example public addresses are `https://core.example.test`, `https://console.example.test`, `https://signin.example.test` and `https://bridge.example.test`. Replace them with HTTPS hosts beneath one parent domain you control. Every sibling receiving the shared cookie must be trusted. Use valid certificates trusted by browsers and all app servers. There is no discovery of callbacks or other installations.

Terminate TLS at a reverse proxy. Forward the sign-in hostname to this service's HTTP port 3000, preserve its request path, and do not log credential form bodies, query strings containing codes, cookies or authorization headers. Keep the backend port private. The service uses its configured public origin rather than a forwarded Host header for security decisions.

For client-address failed-attempt limits behind a proxy, set `SIGN_IN_TRUSTED_PROXY` to that proxy's actual IP address or CIDR only. Forward the client address with `X-Forwarded-For` and prevent direct access to the backend. Forwarded addresses are ignored by default; untrusted callers cannot bypass their address limit by supplying that header.

The shared cookie is `aeolus_account_session`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Domain=example.test` and a maximum lifetime of 12 hours from authentication. The host-only browser-binding cookie lives 10 minutes. Both console and gateway perform their own state/PKCE browser binding as well. Neither a crew credential nor the installation token belongs in a browser.

## Server configuration

Load the following into the service process from protected server configuration. The values below are placeholders, not usable credentials. Keep client secrets and the installation token out of git, command arguments, public configuration and browser bundles.

```text
DATABASE_URL=postgresql://<database-connection-for-sign-in-only>
CORE_URL=https://core.example.test
INSTALLATION_TOKEN=<same-server-only-installation-token-as-core>
SIGN_IN_ORIGIN=https://signin.example.test
SIGN_IN_COOKIE_DOMAIN=example.test
SIGN_IN_ACTIVE_KEY_ID=first
SIGN_IN_SIGNING_KEYS=[{"id":"first","file":"/protected/sign-in-key.pem"}]
SIGN_IN_CLIENTS=[{"id":"console","secret":"<console-client-secret>","redirectUri":"https://console.example.test/sign-in/done"},{"id":"gateway","secret":"<gateway-client-secret>","redirectUri":"https://bridge.example.test/sign-in/done"}]
SIGN_IN_FLEETS=[{"id":"<existing-fleet-id>","name":"workshop","consoleUrl":"https://console.example.test","gatewayUrl":"https://bridge.example.test"}]
PORT=3000
```

`CORE_URL` may be a private backend address if it reaches the same configured installation; the public origin and callback registrations must still be HTTPS. Every fleet id is the actual existing core id, not its display name. The local organisation value `local` is persisted with each opaque account; it is not an organisation administration feature.

Core must have `INSTALLATION_TOKEN` configured, at least 32 characters, and `ACCOUNT_TOKEN_ISSUER=https://signin.example.test`. Core loads public keys from `https://signin.example.test/.well-known/jwks.json`; ensure it can reach that URL. The service checks `/api/version` before migrating or starting. A core build reporting `0.0.0` counts as a build from main, as the compatibility contract specifies. The installation token never travels to a console or gateway browser.

Configure the console's existing server settings:

```text
AEOLUS_PAGASAE_URL=https://signin.example.test
AEOLUS_PAGASAE_CLIENT_ID=console
AEOLUS_PAGASAE_CLIENT_SECRET=<console-client-secret>
```

These are existing public setting names. Set the gateway's existing sign-in issuer URL and app-client settings to this origin and its `gateway` registration; use the names documented by the installed gateway version. Preserve its exact `/sign-in/done` callback. The service implements the existing endpoints, not a generic identity-provider substitute:

| Endpoint | Boundary |
| --- | --- |
| `GET /oauth/authorize` | Exact registered client/callback, `state`, S256 PKCE; authenticate or reuse an existing shared sign-in |
| `POST /sign-in` | Same-origin local credential form bound to the browser that started it; no public signup |
| `POST /oauth/token` | Authenticated server client; authorization-code redemption or fleet account-token exchange |
| `GET /api/apps` | HTTP Basic client authentication and `aeolus-sign-in` header; account display and configured fleet apps |
| `POST /oauth/revoke` | Authenticated server client; idempotently revoke the shared sign-in across apps |
| `GET /.well-known/jwks.json` | Public verification keys only; no private signing material |

Wrong credentials, temporary failed-attempt refusal, no fleet rights and service unavailability stay distinct. Unknown accounts receive the same credential refusal as a wrong password. A callback not registered exactly is never used as a redirect. Expired flow/code, code replay, a different browser or wrong verifier starts a new sign-in. Nothing substitutes argo's identity.

## Private setup and retry

Generate an Ed25519 key once, with `keygen --file /protected/sign-in-key.pem`. The file is created exclusively with mode 0600. Its owner must be the service's operating-system user; startup refuses keys readable by group or others. Keys are PEM PKCS#8 files; key ids must be unique and the active id must name a configured key.

Run `setup` on a private interactive terminal, with the same server configuration as the service. With exactly one configured fleet, it selects that fleet. Otherwise run `setup --fleet <existing-fleet-id>`. Enter Maya's display name, email and a password of at least 15 characters at its prompts. The email matches whatever its case. The password is stored as a scrypt hash that names its own parameters, and is not echoed, accepted in a pipe or passed as an argument. The browser cannot run setup.

Setup persists the opaque account id and its pending fleet-manager grant before any provisioning request. A failed installation request leaves setup pending. Correct configuration and rerun `setup`: it resumes the saved account without asking again, retains the original id and password hash, and retries the existing installation commission key. Setup is not a password-reset command.

The person ship uses `person-<first 12 account-id characters>` and core's exact installation idempotency key `person-<account id>`. A lost commission reply or failed mapping save can retry that key. Person ships retain only the existing messaging scopes and own themselves. The account receives all offered fleet scopes, `argo=false`, and manager read/manage reach; the `group` label and declared rules provide the journey's messaging reach. Each fresh account-token exchange reconciles offered scopes and the stable mapping, so adding an offered scope is reflected in subsequent tokens.

Open the console's normal account entry and sign in using the setup email and password. Commission `researcher` as that account. A refused commission does not change ownership; a retry retains the original commission key. Use its starting prompt to crew it separately. Then open Bridge, reuse the shared sign-in, and use its existing question, opening acknowledgement and basket path. Setup's success does not claim gateway connectivity or agent execution.

Argo's independent `aeolus-core sign-in` recovery entry remains unchanged and does not depend on this issuer. Server account reset/removal/recovery commands belong to the follow-up slices; restoring a backup is described below. Do not recreate a person account as a workaround for lost identity state.

## Image

Build the runnable image from this repository:

```sh
docker buildx build --load -t aeolus-sign-in:local .
```

The image runs as an unprivileged user and defaults to `serve`; `setup`, `migrate` and `keygen` use the same entrypoint. Mount protected server configuration, signing keys and a reachable dedicated Postgres database. Migrations run transactionally at process start; concurrent starts share a database advisory lock. An existing database migration is not re-applied.

For example, after a protected env file and key mount exist, run setup using a private terminal. Choose a container uid/gid that owns the mounted 0600 key:

```sh
docker run --rm -it --pids-limit=128 --user "$(id -u):$(id -g)" --env-file /protected/sign-in.env --mount type=bind,src=/protected,dst=/protected,readonly aeolus-sign-in:local setup
```

Serve with the same protected env and read-only key mount, exposing port 3000 only to the HTTPS proxy. The image contains compiled entrypoints, migrations, UI assets and runtime dependencies. No service credentials or signing keys are built into it. Image publication is separate from opening this PR.

## Backup, restore and signing rotation

Keep protected backups of the sign-in database, server configuration and private signing material alongside the corresponding fleet backup. The database holds opaque account ids, email/display name, scrypt password hashes, the local organisation value, fleet grants, person mappings, pending provisioning, fixed-expiry shared sign-ins, authorization/code consumption and failed-attempt state. Database backup readers can impersonate people through restored server state, so restrict and encrypt those backups.

Restore the database and the same server configuration/keys on the matching installation before admitting browser traffic. Check core and issuer-key connectivity. Retry trusted setup with the original email and fleet to reconcile its existing installation person key, then verify the same person ship and history. Do not manufacture a new account id or commission a new person to repair a missing mapping. Restoring an old backup is not a guarantee that newer shared sign-in revocations are preserved; use the account recovery slice's procedure when available.

Rotate keys through protected server configuration:

1. Generate the replacement key with a new id and a private file. Add it to `SIGN_IN_SIGNING_KEYS` beside the old key, retaining the old `SIGN_IN_ACTIVE_KEY_ID`.
2. Restart the service. Check that `/.well-known/jwks.json` publishes both public keys, without private material. Do not activate the replacement until every serving instance publishes it.
3. Wait more than core's one-minute key-refresh interval after publication. Then switch `SIGN_IN_ACTIVE_KEY_ID` to the replacement and restart. Fresh tokens identify the replacement with `kid`; existing tokens still identify the old key.
4. Keep the old key published until more than 10 minutes and 30 seconds after the last instance stopped signing with it. The interval starts at the last old-key token, not when the replacement was first published.
5. Remove the old key from serving configuration and restart. Retain protected backups according to the deployment's recovery policy.

Rotation is operational, without an automated key lifecycle. Removing the old public key early makes otherwise live tokens unverifiable. A service restart loads the configured keys; no private key or installation token is sent to core.

## Returning and signing out

Returning with a live shared sign-in skips the credential form and lets each app obtain a fresh 10-minute fleet token for the same account and person ship. The service never renews the shared cookie on use. At exactly 12 hours after authentication, it refuses further exchanges and requests authentication again. The account, person ship, history and ownership stay the same.

Apps refresh fleet tokens before expiry through the existing authenticated token exchange. During an issuer outage no fresh token is available; an already issued token can continue until its own expiry, with core's existing 30-second validation allowance. Signed-out (`invalid_grant`), no-rights (`invalid_target`) and unavailable (`temporarily_unavailable`) remain distinct. A retained person crew never authorises browser access by itself.

An authenticated app signs out with `POST /oauth/revoke`. The service first commits the end of that shared sign-in, then calls `installation.accounts.signOut` for its account. This ends account-linked argo console sessions without cutting off issued account tokens or releasing ordinary agents. Other apps using the same shared sign-in cannot obtain fresh tokens or app discovery after revocation. Apps own their browser cookie clearing and the approved signed-out and session-ended screens.

If core cannot complete sign-out, the service returns HTTP 503 with `temporarily_unavailable`. The local sign-in stays revoked. Retry the same request when core returns: the retained ended sign-in record still resolves its account, including after a service restart. There is no background sign-out retry queue. An unknown sign-in revokes idempotently without disclosing an account.

Argo's independent server sign-in remains available for recovery. Shared sign-out does not disable the account or remove fleet access; those are separate lifecycle operations.

## Data access and validation

This first-person service does not read message history or scan the fleet's ships. Account/email, account id, fleet grant and all shared sign-in, authorization, code and attempt keys use indexed lookups; app discovery reads only the manually registered fleets. Short identity transitions are serialized within this installation, including code consumption and failed-attempt counters. Password hashing and external provisioning have explicit ports; failed state transactions roll back.

Tests prove the service's code/cookie/refusal boundary, Postgres concurrency/rollback/restart, real-browser form states and the HTTPS issuer/released-core person-to-agent path. A deployed console and Bridge walk is coordinated across repositories; it is not inferred from a service-only test.
