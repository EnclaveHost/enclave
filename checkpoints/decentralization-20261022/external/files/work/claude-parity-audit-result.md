# Enclave decentralization: feature-parity and mandatory-authority audit (2026-10-19)

This was a read-only audit. I edited no repository and made no commits, live operations, SSH sessions, chain or wallet
actions. I did not read any private configuration. The only files I wrote are this report and the helpers in
`claude-parity-audit/`.

## Snapshot and method

Commits audited:

| Repository | Branch | HEAD |
| --- | --- | --- |
| `enclave` | `decentralize/nan-retirement` | `48390694` |
| `enclave-apps` | `decentralize/wallet-uploads` | `928646f` |
| `enclave-apps-sia-recovery` | `decentralize/sia-recovery` | `446ac5f` |

- **Commits landed during the audit.**
  - `48390694` ("Record cold-store SNP startup and cleanup evidence") changes only documentation.
  - `af16a74c` ("Run owner-committed hosts without Enclave control services") landed after the evidence was gathered. It
    adds `ISOLATION_DIRECT_ONLY` to `supervisor.js` and `docs/network/direct-host-control.md`, shifting `supervisor.js`
    line numbers after about line 339.
- **Uncommitted work by other workstreams at the end of the audit (left untouched):**
  - Custody: `custody/v2/*`, `scripts/independent-custody.mjs` and the custody tests.
  - **Native client POST/PUT/PATCH/DELETE and streaming:** `network/native-client.mjs` and
    `test/native-client.test.mjs`.
  - Sia: `sia-s3/src/store.rs` and its mocks in `enclave-apps-sia-recovery`.
  - The pre-existing `cache/test-failures` change.
- **Line references.** `supervisor.js:N` refers to `48390694`/`0e8d9a8a`; regenerate with `claude-parity-audit/hgrep.sh`
  after `af16a74c`. Other cited files were unmodified when cited.
- **Source vs. deployed state.**
  - "Source" findings come from code.
  - "Deployed" findings come only from the committed docs and evidence (`docs/design/decentralized-architecture.md`,
    `docs/design/nan-retirement.md`, `docs/network/*.md`).
  - Where a production value comes from private environment settings, I mark it as unknown and do not guess.
- **Tests run.** Light local tests only:
  - `node --test test/site-ledger-calls.test.mjs test/storage-gateways.test.mjs test/host-contract-pins.test.mjs test/raw-artifacts.test.mjs`
    passed 18 of 18 (`claude-parity-audit/baseline-light-tests.log`).
  - No broad suites.
- **Helpers.**
  - `claude-parity-audit/scan-authorities.sh` lists every committed non-test source line that defaults to an Enclave
    origin or the mutable address book. Its output is `claude-parity-audit/authority-scan.txt` (552 lines).
  - `claude-parity-audit/hgrep.sh` greps the committed HEAD (stable line numbers).

**Out of scope here, because other Claude tasks own them:** the direct supervisor path, independent custody, and Sia
writes. I reference them as dependencies only.

## Executive summary

The protocol core now has a censorship-resistant path for one narrow, real flow:

1. A wallet deploys with `--chain-only` against pinned contracts.
2. It publishes and activates an owner-committed public startup package through a replicated storage plan.
3. A cold host installs a pinned runtime (`fetch-runtime` plus `guestd -cpu-release`).
4. A fresh SNP guest boots with guest control egress denied. This was proven on hardware on 2026-10-19.
5. A native GET/HEAD client verifies it without Enclave DNS, the CA or the control API.

Host-local wallet veto exists in source and runs on the Windows host, and the provider directories are
signed, verified and pinned.

**Most other existing features still require at least one Enclave-operated authority.** The largest gaps are not owned
by the three active workstreams.

1. **The browser dashboard is entirely central.**
   - API base `api.enclave.host` (`site/js/core/config.js:9`).
   - Contract addresses come from the mutable address book, from the first RPC that answers (`config.js:101`,
     `addressbook.js:19-31`). Whoever controls the book can redirect the wallet's create/fund transactions.
   - Upload authorization still uses the API's HMAC token issuer because `IPFS_WALLET_AUDIENCE = ""` (`config.js:168`,
     `catalog.js:399`). This is true even though the adapter's direct wallet signatures are live.
   - Deployment listing, logs, restart, attestation, SIWE, sessions, network policy and placement all go through the
     API.
   - None of the new paths (owner-committed startup, storage plans, contract pins, pinned session factory) exist in
     `site/`.
