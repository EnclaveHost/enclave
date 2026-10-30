> Publication note: this is a source audit of pinned staging trees, not a production acceptance report. The shared relay-reader changes and host-policy gate changes were in progress when it was written. Components may be released from separately tested source trees; a single combined tree is not a prerequisite for starting an additive canary. No live cutover is authorized by this document. Tests listed as unverified are not passing evidence. Custody measurement/admission changes require their own review and any applicable administrator signatures.

# Platform consumer cutover matrix: public execution RPC → own P2P-synced backend + proofs

Date: 2026-10-25. **Read-only source audit.** No SSH, no live/private config read, no source edits, no builds or tests.
Sources read:
- **C** = `control-source` at `9fa02e1bc` (runtime `ec56a70f1`; plus untracked `node_modules`).
- **P** = `route-publication-source` at `9a4880464`, the published candidate. `logs/publication-source-identity.json`
  records it as identical to route-source `dba7b4fdc` over 8403 files.
- **Route stage:** `route-stage/README.md`, `ROOT-LIVE-FIELDS-VERIFIED.md` and `LEASE-RELAY-VERIFIER-MIGRATION.md`.

Labels used below:
- **[src]** I saw it in source.
- **[root-live]** It comes from root's whitelisted live inventory (`route-stage/ROOT-LIVE-FIELDS-VERIFIED.md`).
- **[unverified]** It is a live deployment fact that I did not check.

Scope is the current goal: replace third-party execution-RPC *reads* with the own node plus proofs. Out of scope:
- Sequencer submission (the hosted sequencer stays the single forward route).
- Wallet-selected RPC: the browser's `window.ethereum`/wallet provider and the user CLI's `ENCLAVE_RPC`.
- Deploy scripts (`RPC_URL` and `ETH_RPC` in `scripts/deploy-*.mjs`).
- Evidence scripts under `isolation/`.

## 0. Headline findings

1. **The two trees diverge, and neither carries every verifier seam.**
   - **C** has the relay network-reader verifier (`relay/chain-sources.mjs:14-17`, used at `relay/api-relay.js:2688-2699`).
     It also has the DNS-relay verifier (`relay/dns-relay.js:113-118` and `192-197`), the native-control verifier
     (`network/native-control-routes.mjs:67-70`) and `network/chain-authority.mjs`.
   - **P** has none of the above. It has no `network/chain-authority.mjs`. Its `relay/api-relay.js:2687` hard-codes the
     `NETWORK_CHAIN_RPCS` quorum, and its `dns-relay.js` has no `chainAuthority`.
   - **P** does have the Windows node verifier (`network/verified-read-client.mjs`, `windows/node/chain.mjs:29-168`,
     `host-onchain.mjs:45-82`, `chain-reader.mjs`, `host.mjs:310-311`, `session-api-auth.mjs:217`). **C**'s `windows/`
     has none of it.
   - **So a relay or DNS cutover must deploy from the C lineage, and a Windows cutover from the P lineage.** Composing
     them is a merge task, not config.
2. **The relay (`relay/api-relay.js`) is the largest residual, even on C.** Only the network lease/registry reader can
   use the verifier. At least **five other independent RPC paths** stay on public providers, and none of them has a
   verifier seam (§1). Under verifier mode, the relay's admin-adjacent reads would still be judged by one third-party
   provider, the `BASE_RPC` default `https://mainnet.base.org` [src]. These are placement, custody gating and
   `registryProofKey`.
3. **Custody v2 bakes its RPC list into the measurement**, and that list is all third-party:
   `custody/v2/build-config.mjs:25` `MEASURED_RPCS` is copied into the measured config at `:51` with `minAgree: 3`.
   Moving custody to the own backend needs three things:
   - a source change, because a proof-backed reader does not exist there;
   - a **new measured image**;
   - a new committee / admission under the custody code-freeze rules.

   This is the highest-cost blocker. It cannot be done by config.
