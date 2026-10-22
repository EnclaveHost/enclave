# Hosted dashboard vs the default independent path: feature audit

Candidate `work/browser-default-independence/tree` (base: work/enclave at HEAD abe86262 plus its dirty tree, 2026-10-19 22:46).
"Default independent" means the build with the reviewed default profile packaged (scripts/build-site.mjs --default-profile).
That mode never asks Enclave's API, relay, upload service or address book for authority, and never switches to the
hosted service by itself.

## Legend

| Status | Meaning |
| --- | --- |
| **same** | Same feature and outcome, from chain facts and owner signatures. |
| **different** | Same goal, reached another way; the difference is stated. |
| **gap** | Missing or incomplete. Its owner and exact path are named. This is not parity. |
| **hosted only** | Exists only because Enclave runs it. Offered under the explicit hosted choice; never presented as independent. |

Evidence markers name WHERE a claim is checked; they do not say a check ran. Whether each test ran, and its exit code, is
recorded only in work/claude-browser-default-independence-result.md.
- **[T]** a case in test/site-default-independence.test.mjs.
- **[U]** a case in test/site-default-authority.test.mjs or test/site-default-discovery.test.mjs.
- **[D]** existing behaviour documented in docs/network/independent-dashboard.md and covered by existing suites.
- **[S]** a source change here with no dedicated test.

## 1. Bootstrap and trust

| Hosted dashboard | Default independent | Status |
| --- | --- | --- |
| Contract addresses come from the mutable EnclaveAddressBook, with baked fallbacks. | A reviewed authority profile is packaged in the build. Its digest is checked at load. Code hashes, immutable bindings and reviewed state are checked against agreeing RPCs before any decision or send. The address book is never read. [S][T] | different (stronger) |
| API base `api.enclave.host`. | No API. A stray call fails on a scheme `fetch()` refuses. [D][T] | different |
| Fallback when the API fails: none (errors). | No fallback to hosted when the profile, authority or RPCs fail: a precise unavailable state. [S][T] | different |
| Owner-chosen network: not possible. | Saved owner-chosen profile (import, fingerprint, per-tab confirmation) takes precedence. "Return to the built-in default". [D][S] | different |
| Hosted features. | Explicit, per-tab-confirmed hosted choice; never automatic. [S] | hosted only |
| Service discovery: none (relay knows the fleet). | Service index at an agreed block, code-hash pinned, ads as untrusted candidates, the user's operator choices, mixed-content reachability. [S][T] | different |
| Governance changes are invisible. | Reviewed-state drift (owner, pendingOwner, payout, retirement) is shown in the status bar and panel, and does not halt the page. [S] | different (stronger) |

## 2. Pages and routes