2. **No browser-trusted name or certificate exists without Enclave.**
   - The measured guest front can only certify `<label>.app.enclave.host`: the `-cert-zone` default at
     `isolation/m2/front/main.go:145` is never overridden by `isolation/m2/dominit.c:892`.
   - Custom domain names are learned only from `api.enclave.host/v1/domains/map` (`front/domains.go:62,71`;
     `release/pins.go:14`).
   - Certificates come from the relay's CA account and DNS-01 (`relay/certs.js`).
   - Supervisor issuance also requires the relay's measurement prediction (`isolation/m4/guestd/supervisor-guestcert.mjs:17-20`).
   - Direct-only hosts disable browser naming and WebPKI entirely (`docs/network/direct-host-control.md`, "Unsupported in
     this mode").
   - So every browser user of an app depends on Enclave's domain, DNS-01 zone and CA account.
3. **There is no relay-free owner management plane.**
   - Logs, restart, status, attestation, per-host SIWE sessions and private-app sign-in reach hosts only through the API
     fleet tunnel at `api.enclave.host/t/<name>`.
   - Host identity is literally that URL: `windows/node/agent.mjs:76`, `windows/installer/install-host.ps1:206,320`,
     `cli/enclave.mjs:4377-4379`.
   - The committed native client is GET/HEAD only (`docs/network/native-client.md:15-16`). Another workstream is adding
     POST and streaming (uncommitted); it targets application requests, not a host-management route.
4. **Windows/Shield (all GPU serving today) has no direct path.**
   - Secrets come from the relay (`windows/node/secrets.mjs:80`, `shield-secrets.mjs:46`); certificates from the relay
     (`apptls.mjs:115`); domains from the relay (`domains.mjs:58`).
   - There is no `guestBootstrap` support in `windows/`.
   - The installer aborts if the relay name check fails (`install-host.ps1:88-89`).
   - **Auto-update trusts an unsigned `latest.json`.** Updates come from `get.enclave.host` (`agent.mjs:893-896`).
     `update-host.ps1:92-101` checks hashes only against that same unsigned file. Whoever controls `get.enclave.host`
     can push code to every installed Windows host within a minute. Its publisher script still targets retired Nan over
     SSH (`scripts/publish-windows-host.sh:19-53`).
5. **Global contract powers remain.**
   - The catalog owner can `transferApp` (seize a publisher lineage), `grantCid`, `setApproval` and `setMaxFee`
     (`contracts/EnclaveAppCatalog.sol:557,581,610,631`).
   - The ledger owner can `slashBond`, `setClaimBond` and `retire` (`contracts/EnclaveDeployments.sol:1434,1650,1725`).
   - `GovernanceSeal` is implemented and fork-tested but not activated.
6. **No permissionless discovery or first-user bootstrap.**
   - There is no committed, reviewed production contract-pins document (`git ls-files` finds none).
   - Registry capability bits cover hosts and relays only (`EnclaveRegistry.sol:111-118,238`); directories, storage
     adapters, checkers, DNS replicas and bootstrap replicas cannot self-register anywhere.
   - Every trust profile is hand-supplied, and today all of those services are Enclave-operated.
7. **Source-control parity risks.**
   - Production `sia-s3` (0.1.3–0.1.8) exists only on the 17-commit unmerged `decentralize/sia-recovery` lineage; `main`
     has no `sia-s3` directory.
   - Adapter 1.0.17 (live) is 3 commits ahead of `main` on `decentralize/wallet-uploads`.
   - The `enclave` branch is 72 commits ahead of local `main`.
   - Windows is documented as having accepted ownership on `0xbbd885d3…` (`nan-retirement.md:35`). There is no
     deployment record for it, and the verified authority that V2 custody pins is `0xF5E9E6C0…`
     (`contracts/deployments/independent-authorities-base.json:17`).

**Overall: the full decentralization goal is not complete.** Do not describe production as censorship resistant until
items 1–6, plus the owned custody, Sia-write and direct-supervisor work, are activated and the acceptance demonstrations
in `decentralized-architecture.md:709-714` pass.

## Feature-parity and mandatory-authority matrix

Legend:
- **MA**: a mandatory Enclave authority remains on the default or only path.
- **Opt**: an Enclave service still exists but has a working non-Enclave alternative.
- **SG**: source gap.
- **DG**: deployed (activation) gap.
- **Owner**: who must authorize activation.

### A. Dashboard, browser deployment and session auth

| Feature | Current authority (evidence) | Censorship-resistant path in source | Status |
| --- | --- | --- | --- |
| Contract addresses | Mutable `EnclaveAddressBook` `0xab21…`; the first RPC that answers rewrites `DEPLOYMENTS_ADDRESS` and the others (`site/js/core/config.js:101,125-153`; `addressbook.js:19-31`, single-RPC `eth_call`) | CLI `--contract-pins` (`cli/enclave.mjs` help, around line 4337); hosts use `network/contract-pins.mjs`. Nothing in `site/`. | **MA, SG** |
| Create and fund | The wallet sends txs directly (`site/js/pages/deploy.js` with `chain.js`). ETH funding needs the API price (`fund.js:91`); USDC does not. | Chain-direct already | Opt (but inherits the book redirect above) |
| Claim nudge | `/v1/claim-hint` fan-out (`deploy.js:396,417`; `relay/api-relay.js:1957`) | Hosts sweep the ledger within about 60 s (`deploy.js` comment, around line 393) | Opt |
| Deployment list and status | `/v1/deployments` through the relay with `?owner=` (`site/js/core/api.js:285-300`). No chain fallback; a failure is shown as a failure (`test/site-list-failure.test.mjs`). | CLI `ls` merges chain rows (`cli/enclave.mjs:1213-1257`, `chainDeployments`) | **MA (browser), SG** |
| Logs, restart, attestation, app tokens | Relay `tenantRoute` to the host supervisor over the fleet tunnel (`api.js:319-334`; `api-relay.js:1862-1888`) | None. Native client is GET/HEAD to apps only. | **MA, SG** |
| SIWE per-host sessions | Supervisor issues an SIWE message with `SIWE_DOMAIN`/`SIWE_URI` defaulting to `enclave.host` (`supervisor.js:82-83`) and rejects other domains (`supervisor.js:6028-6031`). CORS defaults to `https://enclave.host` (`supervisor.js:85`). | Session-signed requests (`session-api-auth.mjs`) accept the configured `PUBLIC_URL` bases | **MA for mirrored dashboards** (domain mismatch plus CORS), SG |
| Private-app browser sign-in | Bounces to `${SIWE_URI}/authorize` (`supervisor.js:4900-4960`) | Configurable env only | MA by default |
| Account (passkey), SSO, device link, credit vault | `relay/auth.js`, `sso.js`, `billing.js` (`api.js:340-371`) | Wallet path; inherently central for passkey accounts | Opt (central by nature; keep as an optional service) |
| Wallet sessions (agent budgets) | Relay relayer/keeper/index: `sdk/sessions/src/constants.ts:71-79`, `site/js/core/sessions.js:36,47`, CLI `session new` uses `RelayClient(API_BASE)` (`cli/enclave.mjs` around 3639-3700) | SDK `prepareSessionOpen` plus any gas payer. `PinnedSessionVaultFactory` `0xEc92…` is deployed and verified. | **MA (browser and CLI), SG**; DG (no grants migrated) |
| Network tab (owner policy, BYO) | Posts to the relay `/v1/network/policy` (`site/js/core/enclave-network.js:14-19`). Reaches the directories only through the bridge on the control VM (`nan-retirement.md:49`). | `scripts/network/owner-policy.mjs --directories` publishes directly (lines 17-40) | **MA (browser), SG** |
| Fleet, prices and availability panels | `/availability` and `/enclaves` (`api.js:246-275`) from a relay that by default follows only `DEFAULT_TRUSTED_OPERATORS = [0x390e…]` (`api-relay.js:191-197`; production value unknown) | Registry prices are on chain; host `/availability` has no relay-free discovery | **MA (visibility), SG** |

### B. New-user onboarding and publication

| Feature | Current authority | Path in source | Status |
| --- | --- | --- | --- |
| Get the client | `get.enclave.host` or GitHub. `ENCLAVE_RELEASE_PUBKEY` is empty, so unsigned releases are accepted with a warning (`cli/install.sh:45-49`). | `npm install -g ./cli` from any copy | Opt; signing SG |
| Learn the network (pins, RPCs, directories, storage plan, runtime pins, checkers) | Implicit: `enclave.host` plus the mutable book | Native client and `fetch-runtime` take an explicit profile, but no reviewed public profile exists. `capture-contract-pins.mjs` reads the mutable book. | **MA, SG** |
| Publish WASM or config (CLI) | `/v1/apps/upload-token` HMAC (`api-relay.js:1900`) on the legacy path; defaults `ipfs.enclave.host` (`cli/enclave.mjs:73-74`) | `publish --storage-plan --wallet --contract-pins` (deployed-adapter direct signatures, multi-copy readback) | Opt (CLI) |
| Publish (browser) | `IPFS_WALLET_AUDIENCE = ""` (`config.js:168`), so `signedUploadToken` goes through the API (`catalog.js:399`). Single adapter `ipfs.enclave.host` (`config.js:169-173`). Adapter CORS defaults to `https://enclave.host` only (`enclave-apps/s3-ipfs-adapter/src/main.rs:199`). | None in the browser | **MA, SG/DG** (the audience value is a one-line activation once reviewed) |
| Catalog listing and approval | On-chain catalog. Approval is now host-local for wallet-policy hosts. Owner powers remain (section M). | Explicit versions deploy regardless of moderation | DG (seal); legacy hosts still gate on approval |
| Deploy with owner-committed startup | n/a | CLI `deploy --chain-only --prepare-only`, then `bootstrap prepare/publish/activate --storage-plan` | Source done (CLI); **browser SG** |

### C. Native and browser routing

| Feature | Current authority | Path in source | Status |
| --- | --- | --- | --- |
| Route records | 4 signed directories (Enclave-operated) with pinned authorities | Anyone can run `network/public-directory.mjs`; hosts publish to several origins | DG (independent operators); discovery SG (section B) |
| Browser DNS | `app.enclave.host` delegated to 4 provider replicas (`DNS_READ_ONLY`). The parent `enclave.host` is Enclave's registrable domain, so control is outside the source by definition. | `relay/dns-relay.js` read-only can serve any `APP_ZONE` (`dns-relay.js:43,165`), but the guest front cannot certify another zone (section D) | **MA** |
| Native access | Full-ID directory lookup, pinned RPC/policy, attested SPKI | `network/native-client.mjs`, `scripts/network/native-get.mjs` | Done for GET/HEAD. POST and streaming are in progress, uncommitted, in another workstream. **WebSocket is SG.** |
| Providers and checkers | Permissionless registry plus checker qualification; checkers are explicitly selected trust anchors | The provider installer still defaults to the mutable book, the API relay, `app.enclave.host` and `probe.enclave.host` (`network/wg-provider/install.sh:27-28`; `main.mjs:62`). Outbound probe defaults to `https://enclave.host/` (`network/provider-probes.mjs:7`). | SG (open-participation defaults); DG (no independent providers) |

### D. DNS and certificates (including custom domains)

| Feature | Current authority | Path in source | Status |
| --- | --- | --- | --- |
| App-zone WebPKI cert | The relay holds the CA accounts, EAB and DNS-01 (`relay/certs.js` header). The supervisor's slot 0 uses `CERTS_API` (`supervisor.js:824-861,1158,8700`). Windows `apptls.mjs:115` defaults to `api.enclave.host`. | Optional in-enclave ACME with the operator's own EAB (`metal/config.example.json` `_comment_acme`) still answers DNS-01 in Enclave's zone | **MA** |
| Guest cert gate | Requires the relay's `/v1/expected-guest` prediction (`supervisor-guestcert.mjs:17-20,138`; `api-relay.js:2918`) | `native-profile.mjs` reproduces the measurement client-side but is not wired into issuance | **MA, SG** |
| Name certifiable by the guest | Fixed `app.enclave.host` (`front/main.go:145`; `dominit.c:892-893` passes no `-cert-zone`) | None | **MA, SG** (new measured release needed) |
| Custom domains | Relay `domains.js` store, verification and challenge alias. The guest learns names only from `RelayHost/v1/domains/map` (`front/domains.go:62,71`). Windows uses `domains.mjs:58`. | Direct mode disables the watcher (`decentralized-architecture.md:147-149`); there is no owner-committed name set | **MA, SG** |
| ACME challenge DNS | DNS-01 forwarded to minipc control (`nan-retirement.md:110`) | `dns-relay.js` already authorizes operator-signed TXT for lease holders and can be run by anyone, but there is no client path to an alternative zone | **MA** |

### E. Host ownership and local veto

| Feature | Status |
| --- | --- |
| Two-party ownership and policy (`EnclaveHostOwnership`) | Source done; verified deployment `0xF5E9E6C0…`. Linux and Windows runtimes enforce it when `ENCLAVE_HOST_OWNERSHIP` and the related settings are configured (`nan-retirement.md:71-77`). |
| metal0 | Operator nominated (tx `0x395e91a7…`). **Owner acceptance and `setPolicy` are unsigned (DG; owner signature).** The measured control overlay is staged and hardware-booted, but production is not replaced. |
| Windows nucbox-k11-4 | Live on ownership contract `0xbbd885d3…` per docs, with no deployment record in `contracts/deployments/`. **This must be reconciled with `0xF5E9E6C0…`, which V2 custody pins**: operator nomination, then owner acceptance and policy on the new contract. |
| Fallback when unconfigured | Catalog approval (central) (`direct-host-control.md` "Admission"). |

### F. Artifact publishing and retention

| Feature | Current authority | Path | Status |
| --- | --- | --- | --- |
| Host component fetch | Supervisor probe default `IPFS_GATEWAY` is `https://ipfs.enclave.host` (`supervisor.js:9348`); guestd default gateway is Enclave's (cold-host result); Windows `agent.mjs:247`, `apprun.mjs:159`, `fetch-cid.py:26`, `install-host.ps1:260,331` | Explicit gateway lists; `-cpu-release` requires them | SG on Windows; Linux uses explicit configuration |
| Retention | Single adapter on minipc Sia/indexd, plus 4 Enclave static replicas. `scripts/catalog-pin-sweep.mjs` re-pins to Enclave's gateway. | Storage plans with N adapters and readback; `artifact publish/verify` | **DG** (no independent stores; no retention contract) |
| Runtime and kernel releases | Operator pins a release ID; the replicas are Enclave-operated | `fetch-runtime.mjs`, raw-CID replicas | DG (independent replicas) |

### G. Secrets and updates

| Feature | Current authority | Path | Status |
| --- | --- | --- | --- |
| Relay-held app secrets | `SECRETS_API` defaults to `https://api.enclave.host` (`supervisor.js:6753`); the fetch key is derived from the fleet `SECRET`. The relay sees plaintext. Windows `secrets.mjs:80,126`; Shield `shield-secrets.mjs:46`. | Custody v2 inside owner-committed packages (custody workstream) | **MA** (owned elsewhere) |
| SNP release guests | Relay release ticket and status (`supervisor.js:2527,2574`), Enclave release key (`release/pins.go:14`) | Direct-bootstrap build | MA for legacy; direct path done |
| App version upgrade and config | Ledger `setAppRef` and envelope (wallet or session) | Chain | Done |
| Linux metal host updates | Opt-in timer follows the newest GitHub release tag of `EnclaveHost/enclave`, unsigned (`metal/update.mjs:146-149,182`) | Rebuild from a pinned checkout | Opt (opt-in); signing SG |
| Windows host updates | Unsigned `get.enclave.host/windows/latest.json` triggers install (`agent.mjs:893-896`; `update-host.ps1:3-5,92-101`) | None | **MA (global code push), SG** |
| Release publishing tooling | `ssh nan` in `site/deploy.sh:37-52`, `scripts/publish-windows-host.sh:19-53`, `publish-android-host.sh`, `relay/deploy.sh`, `.github/workflows/deploy.yml` (Nan is retired) | None | SG (operational) |

### H. Storage reads, writes and renewal

| Feature | Status |
| --- | --- |
| Reads | Verified multi-replica and cold reads (CLI, native profile, guestd CAR fetcher). The sealed Sia snapshot reader works with indexd blocked (enclave-apps `446ac5f`). |
| Writes and renewal | Single live indexd/PostgreSQL writer on minipc; no independent writer or renewal (owned by the Sia workstream). **MA.** |
| Adapter backend credentials | Delivered as `$VAR` relay secrets on the adapter deployment (s3-ipfs-adapter README, around line 223). A restart therefore depends on relay secrets until custody v2 or an owner-committed path is used. **MA, DG.** |
| Source parity | `sia-s3` exists only on the unmerged `decentralize/sia-recovery` lineage, 17 commits ahead of `main`. Adapter wallet uploads are 3 unmerged commits. **SG (integration).** |

### I. GPU and CPU runtimes

| Runtime | Status |
| --- | --- |
| SNP CPU (metal) | Direct startup proven on hardware, including from the cold store (`48390694`). The production fleet still runs legacy release images. **DG.** |
| SNP with Shield (masked GPU) | `-direct-bootstrap -release` accepts a Shield template with the mode marker. `-cpu-release` refuses Shield (cold-host result). **SG for a cold GPU host.** |
| Windows Hyper-V Shield (GPU apps such as EyesOff) | Relay for secrets, certificates and domains; no owner-committed startup. **MA, SG.** |
| pVM (Android) | `relay/pvm-*.mjs`, `pvm-market`, `pvm-secrets`. Not audited in depth; relay-dependent. |
| Capacity audits | Enclave-operated witness and predictor (`docs/design/paid-capacity-verification.md:20-30`). Optional, payer-configured. Opt. |

### J. Billing, payments, capacity and lease recovery

| Feature | Status |
| --- | --- |
| Wallet USDC or ETH funding, refunds, transfers, rate caps | Chain-direct (CLI and browser). ETH in the browser needs the API price (`fund.js:91`). Opt. |
| Card or USDC orders | Stripe plus OFAC; the company provisioner wallet owns the resulting deployments (`relay/provisioner.js:1-10,214,240`). Central by nature, and those deployments are custodial. Document as an optional on-ramp. |
| Credit vault (passkey) | Relay executes; the vault resolves the ledger via the book (`billing-runbook.md:279-310`). Central by nature. |
| Bandwidth settlement (`EnclaveConnectivity`) | On chain; providers are Enclave-operated. DG (operators). |
| Lease recovery | Lease expiry lets any eligible host claim (chain). Independent hosts serve only owner-committed or public deployments, because legacy secret deployments need the relay (section G). |
| Capacity visibility | Relay `/availability` and `/enclaves` (section A). **SG.** |

### K. Host installation (including Windows)

| Platform | Status |
| --- | --- |
| Linux cold host | `fetch-runtime` plus `guestd -cpu-release` (docs/network/cold-host.md). VCEK collateral needs a guest report (`isolation/m2/vcek-prep.mjs`; cold-host.md). **SG.** The direct-only supervisor in a measured control image is owned elsewhere. |
| Linux `enclave host init/run` | Defaults to `relayUrl wss://api.enclave.host/v1/fleet-tunnel` and `publicUrl api.enclave.host/t/<name>` (`cli/enclave.mjs:4377-4379`; `metal/config.example.json:7-8,59,65`). Tunnel attachment needs a relay token or a `METAL_ALLOWED_MEASUREMENTS` allowlist (`api-relay.js:130-140,262`). **MA for the management plane.** |
| Windows | Installer requires relay name availability (`install-host.ps1:88-89`; `EnclaveSetup.cs:389`). Identity is `$Relay/t/$Name` (`install-host.ps1:206,320-321`). Downloads come from `get.enclave.host` (`EnclaveSetup.cs:76-77,304`). **MA, SG.** |
| Provider, directory and checker installers | Default to the book and relay (section C). **SG.** |

### L. Operational recovery

| Item | Status |
| --- | --- |
| Control and storage snapshots | Encrypted on 4 Enclave providers. A full control-VM restore has not been rehearsed (`nan-retirement.md:39`). **DG.** |
| Sia point-in-time recovery | Done (read-only). Live writer recovery is owned elsewhere. |
| Cold host and guest | One hardware run of the cold-store SNP boot (lab derivation, not the full supervisor; host collateral pre-present) (`cold-host.md`, `48390694`). **DG** for the supervisor-driven boot. |

### M. Governance and contracts (cross-cutting)

| Item | Status |
| --- | --- |
| Catalog owner | `setApproval`, `grantCid`, `transferApp` (lineage seizure), `setMaxFee`, imports (`EnclaveAppCatalog.sol:557,581,610,631,676-789`). **MA** until sealed. Consumers must not use approval as global admission (already host-local in wallet mode). |
| Ledger owner | `slashBond`, `setClaimBond`, `retire` (`EnclaveDeployments.sol:1434,1650,1725`), plus the configuration listed in `decentralized-architecture.md:633-637`. **MA** until sealed. |
| Registry | `register` and `registerRelay` are permissionless (`EnclaveRegistry.sol:176,232`). No admin admission, which is good. |
| Seal | `GovernanceSeal` source and fork tests pass. Activation needs the Enclave owner wallet nomination after dependency review. **DG.** |

### N. App-level platform services (enclave-apps)

| Service | Status |
| --- | --- |
| Sign in with Enclave | `jot/src/sso.rs:68,201`, `eyesoff-ai/src/sso.rs:72`, `depot`, `api-mcp-adapter`. Tokens are minted by the relay's `SSO_SIGNER_KEY` against relay accounts. The signer and authorize URL are configurable per app, but no independent issuer exists. **MA (feature), SG.** |
| EyesOff in-app attestation | Hard-coded `API = "https://api.enclave.host"` (`eyesoff-ai/src/attest.rs:31`). **MA, SG.** |
| `ipns-publisher` | Default gateway `ipfs.enclave.host` (`provider.rs:148`). Configurable. Opt. |
| Hosted MCP (`relay/mcp.js`) | Central; the CLI covers chain actions. Opt. |

## Hidden authority inventory (non-obvious)

1. **Browser address-book redirect.** Contract addresses are rebound at runtime from the mutable book through the first RPC
   that answers (`site/js/core/addressbook.js:19-31`, `config.js:125-153`). No quorum, no pin. This is a write-path
   authority, not just discovery.
2. **API fleet filter.** `DEFAULT_TRUSTED_OPERATORS = ["0x390e…"]` (`relay/api-relay.js:191`). Independent hosts are
   invisible to dashboard availability, claim hints and live rows unless production sets `TRUSTED_OPERATORS=*` (private
   value, unknown).
3. **Upload token issuer.** Still the browser's only upload path (`config.js:168`; `catalog.js:399`).
4. **Measurement predictor.** `/v1/expected-guest` is the trust root for guest certificate issuance
   (`supervisor-guestcert.mjs:17-20,138`) and for the capacity witness.
5. **Fleet tunnel and host naming.**
   - Host identity strings embed `api.enclave.host/t/<name>`.
   - Name availability is an off-chain relay check (`/v1/hosts/name`, `api-relay.js:1951`).
   - Tunnel admission is a token or measurement allowlist (`api-relay.js:130-140`).
6. **Domain authority pinned in the measured guest.** `release.RelayHost = "api.enclave.host"` (`isolation/m2/release/pins.go:14`)
   is used by `front/domains.go:62`.
7. **Unsigned Windows update channel.** `latest.json` (see G).
8. **Session relay index and config.** The CLI waits on the relay's `/by-key/` index (`cli/enclave.mjs` around 3686-3700).
   The browser reads relay `config()` (`site/js/core/sessions.js:36`).
9. **Provider installer defaults** to the book and relay (`network/wg-provider/install.sh:27-28`).
10. **Catalog lineage seizure.** `transferApp` (`EnclaveAppCatalog.sol:610`) lets the catalog owner publish new versions
    under an existing publisher's slug lineage.
11. **Card orders are company-owned deployments.** `provisioner.js` creates them from the company wallet.
12. **The relay `indexer.js` is a payments indexer only** (PaymentRouter logs for orders). It is not a catalog or registry
    indexer. No hidden catalog indexer was found: the catalog and registry are read directly from chain everywhere I
    checked.

## Source gaps vs deployed gaps

**Source gaps (code needed before any activation):**
- Browser decentralized mode (section A).
- Independent naming and WebPKI for direct guests (section D).
- Relay-free management plane (section A); native POST and streaming are in progress elsewhere (section C).
- Windows direct startup, signed updates and relay-optional installer (sections G and K).
- Open-participation defaults for providers, directories and checkers, plus permissionless service discovery (sections B
  and C).
- A reviewed first-user authority profile (section B).
- CLI parity for logs, attest, restart and sessions without the API (sections A and J).
- App SSO and attestation independence (section N).
- Cold-host VCEK collateral without a guest report (section K).
- Shield on `-cpu-release` (section I).
- Merging `sia-s3` and adapter wallet uploads to `main` (section H).
- Release tooling retargeted off Nan (section G).

**Deployed gaps (code exists; activation needed):**
- metal0 owner acceptance and policy (owner signature).
- Windows re-enrollment on `0xF5E9…` (operator nomination, then owner acceptance and policy).
- Direct-only control image (owned by the direct-supervisor workstream).
- Production migration to owner-committed startup (per-deployment owner or scoped session).
- Pinned-factory session grants (owners).
- Independent storage stores and retention.
- Custody quorum (owned elsewhere).
- Governance seal (Enclave owner wallet, after review).
- Independent operators for providers, directories, checkers and replicas (cannot be manufactured; open participation
  only).
- Full control-VM restore rehearsal.

## Activation order, with commands and tests

Steps not marked otherwise are coordinator or source operations.

1. **Source parity first (no wallet).**
   - Merge, or at least rebase onto `main`, the `enclave-apps` `decentralize/sia-recovery` (`sia-s3`) and
     `decentralize/wallet-uploads` lineages.
   - Record `0xbbd885d3…` in `contracts/deployments/` or retire it.
   - Re-run `node --test test/host-contract-pins.test.mjs test/supervisor-wallet-policy.test.mjs test/host-admission-runtime.test.mjs`.
2. **Reviewed authority profile (no wallet).**
   - Run `node scripts/network/capture-contract-pins.mjs --book 0xab21… --out NEW_DIR` and
     `node scripts/network/capture-network-authorities.mjs --book 0xab21… --out NEW.json`.
   - Commit a reviewed profile with bytecode hashes, adding the pinned session factory `0xEc92…` and ownership
     `0xF5E9…`.
   - Publish it with the IPFS site.
3. **Browser direct uploads (no wallet).** Set `IPFS_WALLET_AUDIENCE` to the adapter deployment ID after confirming the
   adapter's `upload.walletAudience`, then rebuild and deploy the site.
   - Tests: `node --test test/storage-upload.test.mjs test/site-eip191.test.mjs`.
   - Verify with the API's `/v1/apps/upload-token` blocked.
4. **Host ownership activation (needs the host owner's signature; the operator key may nominate).**
   - Run `node scripts/network/prepare-host-policy.mjs --policy DOC.json --owner 0x0b2d… --registry PIN --book 0xab21… --out NEW_DIR`
     for metal0, and for Windows against `0xF5E9…`.
   - Publish the policy document locally first.
   - The owner signs `acceptOwnership`, then `setPolicy`. Re-read and simulate each transaction after its prerequisite
     confirms.
   - Tests: `node --test test/host-admission-policy.test.mjs test/supervisor-wallet-policy.test.mjs`.
5. **Direct-only control image and live claim.** Owned by the direct-supervisor workstream. Source landed in
   `af16a74c` (`ISOLATION_DIRECT_ONLY`).
   - Prerequisites from this audit: explicit `IPFS_GATEWAY`, a storage plan, empty `SECRETS_API`, `DOMAINS_API` and
     `CERTS_API`, and pins (see `directOnlyProblems`).
   - Use a funded owner-committed deployment via a scoped CLI session or the owner wallet:
     `enclave --contract-pins P deploy APP --chain-only --prepare-only …`, then
     `bootstrap prepare|publish|activate --storage-plan S`, then fund.
6. **Signed Windows updates.** After scope S4 lands, ship one release that adds verification while still accepting the
   current channel. Then flip to require signatures. This is the operator's release key, not the owner wallet.
7. **Custody v2 migration** (owned elsewhere), then owners re-commit custody-mode packages. **Sia independent writer**
   (owned elsewhere).
8. **Independent naming and WebPKI** (scope S2): new measured direct release, hardware validation, then owner packages
   that name their domains.
9. **Governance seal** (Enclave owner wallet nomination; anyone finalizes):
   - `node scripts/capture-governance-review.mjs --ledger 0xB178… --catalog 0x1841… --out NEW.json`
   - `forge test --match-contract GovernanceSealLiveForkTest --fork-url https://mainnet.base.org --fork-block-number REVIEW_BLOCK -vv`
   - Do this only after the guest and custody transition no longer needs owner-tunable parameters.
10. **Acceptance demonstrations** (`decentralized-architecture.md:709-714`):
    - Cold client and guest with Enclave control, identity, release, DNS and one store denied.
    - A new wallet deploys through the browser and the CLI.
    - An Enclave host-wallet veto stops only Enclave's hosts.
    - Owner revocation and transfer take effect.

## Proposed next parallel implementation scopes

None of these touch the three owned areas (direct supervisor path, custody, Sia writes). File sets are disjoint from
those streams' current edits (`supervisor.js`, `custody/v2/*`, `sia-s3/*`). Ranked by parity and censorship impact.

**S1. Browser decentralized mode** (`site/js/core/{config,addressbook,api,catalog,chain,sessions,enclave-network,fund}.js`,
`site/js/pages/{deploy,dashboard,apps}.js`, `site/components/deployments/*`; new `test/site-pinned-*.test.mjs`)
- Replace book resolution with a pinned profile from S6, and require two or more agreeing RPCs at the same block.
  Reuse `network/contract-pins.mjs` validation; the book survives only as an explicit legacy toggle.
- Wallet-direct uploads through a storage plan: reuse `sdk/storage/upload-auth.mjs` and `artifacts.mjs`, already used by
  the CLI.
- A chain-only deployment list from `Created` logs and `get()`; it must never show "no deployments" on a read failure.
- Owner-committed startup (`sdk/bootstrap/package.mjs`).
- Network policy published to directories (`network/directory-client.mjs`).
- Relay-free session open via `prepareSessionOpen` and the pinned factory, with the wallet as gas payer.
- **Acceptance:** with `api.enclave.host`, `ipfs.enclave.host` and the book blocked, a loopback or IPFS-origin dashboard
  publishes, deploys, funds and observes the lease on Anvil (extend `e2e`).
- **Conflicts:** none.

**S2. Independent naming and WebPKI for direct guests** (`isolation/m2/front/{main,certs,domains,bootstrap_mode_direct}.go`,
`isolation/m2/bootstrap/manifest.go`, `sdk/bootstrap/package.mjs`, the CLI `bootstrap prepare` flags, `relay/dns-relay.js`
in read-only/challenge mode; Go and Node tests)
- An owner package carries an explicit name set (custom domains and optionally an owner zone).
- The direct front certifies only those names, plus the legacy label if desired. There is no `RelayHost` watcher.
- In-guest ACME DNS-01 against an owner- or operator-selected challenge responder. The responder authorizes a TXT write
  by lease plus attested SPKI, and the account key is held in guest memory or custody v2. No Enclave CA account.
- **Duplicate-certificate rate limits:** the design must address them, for example with a ZeroSSL account from owner
  secrets or by persisting the certificate in sealed state. See `docs/custom-domains.md:51-71`.
- Changes the measured direct release; needs hardware validation.
- **Coordination:** the direct-supervisor stream must not also change the package schema.

**S3. Relay-free management plane** (`network/route-record.mjs`/`public-directory.mjs` for a host-management route
type, `network/enclave-network-host.mjs`, a new management client module)
- Owner-signed (session-API format) logs, status, restart and attestation reach the host's existing loopback supervisor
  API through a published management route.
- **Do not duplicate:** native POST and streaming are already in progress (uncommitted) in `network/native-client.mjs`.
  Start S3 after that lands, and build on it rather than editing it concurrently.
- **Coordination:** the direct-supervisor stream must accept `PUBLIC_URL`/route bases in `session-api-auth`; do not edit
  `supervisor.js` here.

**S4. Windows host independence** (`windows/node/{agent,update-watch,secrets,apptls,domains,host-onchain,keys}.mjs`,
`windows/installer/{install-host.ps1,update-host.ps1,EnclaveSetup.cs}`, `scripts/publish-windows-host.sh`,
`cli/host.ps1`; tests `test/windows-*.test.mjs`, `windows/node/*.test.mjs`)
1. Ed25519-signed `latest.json` and manifest, with the key pinned at install. Mirror lists; refuse unsigned after a
   transition release.
2. A name check from chain `idOf` collision plus an optional relay check; `PUBLIC_URL` not forced to the relay; explicit
   gateway lists; relay optional.
3. Ownership `0xF5E9…` enrollment preparation.
4. Publish to the four fronts or content-addressed replicas instead of Nan.

Later, as S4b: Shield owner-committed startup.

**S5. Open-participation kit and service discovery** (`network/wg-provider/{install.sh,main.mjs}`,
`network/provider-probes.mjs`, `scripts/network/{wg-qualify,owner-policy,wg-soak}.mjs`; a new ownerless
`contracts/EnclaveServiceIndex.sol` with Foundry tests)
- Defaults switch to `authorityPins` and explicit directories, with no `enclave.host` probes.
- An append-only, admin-free self-registration of directory, storage, checker, DNS and bootstrap-replica endpoints, keyed
  by the operator's signature.
- Clients still choose their trust (checkers and minimum copies).
- Deployment uses a scoped deployer and gas wallet, not the owner.

**S6. Reviewed first-user authority profile** (`contracts/deployments/network-profile-base.json`,
`scripts/network/{capture-contract-pins,capture-network-authorities}.mjs` verify mode, a CLI `profile verify` command,
native-client profile import)
- A hash-identified profile, re-derivable from chain bytecode, that is distributed with the site, IPFS and ENS text
  records.
- Prerequisite for S1 and the new-user acceptance gate. Low risk; can start immediately.

**S7. CLI parity without the API** (`cli/enclave.mjs`, `sdk/sessions/src/*`; `test/cli*.test.mjs`)
- `ls` and `status` fully from chain under pins.
- `session new` relay-free on the pinned factory.
- `pricing` and `availability` from the registry plus directories.
- ETH funding price from the ledger oracle.
- `logs`, `attest` and `restart` via S3 once available.

**S8. App platform independence** (`enclave-apps`: `jot`, `depot`, `api-mcp-adapter` and `eyesoff-ai` `sso.rs`;
`eyesoff-ai/src/attest.rs`; `s3-ipfs-adapter/src/main.rs:199` CORS default; not the `sia-s3` directory)
- Apps accept direct wallet SIWE or an owner-configured signer.
- EyesOff attestation is self-served, with no hard-coded API.
- Adapter `allowOrigins` comes from configuration, with no `enclave.host`-only default.

**S9. Cold-host collateral** (`isolation/m2/vcek-prep.mjs`, a host-side chip-ID/TCB → KDS fetch, or a verified
operator-supplied VCEK; tests next to `test/pinned-host-runtime.test.mjs`). Needs `/dev/sev` access for the live check
only.

## Verified as done (do not duplicate)

- Owner-committed startup (guest, guestd and the supervisor package path), CLI chain-only deploy, storage-plan
  publication and readback, and cold-host runtime fetch and guestd `-cpu-release`.
- The native client (GET/HEAD), native profile reproduction, signed public directories with pinned authorities,
  read-only DNS replicas, relay-free provider bootstrap and local BYO.
- Linux reconciliation without the API, host-local wallet policy in the Linux and Windows runtimes, and pinned host
  session authority.
- Independent custody formation source (custody stream), Sia point-in-time recovery, and the governance seal source with
  fork tests.

## Residual trust and limits

- RPC-quorum trust, not a light client; the Base sequencer, the USDC issuer and the oracle remain external.
- All providers, directories, checkers, replicas and stores today are Enclave-operated. Distinct identities on test
  infrastructure are not organizational independence.
- This audit did not inspect private production environments, so `TRUSTED_OPERATORS` and `SECRETS_API` production values
  are unknown.
- pVM/Android and hosted MCP paths were reviewed only at the level of their endpoints.