4. **The privacy-agent host-services gate is not migrated in the published candidate.** In
   `P network/privacy-agent.mjs:276`, `hostPolicyCarrierGate(...)` is called with no verified snapshot.
   - route-source has uncommitted edits to `network/host-policy-carrier-gate.mjs`, `host-policy-gate-config.mjs`,
     `privacy-agent.mjs` and `test/helpers/platform-policy-world.mjs`.
   - `route-stage/AGENT-AUTHORITY-RESULT.md` does **not exist**, so that work is unfinished or unreported.
   - This is moot for current Metal0, which has no hostServices [root-live]. It is **required** for the staged
     full-host-services integration (`examples/metal0-full-host-services.staged.json`).

## 1. Cutover matrix

"Verifier on C / P" means the seam exists in that tree's source. "Required change" means **SRC** (code needed) or
**CFG** (env/config only, given that tree).

### 1a. relay/api-relay.js (api relay) — entry `relay/api-relay.js`

| # | consumer | config name | verifier on C / P | required change |
|---|---|---|---|---|
| R1 | Network lease + registry reader (route leases, `registryOperator`) | `NETWORK_CHAIN_RPCS` (default 4 public, `relay/chain-sources.mjs:9`); verifier: `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER` (loopback) | **C yes** (`chain-sources.mjs:14-17`, `api-relay.js:2692-2705`; refuses verifier without `ADDRESS_BOOK_ADDRESS` `:2695` and a stale bundle `:2697`). **P no** (`api-relay.js:2687`) | **CFG on C** (+ network-runtime bundle rebuild check). SRC/merge for P |
| R2 | Single `BASE_RPC` viem client `chain()` (`api-relay.js:325`, `570-578`) | `BASE_RPC` (default `https://mainnet.base.org`) | **no** (both) | **SRC.** Callers: custody gate `:585`, session-row SessionVault `held` `:619`, enclave discovery `:719`, deployments address `:836`, ledger rows `:852`, placement `:2081`, `:2628`, `:2655`, `registryProofKey` `:2473`, legacy `registryOperator` fallback `:2709` (bypassed when R1 is set). One provider, not even a quorum |
| R3 | `rpcPool()` (`relay/store.js:106-130`) | `BASE_RPC` + hard-coded publicnode/drpc/1rpc/mainnet fallback; `RPC_FALLBACKS=0` pins to `BASE_RPC` | **no** | **SRC** for proof-backed reads. Users: SIWE verify `auth.js:302`, billing `billing.js:143,322,427,1048`, payment indexer `indexer.js:60` (log scans — history, not state), provisioner `provisioner.js:171`, secrets owner signature `secrets.js:177`, vault service `vaultsvc.js:103-473`, network API clients `api-relay.js:2716`. CFG-only stopgap: `BASE_RPC=<own node>` + `RPC_FALLBACKS=0` removes third parties, but it is **unproven own-node reads** (no proofs) |
| R4 | Secrets-release catalog / ledger / lease-generation reader | `SECRETS_RELEASE_CATALOG_RPCS` (https, 2+ distinct hosts: `api-relay.js:2394-2442`, `2502`, `2555`) | **no** | **SRC.** The 2-distinct-host rule (`:2435`) also blocks a CFG-only point-at-own-node |
| R5 | Custody state reader | `CUSTODY_RPCS` (else `SECRETS_RELEASE_CATALOG_RPCS`), `CUSTODY_MIN_AGREE` (default 2): `relay/custody-state.mjs:54-68` | **no** | **SRC** (the `clients` injection seam exists at `:67-68`, so the change is plumbing) |
| R6 | Sessions relayer (platform relayer key sends txs) | `SESSIONS_RPC` (viem `fallback`), `SESSIONS_PUBLIC_RPC` (`relay/sessions.mjs:1226-1249`) | **no** | **SRC** (state reads + sends). Platform backend, not wallet-selected: the relayer key is the platform's |
| R7 | Host-registration sponsor (paymaster voucher + bundler `handleOps`) | `rpc: BASE_RPC` (`api-relay.js:249` → `relay/host-sponsor.mjs:75-80,185`) | **no** | **SRC** (simulation `pub.call` with `authorizationList`, then send) |
| R8 | MCP host tools | `BASE_RPC` + 4 public fallbacks (`relay/mcp.js:76-80`) | **no** | SRC (low priority, read-only tooling) |

**Tests on C:** for R1, `test/native-relay-chain-authority.test.mjs`, `test/caller-verifier-wiring.test.mjs` and
`test/relay-policy-carriers.test.mjs` reference the verifier authority. I did not open them to confirm they cover R1
specifically [unverified coverage detail]. There are no verifier tests for R2–R8, because the seam does not exist.

