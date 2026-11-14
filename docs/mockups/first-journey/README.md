# First person sign-in: approval mockups

**Proposal for Thomas to approve. No product implementation.** These screens cover the first journey in [aeolus-fleet #1810](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1810) and the [approved design, sections 3, 4.1 to 4.3 and 5](https://github.com/ThomasHendrickx/aeolus-fleet/blob/839daf121c20a5536aa9a1da241a25e8309ab31f/docs/design/self-hosted-sign-in.md). Existing signed-out/ended pages are included to make the proposed session limit reviewable.

Open [index.html](index.html) locally for the gallery. Every scene links its standalone before/after page and two comparison images. The HTML is an offline approval artifact with static rendered markup, embedded CSS/fonts and a scene selector. It performs no authentication or network calls. GitHub displays the PNGs directly in the table below.

## Decisions requested together

| Proposal | For approval | Design boundary preserved |
| --- | --- | --- |
| Account identifier | Trusted setup asks for display name, email and a password through private input. Email is the sign-in identifier and fills gateway `account.email`. | The account id is opaque, stable and not derived from email. No public account creation. |
| Failed credential attempts | 5 per account or 20 per client address within 15 minutes; reaching either threshold refuses attempts for 15 minutes. The example reaches the threshold at 14:30 and can try again at 14:45. | Unknown email and wrong password share one refusal. Service unavailability is a different result. The same wait state is shown for either threshold. |
| Shared sign-in lifetime | 12 hours. The proposal is a fixed expiry from authentication, without extending it on use. | This is separate from a fleet account token's 10-minute life and gateway's existing 30-second allowance. |
| Service screens | Credential form, busy state, wrong credential, rate-limited wait, temporary credential-processing failure, public-before-setup refusal and invalid configuration refusal. | No automatic argo fallback, password reset form, public signup, email verification or organisation management. |
| Server output | Illustrative setup, configuration failure and retry output. Command spelling is also proposed. | Private input is not echoed; no installation token, signing key, starting secret or crew credential is included. |

The approved design does **not** specify other failed-attempt thresholds/windows or shared-session lifetime. It does fix account tokens at **10 minutes**, the gateway expiry allowance at **30 seconds**, and the existing gateway browser round trip at **10 minutes**. Those are different clocks; a 12-hour shared sign-in does not lengthen an issued fleet token or a code round trip. Removal/recovery and key-rotation screens are outside this first-journey approval set.

The account-versus-address aggregation is a proposal, not implemented policy. The implementation still needs approved acceptance scenarios for the exact window and safe handling of unknown identifiers. No undocumented behavior is decided by this artifact.

## Reading before and after

**Before** is the current unconfigured self-hosted console's operator sign-in. It is not a working named-person entry: the separate service does not yet exist. For downstream scenes, before repeats that real entry barrier rather than inventing a successful Maya account session. The argo commission context shows the existing Owner field with no person ship yet. The existing account-aware no-rights and unavailable pages are shown unchanged as reference comparisons; they already exist in the console but require issuer configuration to reach through an account flow. Existing operator rate-limit retry time is illustrative, not a new claim about its policy.

**After** is the proposed service plus existing console/Bridge journey context. Maya is a local fixture, `maya@example.test`, on `workshop`, with `researcher`. Existing UI screens do not represent a proposed core, console or gateway implementation change. The commission, starting-prompt and Bridge scenes are simplified fixture compositions using shared UI parts to explain the journey, not screenshots of a deployed multi-service test. They do not establish that the service is ready or that an agent received an answer.

The disconnected-gateway scene is a failure illustration for approval, not a proposal to add a new gateway page in this repository. If fulfilling an approved screen needs a console/core/gateway change, that work must be reported and separately authorized before starting its repository PR. The existing console no-rights wording is retained verbatim here; its mention of an organisation admin does not add organisation administration to this slice.

A successful shared-session return or token refresh has no intermediate screen: it opens the same console or Bridge page for the existing account/person ship. A refused state, replayed/expired code, wrong verifier or another browser uses the single callback-failed page and restarts. A down service host can show the browser's native connection error; the application cannot promise to render a branded page from a host that is unreachable.

## Source and real UI parts

The sign-in frames render the actual public console `AuthCard` and UI-package `Button`, `Input`, `Label`, `SignInBackground`, the Aeolus wordmark, Geist fonts and design tokens. Desktop uses the 400 px card and background; phone removes the card and background, uses 44 px controls, and puts recovery at the bottom. Existing page wording comes from the console's public route sources.

Reference sources are pinned to public aeolus-fleet commit [`f604ee6`](https://github.com/ThomasHendrickx/aeolus-fleet/tree/f604ee6987ddd28747e3790d1040006610453d8b):

- [Shared sign-in parts](https://github.com/ThomasHendrickx/aeolus-fleet/tree/f604ee6987ddd28747e3790d1040006610453d8b/packages/ui/src), [AuthCard](https://github.com/ThomasHendrickx/aeolus-fleet/blob/f604ee6987ddd28747e3790d1040006610453d8b/packages/console/features/sign-in/ui/organisms/auth-card.tsx) and [route layout/pages](https://github.com/ThomasHendrickx/aeolus-fleet/tree/f604ee6987ddd28747e3790d1040006610453d8b/packages/console/app/sign-in).
- [Existing commission dialog](https://github.com/ThomasHendrickx/aeolus-fleet/blob/f604ee6987ddd28747e3790d1040006610453d8b/packages/console/features/fleet/ui/organisms/commission-dialog.tsx) and [starting-prompt dialog](https://github.com/ThomasHendrickx/aeolus-fleet/blob/f604ee6987ddd28747e3790d1040006610453d8b/packages/console/components/organisms/starting-prompt-dialog.tsx). Account commission has no Owner field; its person ship owns the agent. Agent execution still requires a crew.
- [Approved Bridge mockups](https://github.com/ThomasHendrickx/aeolus-fleet/tree/f604ee6987ddd28747e3790d1040006610453d8b/docs/design/bridge/mockups) provide the opening/acknowledgement, basket, unsent/retry and confirmed-send journey. No alternate answer path is introduced.
- [Gateway PR 367](https://github.com/ThomasHendrickx/aeolus-fleet-gateway/pull/367), merged at `60aa5bc004389dd6270a6d046928778aa08a52d4`, preserves the existing wire contract. This artifact proposes no wire change.

These are deterministic browser-rendered HTML mockups, not generated raster artwork. Fonts and branding retain their upstream licenses; the fonts are [Geist, SIL Open Font License](https://github.com/vercel/geist-font/blob/main/LICENSE).

## Screens

Each comparison has before on the left and after on the right. Desktop captures use a **1440 × 900** viewport; phone captures use **375 × 812**. Long pages are captured in full, so image height can exceed the viewport. Original screenshots live under [screens/](screens/); side-by-side sheets live under [comparisons/](comparisons/). Every image carries a review label outside the product frame.

| Scene | Desktop before/after | Phone before/after | What to approve or preserve |
| --- | --- | --- | --- |
| Console entry | [View](comparisons/01-entry-desktop.png) | [View](comparisons/01-entry-phone.png) | Existing console account entry after manual issuer configuration. No console redesign. |
| Local account sign-in | [View](comparisons/02-credentials-desktop.png) | [View](comparisons/02-credentials-phone.png) | NEW SERVICE PAGE. Proposal: setup email is the sign-in identifier; account id remains opaque. |
| Credential submission | [View](comparisons/03-pending-desktop.png) | [View](comparisons/03-pending-phone.png) | NEW SERVICE STATE. Immediate busy feedback; this is not a successful sign-in. |
| Wrong credential | [View](comparisons/04-wrong-credential-desktop.png) | [View](comparisons/04-wrong-credential-phone.png) | NEW SERVICE STATE. Same refusal for unknown email and wrong password; remains signed out. |
| Too many attempts | [View](comparisons/05-too-many-attempts-desktop.png) | [View](comparisons/05-too-many-attempts-phone.png) | PROPOSAL: 5 failed attempts/account or 20/address in 15 minutes, then refuse for 15 minutes. Example server time 14:30; retry at 14:45. |
| No fleet rights | [View](comparisons/06-no-rights-desktop.png) | [View](comparisons/06-no-rights-phone.png) | Existing console refusal is preserved verbatim. No new organisation administration or Account app is proposed. |
| Service unavailable | [View](comparisons/07-unavailable-desktop.png) | [View](comparisons/07-unavailable-phone.png) | Existing console refusal. Never turn an outage into wrong password or argo access. If the service host itself is down, the browser may show its native network error until the app timeout/refusal. |
| Callback refused | [View](comparisons/08-callback-refused-desktop.png) | [View](comparisons/08-callback-refused-phone.png) | After: existing account callback refusal for expired/unknown state, replayed/refused code, wrong verifier or another browser. Start again; no argo fallback. |
| Signed out | [View](comparisons/09-signed-out-desktop.png) | [View](comparisons/09-signed-out-phone.png) | Existing console account sign-out page. PROPOSAL: shared sign-in lasts 12 hours. Shared session and 10-minute fleet token are different. |
| Shared sign-in ended | [View](comparisons/10-session-ended-desktop.png) | [View](comparisons/10-session-ended-phone.png) | Existing account page after expiry/revocation. Proposed 12-hour session requires credentials again. Returning with a valid session skips the credential page. |
| Public browser before trusted setup | [View](comparisons/11-setup-required-desktop.png) | [View](comparisons/11-setup-required-phone.png) | NEW SERVICE REFUSAL PROPOSAL. Browser cannot claim the installation. Trusted server setup is the only way to create the first account. |
| Commission researcher | [View](comparisons/12-commission-desktop.png) | [View](comparisons/12-commission-phone.png) | CONTEXT, existing console fields. Before is argo with no person owner to select; after is Maya’s account, with no Owner field. No console implementation is proposed. |
| Commission refused | [View](comparisons/13-commission-refused-desktop.png) | [View](comparisons/13-commission-refused-phone.png) | CONTEXT, existing commission refusal area with illustrative limit text. Missing scope is likewise shown as the returned refusal; nothing is commissioned. Retry retains original key. |
| Starting prompt and crew | [View](comparisons/14-starting-prompt-desktop.png) | [View](comparisons/14-starting-prompt-phone.png) | CONTEXT, existing starting-prompt route, with no actual credential. Before: not reachable for the named person. After: commission is not agent execution; give researcher a crew. |
| Bridge receives a question | [View](comparisons/15-bridge-waiting-desktop.png) | [View](comparisons/15-bridge-waiting-phone.png) | CONTEXT, existing Bridge layout and question path. After: shared sign-in resolves Maya’s stored person ship; gateway keeps the crew token server-side. No new Bridge screen is proposed. |
| Question opened | [View](comparisons/16-question-opened-desktop.png) | [View](comparisons/16-question-opened-phone.png) | CONTEXT. Receipt is acknowledged on opening, before answering. researcher asked its owner, Maya’s person ship. |
| Answer in basket | [View](comparisons/17-basket-desktop.png) | [View](comparisons/17-basket-phone.png) | CONTEXT. Choosing Release adds it to the existing basket; that action alone does not send it. |
| Basket sending | [View](comparisons/18-sending-desktop.png) | [View](comparisons/18-sending-phone.png) | CONTEXT. Immediate busy state. Success waits for core confirmation of durable storage. |
| Answer send failed | [View](comparisons/19-answer-unsent-desktop.png) | [View](comparisons/19-answer-unsent-phone.png) | CONTEXT. Keep the answer visibly unsent. Retry the same send key, including a lost successful confirmation. No delivery semantics change. |
| Answer sent | [View](comparisons/20-answer-sent-desktop.png) | [View](comparisons/20-answer-sent-phone.png) | CONTEXT. Gateway confirms core stored the answer; the agent receiving and acknowledging it is a separate protocol step, not inferred from a screenshot. |
| Gateway not connected | [View](comparisons/21-gateway-not-connected-desktop.png) | [View](comparisons/21-gateway-not-connected-phone.png) | CONTEXT FAILURE PROPOSAL, not an implemented gateway change. Existing gateway connection is required before Bridge is ready. Core retains pending delivery during an outage. |
| Invalid deployment configuration | [View](comparisons/22-configuration-failure-desktop.png) | [View](comparisons/22-configuration-failure-phone.png) | NEW SERVICE REFUSAL PROPOSAL. Invalid registered callback is never redirected to; inaccessible keys or invalid installation token stop the relevant server setup step. No token or secret is displayed. |
| Credential service temporarily unavailable | [View](comparisons/23-credential-unavailable-desktop.png) | [View](comparisons/23-credential-unavailable-phone.png) | NEW SERVICE STATE PROPOSAL. Credential processing failed because the service could not complete it; not a wrong-password refusal. If the entire host is down, its browser network error cannot be branded. |
| Trusted server setup | [View](comparisons/24-trusted-setup-desktop.png) | [View](comparisons/24-trusted-setup-phone.png) | CLI OUTPUT PROPOSAL. Password is private input, not echoed. Setup asks name and email, stores opaque id before provisioning, grants all offered fleet scopes and journey reach, argo false. No public signup. |
| Setup configuration refused | [View](comparisons/25-setup-configuration-refused-desktop.png) | [View](comparisons/25-setup-configuration-refused-phone.png) | CLI OUTPUT PROPOSAL. Invalid installation token stops provisioning, leaves durable retry state and never falls back to argo. Keys/callback/domain configuration likewise fail the relevant step. |
| Setup resumes stable identity | [View](comparisons/26-setup-retry-desktop.png) | [View](comparisons/26-setup-retry-phone.png) | CLI OUTPUT PROPOSAL. Retry resolves persisted account and the same installation person commission key. No duplicate person; agent commission retries belong to the existing console contract. |

## Approval walk

1. Start with the current self-hosted console, without a configured account issuer: scene 01 before offers operator sign-in and server recovery.
2. Inspect scenes 24 to 26: proposed trusted setup asks for email privately alongside the password input, persists identity before provisioning, stops on configuration refusal and resumes the saved identity on retry.
3. Inspect scenes 01 to 05 and 23 after: console account entry, the service credential form, submission, wrong credential, temporary wait and service-processing failure.
4. Inspect scenes 06 to 08, 11 and 22: no rights, unavailable, failed browser round trip, browser arriving before setup and invalid configuration. None grants an argo session.
5. Inspect scenes 12 to 14: Maya commissions `researcher`, sees a refusal if commission fails, and gets a starting prompt only after success. The mockup includes no secret. Crewing is still a separate action.
6. Inspect scenes 15 to 21: Bridge uses Maya's existing person mapping, opens and acknowledges the question, adds the answer to the basket, shows sending or a visible unsent failure, and claims a send only after core confirms storage. A disconnected gateway is not Bridge readiness.
7. Inspect scenes 09 and 10 to decide the 12-hour shared-session limit. A valid shared session returns directly to the existing console/Bridge screen, not a second credential prompt.

Approval is for these proposals and their wording, not proof of the deployed acceptance journey. Product code, BDD scenarios and a runnable-service PR follow only after orchestrator-1 communicates Thomas's answer.
