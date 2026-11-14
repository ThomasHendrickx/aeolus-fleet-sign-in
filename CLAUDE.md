# Aeolus sign-in: guidelines for Claude Code

## What it is

`@aeolus-fleet/sign-in`: signs people in to a self-hosted Aeolus fleet. It owns human identity and sign-in state (accounts, credentials, shared sign-ins, fleet rights, account and person-ship mapping), signs fleet account tokens and calls core as the installation where the design says so. It is a separate service beside core and gateway, not a fleet plugin ship.

## Source of truth

The fleet's docs live in ThomasHendrickx/aeolus-fleet, never copied here:

- [docs/design/self-hosted-sign-in.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/self-hosted-sign-in.md): this service's approved design, its journey, boundaries and contracts (section 5).
- [docs/blueprint.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/blueprint.md): product, language, behaviour.
- [docs/decisions/README.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/README.md): every decision, one numbering for every repository. Do not reopen a recorded decision; raise it as a question instead.
- [docs/compatibility.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/compatibility.md): what this service may call in core.

If the docs do not answer a behaviour question, stop and ask. Never decide product behaviour yourself.

## House rules

- npm only (npm install, npm run, npm test). Never pnpm or yarn.
- English for all code, names, comments, commits, paths and database fields.
- No em dashes anywhere: code, docs, commits, PR text.
- Use the ubiquitous language from the blueprint and the design (ship, person ship, account, account token, shared sign-in, commission, release). Invent no synonyms or new terms: name the concrete parts, and split a block that covers two things.
- This repository is public: no private deployment details, hosts, accounts or secrets.

## Architecture rules

- Ports and adapters. `packages/sign-in/src/core` holds domain, use cases and ports, with no framework, Prisma, pg, crypto, adapter or core imports. Time, randomness, hashing, signing, network and storage enter through ports. The lint rule enforces it; never disable it.
- Prisma lives in `src/adapters/prisma` only, against this service's own database.
- Core only through its public API and `@aeolus-fleet/common` from npm at a stated version, as the installation where the design says so. Raise the minimum core version in the same PR that needs a newer core.
- Accounts, credentials, shared sign-ins and signing keys are installation-level; fleet rights, person mappings and fleet cleanup are fleet-scoped and carry fleet_id.
- Passwords, the installation token and private signing keys stay on the server: never in a browser, a log or a response.
- Before 1.0.0 breaking changes are allowed (decision 0013). Keep designs minimal: no compatibility layers and no polish for zero customers.

## Skills

Load the matching skills from `.claude/skills/` (Codex: `.agents/skills/`) before the work they name. They are mandatory, not suggestions:

- `software-development`: every code change.
- `behaviour-driven-development` and `aeolus-fleet-sign-in`: every code change. Red, green, refactor from the approved scenarios.
- `domain-modelling`: anything under `src/core` or `src/adapters`.
- `typescript`: every `.ts` change.
- `web-frontend`: browser views.
- `performance`: designing or building an API, a query, a list or a page that reads data.
- `code-review`: reviewing a branch, pull request or diff.
- `pull-request`: writing a pull request body.
- `writing-for-agents`: editing CLAUDE.md, a skill, or a doc agents read.

`aeolus-fleet-sign-in` lives here. The others come from ThomasHendrickx/skills, pinned in `skills-lock.json`: never edit them here; change them there, tag a release, then `npx skills@1.7.2 add ThomasHendrickx/skills#<tag> --agent claude-code codex -y`.

## Quality

- npm run typecheck, npm run lint and npm test green before every commit, except a red commit that only adds the failing test and is labelled `(red)`. Push only a green head. Zero lint errors, no eslint-disable without a comment explaining why.
- Every use case has unit tests with in-memory ports. Every adapter that touches Postgres has a Testcontainers test.
- Guarantees are proven by tests: concurrency, rollback, restart. A guarantee without a test does not exist.
- Report a test as passing only after you saw it run by name.
- No any without a comment explaining why.

## Working

Do what the prompt and the docs ask, nothing more: done means the acceptance criteria are met, and earlier slices are not precedent.

- One slice per session, one PR per slice, kept thin. Commit per logical step, not one catch-up commit.
- A finding that does not block the criteria is not acted on: a real defect is filed as an issue, anything else goes in the PR.
- New functionality is built only from a design Thomas approved. Foundational work goes structure first, approved, then one part at a time.
- Repo text must serve the current commit. What git shows (what changed, the steps taken) lives in commits and the PR, never in files. Decisions go into the docs or an ADR as current state.
- New rules, checks, exceptions or process steps come only from Thomas: propose, never add.
- No self-review passes. The one review is a clean-room session after the PR.