### 1b. DNS

| # | consumer | config name | verifier on C / P | required change |
|---|---|---|---|---|
| D1 | dns-relay app-zone challenge LeaseReader | `APP_CHALLENGE_RPCS` + `APP_CHALLENGE_PINS` (`relay/dns-relay.js:106-118`) | **C yes** (`chainAuthorityFromEnv` from the network-runtime bundle, `:59`, `:114`; stale-bundle refusal `:117`). **P no** | CFG on C |
| D2 | dns-relay Shield registry reads | `<prefix>_RPCS` / `<prefix>_PINS` (`dns-relay.js:186-197`) | **C yes**. **P no** | CFG on C |
| D3 | dns-relay **fleet** (`fleet.operatorForEndpoint` `:698`, `fleet.leaseFor` `:724-729`), active unless `READ_ONLY`/`ATTESTED` (`:93`) | `BASE_RPC` via `fleetConfig` (`relay/fleet.mjs:58`; clients `:223-225`, `:521-523`, single `http`) | **no** | **SRC.** `createFleet` is also imported by `network/host-services/packages/route-dns.mjs`, `network/host-policy-adapters.mjs` and `metal/guest/platform-api.bundle.mjs` [src]. Which of those call paths are live is [unverified] |
| D4 | route-dns host-service package | `APP_CHALLENGE_RPCS`, `ENCLAVE_PLATFORM_HOST_POLICY_RPCS`, `BASE_RPC` (`C network/host-services/packages/route-dns.mjs`) | partial: the platform host policy has a seam (`network/platform-host-policy-config.mjs:28-36`, both trees). Whether route-dns forwards the authority to its LeaseReader/fleet I did not trace [unverified] | likely SRC for the fleet/`BASE_RPC` part |

### 1c. Fleet / Windows node — entry `windows/node/agent.mjs`, `windows/node/host.mjs`

| # | consumer | config name | verifier on C / P | required change |
|---|---|---|---|---|
| W1 | Node state client (`chain.mjs` `pub`) | `BASE_RPCS` (default 5 public, `P windows/node/chain.mjs:38`); verifier `ENCLAVE_CHAIN_AUTHORITY`/`ENCLAVE_CHAIN_VERIFIER` | **P yes** (`chain.mjs:47-54,156-157`; `verified-read-client.mjs` `chainVerifierFromEnv` refuses ambiguity). **C no** | **CFG on P** (needs a host-local verifier on each Windows box; example `node-config.example.cmd:26-32`) |
| W2 | Tx/history transport (nonce, simulation, estimates, broadcast, **receipts, logs**, tx input) | `ENCLAVE_CHAIN_TX_RPCS` (`verified-read-client.mjs` `transactionRpcsFromEnv`; `chain.mjs:162-168`); unset → refuses | P yes (explicit, no fallback) | **CFG**, but see the **gap**: receipts and logs through `TX_RPCS` are **not proof-checked** on this path. C's `network/chain-authority.mjs` checks receipts against the receiptsRoot; P's Windows path does not. Pointing `TX_RPCS` at a third party leaves unproven receipt/log reads. Point it only at the own node |
| W3 | Owner registration / host on-chain writes | `BASE_RPCS` (`host-onchain.mjs:39`); verifier → `chain.transactionTransport()` (`:82`) | P yes | CFG (same as W2) |
| W4 | Startup quorum | `ENCLAVE_STARTUP_RPCS` (`host.mjs:298-311`) → chain-reader verifier | P yes | CFG |
| W5 | Network enrollment chain list | follows `chain.mjs` RPCS (`network-enroll.mjs:203`) | P: follows W1 [src comment; not traced further] | CFG |
| W6 | Session API auth | `session-api-auth.mjs:217` (verifier facts per request) | P yes | CFG |

**Tests on P:** `test/windows-chain-authority.test.mjs`, `test/windows-verifier.e2e.test.mjs`,
`test/lease-reader-verifier.test.mjs` and `test/verified-chain.test.mjs` (file names observed; not run here). The
route-stage `logs/r4-base-windows-verifier.e2e.00.out` exists. I did not read its result [unverified]. **Live:** whether
any Windows box has a local verifier is [unverified]; root's inventory covers Metal0 only.