| Route | Hosted | Default independent | Status |
| --- | --- | --- | --- |
| `/` overview | Live prices/specs from relay `/availability`; enclave-panel shows the relay's `/attestation`; "verify a live host" fetches `https://api.enclave.host/enclaves` and challenges a host through `/t/<box>`. | Prices/specs from the pinned registry at an agreed block [D]. The measurement chip says "not read in independent mode" [S]. **Found here:** live-verify fetched the API directly, with a hard-coded origin, even in independent mode. It now makes no request and names the native-client path [S]. | different. **gap**: in-browser host verification without Enclave's tunnel (verifier workstream). |
| Header "Sign in" | Relay passkey / phone / wallet chooser; a stored relay account session is restored as signed in. | **Found here:** it opened the relay chooser, which then failed. Now an injected wallet connects directly, or the dashboard's own passkey-account panel opens. A stored relay account is not shown as signed in, and the dashboard names it instead [S]. | different |
| `/apps` store | Catalog from chain; featured slots, ratings and reviews from address-book-resolved EnclaveFeatured/EnclaveReviews; host ratings. | Catalog from chain through the profile's RPCs (display reads in rotation; decisions agreed) [D][T]. Featured/reviews/host reviews are **off**. | **gap**: owner is authority-profile review (featured/reviews/hostReviews need reviewed pins + a profile layout addition). |
| `/apps/publish` | Upload via `ipfs.enclave.host` with an upload token/EOA signature; catalog tx. | Upload to the profile storage plan, exact readback, then the catalog tx [D]. Smart-account uploads per account-upload47233 (frozen). | different. Activation dependency: storage adapters with v2 + gateway CORS (G3). |
| Quick deploy dialog | Relay fleet table, relay quote, claim hint, preferred-host fallback. | Per-host registry quotes; owner ceiling; host pin [D]. Each host owner's admission policy is applied to THAT host only [S][T]. Signed host capacity shown per host [S]. | different. No relay claim hint: hosts claim from the ledger. |
| `/dashboard` My Apps list | Relay `/deployments` (wallet, its vault, credit vault, orders). | Ledger scan at agreed blocks: wallet + pinned-factory vault [D], plus the wallet's relay-era session vault (reviewed legacy factory 0x1f5c…) [S][T]. A hosted (credit-vault) account in the browser is named, not dropped [S]. | different. **gap** for credit-vault accounts (§4). |
| Dashboard fleet panel | Relay `/enclaves`. | Pinned registry rows plus each host's own signed capacity record [S][T]; polled at most every 2 min. | different |
| `/host` | Relay `/enclaves` fleet; downloads from `get.enclave.host`. | Fleet as above [S]. Downloads still link to `get.enclave.host`. | **gap** (downloads): host software distribution needs a content-addressed release (site-release / host-image owners); the link is Enclave-operated. |
| `/architecture` | Relay fleet table. | Registry + signed capacity [S]. | different |
| `/develop`, `/terms`, `/privacy` | Static. | Static. | same |
| `/sessions` | Relay listing of every session (devices, agents). | Pinned-factory vault session controls (status, add budget, extend, end, end all) [S]; agents ask via `/grant` [D]. | different. **gap**: the per-device session list of the relay-era factory is not read (vault sessions of the legacy factory are not enumerated). |
| `/grant` | Relay-assisted. | Independent: SDK grant check, Sign only / Approve and open, account or wallet [D]. | same |
| `/authorize` (private app token) | Relay → host session token. | The host's management gateway over the operator-signed origin [D]. Live only where hosts rolled out the browser transport (§5). | different |
| `/checkout` (orders: card / USDC via PaymentRouter) | Relay billing + Stripe. | A precise notice, plus the explicit hosted choice; no relay call [S]. | hosted only |
| `/link` (device-flow sign-in) | Relay account. | Same notice [S]. | hosted only |
| `/sso/authorize` (Sign in with Enclave for tenant apps) | Relay SSO tokens. | Same notice [S]. Tenant apps that use Enclave SSO depend on the relay. | **gap**: owner is relay/SSO workstream (an owner-signed or ERC-1271 SSO token issued by the account itself). |
| App link on a row ("open") | `https://<label>.app.enclave.host` (API base) | **Found here:** in independent mode the link was built from the API base and read `independent-mode:/x/<id>`. It now shows the app's real name `https://<label>.app.enclave.host` [S]. That name and its TLS are Enclave's zone, so it is not independent. The Connect tab gives the native client path that needs no Enclave name. | **gap** (names): browser naming without Enclave's DNS/CA (names workstream) |
| `/admin` | Operator console against the relay. | Not available. | hosted only (operator tool) |

## 3. Deployment row tabs and actions

| Tab / action | Hosted | Default independent | Status |
| --- | --- | --- | --- |
| Top up | USDC EIP-3009 / credit vault. | EIP-3009 against the profile token, or ETH at the ledger feed (reviewed feed enforced) [D]. | same (wallet/account) |
| Suspend / Resume / Cancel | Ledger tx (+ relay claim hint). | Ledger tx; no hint [D]. | same |
| Version | Catalog approved versions. | Same, read from the catalog; production records via owner Promote [D]. | same |
| Resources | Relay fleet capacity. | Share edit on the ledger; host capacity from signed records [S]. | different |
| Config | Relay config pin for large configs. | Storage plan uploads [D]. | different |
| Models (volumes) | Relay fleet volume lists. | Volumes from hosts' signed capacity documents (passthrough field) [S]. | different. Shows nothing when a host publishes no capacity record. |
| Protect (WAF) | Options envelope. | Same envelope on the ledger [D]. | same |
| Network | Relay status, live routes, BYO WireGuard, paid providers. | Owner-signed policy to directories (profile + chosen operators), counted per operator [S][D]. | **gap**: (1) live route health; (2) BYO WireGuard (needs a private config transport); (3) paid-provider authorization. The reviewed authority pins `connectivity` (0x5f8b…), but provider listings need signed provider records from directories. Owner: network workstream. |
| Output (live logs) | Relay stream. | Manage tab: host log tail through the host's management gateway [D]. | different. Live only where hosts rolled out the transport (§5). |
| Restart | Relay → host. | Manage tab [D]. | different (rollout-dependent) |
| Verify (in-browser attestation) | Relay-proxied attestation verify. | Manage: host-reported attestation; Connect: native client command (attestation-checking) [D]. | **gap**: in-browser verified attestation for the default path. Owner: verifier workstream (WebPKI-independent verifier transport). |
| Pin (preferred host with fallback) | Relay placement. | Host & price: ledger placement pin and ceiling; host-owner verdicts per host; signed capacity [S][D]. | different (no automatic fallback host) |
| Environment (vault staging/production) | Relay sessions. | Pinned vault owner operations [D]. | same |
| Startup | n/a (hosted release service). | Owner-committed startup package [D]; the account signs uploads itself (account-upload47233). | different (stronger) |
| Secrets | Relay-held env vars. | Custody v2 owner-read Secrets tab: **browser-secrets57842 candidate, merge dependency** (not in this tree). | gap until that patch merges; then different |
| Domains | Relay custom domains. | Startup tab owner-committed names with an owner-chosen CA/responder [D]. | different |
| Transfer | Ledger transferDeployment. | Same [D]. | same |
| Downloads (phone app) | Enclave-built mobile apps. | Not offered. | **gap**: owner is mobile build distribution |
| Manage | n/a. | Status, logs, attestation (host-reported), restart, app token, CPU profile, GPU state through the operator-signed browser origin [D]. Directories from profile + chosen index operators [S]. | different. Live: **unavailable** today (no host advertises a browser transport; `browserHostRollout: false`), shown as the native fallback, not as success. |
| Rows held by a relay-era session vault | Acted on through the relay's session. | Listed read-only with the holder named; **Release to my wallet** (vault's own `release`, method checked in agreed code, simulated, owner-sent), then full control [S][T]. | different |
| Rows held by a hosted credit vault | Passkey-signed vault ops through the relay. | Named in the list header as held elsewhere; not listed automatically. | **gap** (§4) |

