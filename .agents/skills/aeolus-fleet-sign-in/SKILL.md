---
name: aeolus-fleet-sign-in
description: Mandatory with behaviour-driven-development for every code change in this repository. Layout, the identity, credential and secret boundaries, the guarantees and where each approved scenario is tested.
---

# Sign-in

Load with `behaviour-driven-development`; with `domain-modelling` for `src/core` and `src/adapters`; with `typescript` for every `.ts`; with `web-frontend` for browser views. Behaviour comes from aeolus-fleet's `docs/design/self-hosted-sign-in.md`; this skill adds none.

Layout (`packages/sign-in/src`), each folder added with the slice that needs it:
- `core/`: pure domain, each capability with its use cases and ports. `accounts/` (stable identity, local organisation value, credential and rights lifecycle), `sign-in/` (shared sign-ins, code and PKCE), `account-tokens/` (claims and signing lifecycle), `person-ships/` (mapping and convergence), `reconciliation/` (durable provisioning and cleanup retry), `shared/`.
- `adapters/`: `prisma/` (this service's Postgres schema, migrations, stores), `http/` (browser entry, registered callbacks, server exchanges, public keys, minimal sign-in views), `cli/` (trusted setup, removal, recovery, private credential input), `crypto/` (hashing, randomness, signing, key loading), `fleet/` (core installation and fleet calls, minimum core version), `gateway/` (cleanup notification), `clock/`.
- `app.ts` wires them; `config.ts` reads the environment; `bin/aeolus-sign-in.ts` is the command.

Boundaries:
- Core only through its public API and `@aeolus-fleet/common`; never core's server internals.
- Account ids are opaque and stable, never an email. Accounts, credentials, shared sign-ins and keys are installation-level; rights, person mappings and fleet cleanup carry fleet_id.
- Passwords enter only through private input and are stored only as a hash. The installation token and private signing keys stay on the server; core receives public keys and fleet claims only.
- Refusals stay distinct: signed out, no rights, unavailable. No fallback to argo.

Guarantees, each proven by a test: a retry never duplicates an account, a person ship or an agent (setup persists the account id before provisioning; person ships converge on `person-<account id>`); a code is redeemed once, by the browser that started it, with its verifier; cleanup is durable and retried until acknowledged, through concurrency, rollback and restart.

Testing:
- A `test(<scope>): <scenario> (red)` commit with only tests, then the `feat` or `fix` that makes it pass.
- Unit: beside the use case, with hand-written in-memory fakes of the ports (`test/support`); assert outcomes and stored state.
- Adapter, HTTP and CLI contract tests; Postgres and migrations on Testcontainers (`*.integration.test.ts`).
- Browser and deployed journeys cover the approved scenarios: first person, agent and Bridge answer; stable retry identity; browser binding and code replay; credential refusal; refresh, sign-out and key rotation; cleanup concurrency, rollback and restart; bounded gateway access; backup and restore of the same identity. Verification across core and gateway is coordinated with them, never claimed by a service-only test.

Enforced by lint/CI (`eslint.config.js`, `scripts/`): a `feat` or `fix` commit touching `src` comes right after a `(red)` commit with only tests, a test beside every use case, every test in a Vitest project, npm only, no em dash; in `src/core` no Prisma, pg, Fastify, tRPC, adapter or `@aeolus-fleet/core` import, no clock, crypto, network, file system, `Math.random` or `throw`; Prisma only in `adapters/prisma`; no `@aeolus-fleet/core` in `src` outside tests; no `vi.mock` anywhere, no `vi.fn` or `vi.spyOn` in `src/core`; casts, exhaustive switches, parameter count, boolean names, default exports, file names.