### 1d. Site / browser

| # | consumer | config name | verifier | required change |
|---|---|---|---|---|
| S1 | Site catalog/ledger reads (no wallet) | `APP_CATALOG_RPC`/`APP_CATALOG_RPCS` constants (`site/js/core/config.js:184-192`: publicnode, drpc, 1rpc, mainnet.base.org), read loop `site/js/core/chain.js:265-305` | **no proof seam in the current site source** (CORRECTED: the current site has no seam; this is not a fundamental limit) | **SRC + site release** (constants are in the bundle; publication is an ENS/IPFS release, not runtime config). Interim: point the pool at the own hosted public-rpc role (`rpc-<b32>.app.enclave.host`). That removes third parties but stays unproven. Proof-backed browser reads would need a new seam, for example in-browser proof checking (a light client / `eth_getProof` verification against a signed head). That would be a separate design task, not assessed here |
| S2 | Independent mode | browser profile `IND.rpcs` (`config.js:192`; `site/js/core/independent-chain.js` quorum) built by `scripts/network/browser-profile.mjs` (`--verify-chain` at `:192`) | the profile tool verifies the *binding* at build time; reads stay an RPC quorum | CFG (a new profile), with the README §1 rule: never list one node under two names |
| — | Wallet sends and `eth_getTransactionByHash` via `Enclave.provider` (`chain.js:622-631`) | wallet-selected | — | **excluded** (not a platform backend) |

### 1e. Custody

| # | consumer | config name | verifier | required change |
|---|---|---|---|---|
| K1 | Custody v2 custodian (measured) | `MEASURED_RPCS` (`custody/v2/build-config.mjs:25`, copied at `:51`, `minAgree: 3`); `custody/v2/daemon.mjs:120`; `custody/v2/chain.mjs:165-171` (`checkRpcUrls` one-host-one-vote) | **no** | **SRC + new measurement + committee admission.** Highest-cost item |
| K2 | Custody v2 host binding / submitter | `cfg.rpcs` (default `MEASURED.rpcs`) and `cfg.rpc` (default `https://mainnet.base.org`): `custody/v2/host.mjs:30-39` | **no** | SRC (reads); the submitter send is in scope only as an own-backend send |
| K3 | Legacy v1 custodian daemon | `CUSTODY_RPCS`, `CUSTODY_MIN_AGREE` (`custody/custodian-daemon.mjs:55-103`; `custody/chain.mjs:90-101`) | **no** | SRC (`clients` injection seam at `chain.mjs:90-91`) |
| K4 | Relay custody gate / state | R2 (`:585`), R5 | see §1a | see §1a |

### 1f. Session / wallet flows

- **R6** (sessions relayer) and **R2** at `:585`/`:619` are platform-side. See §1a; SRC is required.
- `relay/auth.js:302` SIWE and `relay/secrets.js:177` owner-signature checks use **R3** (ERC-1271/6492 calls through the
  public pool). SRC is required for proof-backed verification.
- Network-host owner signatures: `P network/enclave-network-host.mjs:81-87` build raw `clients` from `cfg.chain.rpc`.
  With `authenticated` they use the `leaseReader`. Whether the provider `clients` are still constructed and used under a
  verifier LeaseReader was **not fully traced** [unverified]. A comment at `:83` claims no provider clients exist under
  'verifier'.
- Wallet-selected RPC: excluded.

### 1g. Registration

| consumer | status |
|---|---|
| Metal0 gsup register/setProofKey | covered by the staged control (`ENCLAVE_CHAIN_AUTHORITY=verifier`, txBackend `10.0.2.2:28545`; README §3). Not re-audited |
| Windows owner registration | W3 (P, CFG) |
| Relay-sponsored host registration (paymaster/bundler) | **R7, SRC**. If hosts register through the sponsor, this is still public-RPC simulation + send |
| `registryProofKey` (relay attestation path) | R2 at `:2473`, **SRC** |

### 1h. Already covered by the staged changes (not re-audited, listed for completeness)