## 4. Accounts and payments

| Hosted | Default independent | Status |
| --- | --- | --- |
| Relay passkey account (RP enclave.host, credit vault, card top-ups). | Independent passkey account: a Safe whose passkeys and recovery keys own it, with an explicit gas choice (wallet, own ETH through an owner bundler, owner paymaster) [D][T]. | different. Existing relay accounts: **gap**, below. |
| Credit-vault records (EnclaveCreditVault via `vaultFactory` 0xa891… in the address book). | Named in the list header, not listed or operated yet. | **gap** (required; not parity). Exact path in gap-checklist G-1: direct passkey-signed `controlDeployment`/`fundDeployment`, submitted by any gas payer, from a page at the vault's origin (`https://enclave.host`); the vault found by P-256 key recovery from one assertion; reviewed pins for the factory and implementation. The contract has no `transferDeployment`: records cannot leave the vault. |
| Card checkout, credit. | A precise notice on /checkout [S]. | **gap**: the order and credit issuer must not require Enclave. Card processing may stay an optional third-party rail (gap-checklist G-5). |
| WalletConnect (Reown relay, Enclave's project id). | The owner's own WalletConnect transport: their project id and a relay they choose (Reown's or self-hosted), set in the network profile panel. Wallet reads go through the profile's RPCs [S]. Off until chosen; injected wallets and the passkey account always work. | different. Remains: a browser test with a relay fixture (gap-checklist G-3). |
| Relay-era wallet sessions (legacy factory). | Vault and its records found and released [S][T]; the vault's per-session list is not enumerated. | different / gap (session list) |
| `SessionVaultFactory` V1 0x00bB59… (sessions-base.json, 2026-10-07). | Not reviewed in the authority profile, so not read: records of a V1 vault are not listed. | **gap**: owner is authority-profile review (add a reviewed pin if such vaults hold records). |

## 5. Rollout-dependent paths (precise states, not parity)

| Path | Required | Today (live16) |
| --- | --- | --- |
| Directories from the service index | An HTTPS endpoint reachable from the page. | The one live ad is Enclave's, with 4 plain-HTTP endpoints. A page served over HTTPS cannot reach them: they are shown as "not reachable from this page". |
| Host management (Manage, Output, Restart, app token) | Hosts publish a management record with a browser origin. | `browserHostRollout: false`. Native fallback command shown. |
| Signed capacity | Hosts serve `/v1/host/capacity` or post to directories. | Live hosts' endpoints are Enclave-operated names; reachability unverified here (the browser test denies them). Precise "no capacity report". |
| Storage / Startup / Publish | Adapters with ERC-1271 v2 + gateway CORS (wasm 132ba32f or later). | Not deployed (account-upload47233 result). |
| Secrets | Independent custody committee. | Epoch 1, one Enclave machine (not independent). |
| Ledger | Ledger17 migration activated on Base, with a reviewed post-migration authority profile (migration66352). | The fork rehearsal **passes** (78 steps, 99/99 imports; work/claude-ledger17-migration-result.md) on a chain-31337 fork. Nothing is deployed or activated on Base, so there are no live rev-17 addresses to pin, and the plan's completeness review is pending. |
