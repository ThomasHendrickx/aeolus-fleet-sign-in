# Aeolus sign-in

`@aeolus-fleet/sign-in` signs a named person into an existing self-hosted fleet. It owns local credentials, shared browser sign-ins, fleet-manager grants and stable person-ship mappings. Core keeps ships and messages; gateway provides Bridge.

The first journey follows the [approved design](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/self-hosted-sign-in.md) and [aeolus-fleet #1810](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1810). Returning sign-in and token lifecycle follow [#1811](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1811). The [approved screen set](docs/mockups/first-journey/README.md) is retained for comparison.

Run from source with Node 26 and npm:

```sh
npm ci
npm run build
node packages/sign-in/dist/bin/aeolus-sign-in.js keygen --file /protected/sign-in-key.pem
node packages/sign-in/dist/bin/aeolus-sign-in.js setup
node packages/sign-in/dist/bin/aeolus-sign-in.js serve
```

Configure the server before setup or serving. See [self-hosting](docs/self-hosting.md) for HTTPS, exact app registrations, image use, database backup and key rotation. The signing-key command refuses to overwrite an existing file; setup requires a private interactive terminal and accepts no password argument or password environment variable.

Core **0.39.0 or newer** is required. The gateway wire contract is unchanged from [gateway PR 367](https://github.com/ThomasHendrickx/aeolus-fleet-gateway/pull/367). This service uses public installation/fleet tRPC calls, never core internals or an argo sign-in.

The approved credential limits are 5 failed attempts per account or 20 per address within the previous 15 minutes, followed by a 15-minute refusal. Shared sign-ins expire 12 hours after authentication, without extending on use. Fleet account tokens expire after 10 minutes. There is no public account signup.

Development checks:

```sh
npm run typecheck
npm run lint
npm test -- --project sign-in:unit
npm test -- --project sign-in:integration
npm exec playwright install chromium
npm test -- --project sign-in:browser
```

Integration tests start only their own Postgres containers and a released core. Browser tests cover the approved form at phone and desktop widths. The HTTPS/core scenario proves stable person ownership and question/answer delivery; it does not replace a deployed console/Bridge acceptance walk. Shared sign-out revokes locally before ending account-linked core sessions; a core outage returns unavailable for client retry. Operational key rotation publishes the replacement before activation and retains the old key through the last token and allowance. Trusted removal, durable cleanup and same-account recovery follow [#1812](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1812).