- Metal0 control CVM (relay mode, `chainVerifier` host config): C, CFG. See `route-stage/README.md` §3.
- Host-services runner policy/carriers/index: `examples/host-services-runner.policy-verifier.fragment.json`.
- Lease relay: `lease-relay-source` work. `route-stage/LEASE-RELAY-VERIFIER-MIGRATION.md` says SRC is required. The live
  relay is the remote `https://134.209.248.172` [root-live]; its RPC configuration is [unverified].
- Privacy-agent LeaseReader: `...cfg.chain` (`P privacy-agent.mjs:340`) accepts `chainAuthority`/`chainVerifier`
  through `network/lease-reader.mjs:92-105` `chainAuthorityOptions` (CFG). The live agent uses the three public hosts
  [root-live]. The **host-services gate is not covered** (§0.4).
- Native control: `NATIVE_CONTROL_RPCS` or `chainAuthority` (`C network/native-control-routes.mjs:67-70,248`). CFG on C.
- Platform host policy: `ENCLAVE_PLATFORM_HOST_POLICY_RPCS` or verifier (`network/platform-host-policy-config.mjs:28-36`,
  both trees). CFG.
- Address book: `C addressbook.js:54-71` (verifier snapshot, else `BASE_RPC` fallback). CFG.

## 2. Priority blockers (missing code), highest first

1. **Relay `chain()`/`BASE_RPC` single client (R2)**, plus the sponsor (R7) that shares `BASE_RPC`.
   - Why it ranks first: it is one third-party provider deciding placement, custody/session gating and `registryProofKey`.
   - Smallest fix: when R1's verifier authority is selected, build `chain()` as C's `createChainAuthority(...).client`
     (`network/chain-authority.mjs:113-130`). Refuse `BASE_RPC` together with the verifier, as `:2695` already does for
     the address book.
   - The writes (sponsor `handleOps`, placement) need `actionGate({submit:true})` and the own txBackend.
2. **The C/P lineage merge** (§0.1). Without it no single deployable tree has the relay, DNS, native-control and Windows
   seams together. This is a bounded merge plus a re-run of both trees' verifier tests.
3. **Custody v2 measured RPC list (K1).** Needs SRC, a measurement and admission. Schedule it separately; it cannot ride
   this cutover.
4. **Relay `rpcPool` (R3), catalog (R4), custody-state (R5), sessions relayer (R6).** Each needs reader plumbing.
   - R4/R5 already have the agreement/`clients` seams, so they can take one verified-snapshot reader.
   - The payment indexer (`indexer.js:60`) and any `getLogs` use are **history, not state**.
   - **CORRECTED 2026-10-25 (root review):** C's `network/chain-authority.mjs` does verify logs. `METHODS.eth_getLogs`
     routes to the verifier and checks each returned log against its block's receipts. That proves **inclusion only**:
     a log the sources leave out cannot be detected, so **completeness is NOT proven**, and callers must treat
     `getLogs` results as hints.
   - So an indexer under this authority gets proven-included logs, not a complete history. Its correctness then relies
     on proven state (balances, nonces, contract reads) wherever completeness matters. This remains open per consumer.
   - (P's Windows `verified-read-client.mjs` is different: it sends logs to `ENCLAVE_CHAIN_TX_RPCS` unproven; see W2.)
5. **dns-relay fleet `BASE_RPC` (D3).**
6. **Privacy-agent host-services gate** (route-source uncommitted work; no result file). Needed only for the full
   host-services integration.
7. **Windows unproven receipts/logs via `ENCLAVE_CHAIN_TX_RPCS` (W2).** Acceptable only if `TX_RPCS` is the own node.
   Otherwise port C's receipt-root check.
8. **Site pool (S1).** The current site source has no proof seam (CORRECTED: not impossible, just missing). The near-term
   option is a site release pointing at the own role. Proof-backed browser reads would need a new seam.

## 3. What I did NOT verify

- Any live env of the relay, DNS relay, custodian, Windows boxes or the remote lease relay. Only Metal0's whitelisted
  fields come from root.
- The contents of the relay/DNS verifier test files, and route-stage `r4-*` test outputs.
- Whether the route-dns package and `platform-api.bundle.mjs` exercise `createFleet` with `BASE_RPC` in production.
- Whether `enclave-network-host.mjs:81` provider `clients` are reachable under a verifier LeaseReader.
- The uncommitted route-source agent-authority diff (not read).
