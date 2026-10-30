# Remaining public-RPC consumers: bounded source audit + ONE scoped candidate (NOT run, NOT deployed, NO cutover)

**Scope and constraints**
- **Stage:** new `consumer-remaining-stage/` only.
- **Sources read (read-only):**
  - `relay-consumer-source` HEAD `e78a764d1`, via `git show`. The worktree was not touched (it has 2 uncommitted paths
    belonging to another worker);
  - `enclave-apps` `50f93d7` (`mobile-shell`);
  - `consumer-cutover-plan-2205` and `logs/claude-consumer-cutover-refresh-result.md` (live inventory 22:05–22:20 UTC).
- **Not done:** no queue, tests, native compile, SSH or live network; no edits to other trees; no commit; no contract
  changes.
- **Unchanged:** custody v2 verifier mode still correctly REFUSES, pending the canonical-hash fix.

**Two different properties, kept apart**
- **Endpoint / censorship resistance:** which servers are contacted, and whether a third party can withhold answers.
  Pointing a consumer at our own node or at an own hosted RPC role removes third-party endpoints, but proves nothing.
- **Proof / finality:** whether an answer is checked against chain data. The local verifier (`network/chain-authority.mjs`)
  proves state, receipts and log inclusion against its sequencer-signed **unsafe** head. It has **no L1 finality**, and
  `eth_getLogs` proves inclusion, never completeness.
- **Not attested:** an ordinary host helper or own node is not "attested". Only measured releases with attestation gates
  are.

## 1. Inventory: remaining public-RPC defaults / mandatory callers (runtime paths first)

### API relay process (`relay/api-relay.js`): already on the tested verifier seam (R1–R8, partial)

| path:line | current | under `ENCLAVE_CHAIN_AUTHORITY=verifier` | state |
|---|---|---|---|
| `relay/api-relay.js:325` | `BASE_RPC` default `https://mainnet.base.org` | `relayChainAuthority` (`:326-331`); `chain()` uses `RELAY_CHAIN.client` (`:585`); `BASE_RPC` set alongside it is refused (`relay/relay-chain-env.mjs` `RELAY_VERIFIER_CONFLICTS`) | seam tested (prior round). The legacy default remains when the verifier is unset |
| `relay/store.js:127,131-133` | `BASE_RPC` + `RPC_FALLBACKS` pool (publicnode, drpc, 1rpc, mainnet.base.org) | the authority client; conflicts refused | seam tested |
| `relay/sessions.mjs:382` | `rpc: [publicnode, mainnet.base.org]` | refused unless `SESSIONS_RPC` is unset and the network is base (`:1229-1235`); the authority is used | seam tested |
| `relay/mcp.js:76-78` | `RPCS` = `BASE_RPC` + 4 public | `useMcpChainClient(RELAY_CHAIN.client)` (`api-relay.js:334`) | seam tested in the relay. **The measured guest's own MCP bundle keeps the public list** (`mcp.js:79-81` comment); not addressed |
| `relay/chain-sources.mjs:9,14-17` | `DEFAULT_NETWORK_CHAIN_RPCS` (publicnode, tenderly, nodies, drpc), 2-agree quorum | `networkReaderOptions` returns the verifier options; the RPC list is dropped | seam present. **Gap:** `NETWORK_CHAIN_RPCS` set together with the verifier is silently ignored, not refused (it is not in `RELAY_VERIFIER_CONFLICTS`). Recommendation only; not changed, because `relay-chain-env.mjs` has a copy in `metal/guest/measured-control.mjs` owned by another worker |
| `relay/api-relay.js:249` | sponsor `rpc: BASE_RPC, authority: RELAY_CHAIN` | the authority | seam tested (codeless refusal) |
| storage writer fencing | — | refused (`writer_authority_unproven`) | **not provided** by the relay under the verifier (prior §2 BLOCKER) |

### DNS relay / data-plane fleet (`relay/dns-relay.js` + `relay/fleet.mjs`): **NO verifier wiring**. Candidate below

| path:line (base `e78a764d1`) | current | proposed |
|---|---|---|
| `relay/fleet.mjs:38,58` | `baseRpc` default `https://mainnet.base.org` (`BASE_RPC` env) | unchanged (legacy default) |
| `relay/fleet.mjs:225` (runner resolver), `:523` (registry/book reader) | `createPublicClient(http(cfg.baseRpc))`, **always**; `readContract` only (`addr`, `registrySchema`, `count`, `getPage`, ledger) | use `cfg.chainClient` when injected, never `baseRpc` then; otherwise the legacy client |
| `relay/dns-relay.js:84` | `CFG = fleetConfig()`; app-challenge reads already have a verifier option (`:113-119` `chainAuthorityFromEnv`), the fleet does not | `relayChainAuthority(process.env)`: unset gives null (legacy); verifier sets `CFG.chainClient = rc.client`; a mixed or invalid selection (e.g. `BASE_RPC` set) is **fatal at startup** |

The verifier implements every method the fleet uses (`eth_call`). Any other fleet consumer (`relay.js`, `udp-relay`,
`tcp6-relay` per the `fleet.mjs` comments) is **not in this repo**, and the change does not touch it.

### Browser site / dashboard (`site/`): public pool in the shipped bundle; **no proof seam**. No code candidate

| path:line | current | classification / proposal |
|---|---|---|
| `site/js/core/config.js:184,192` | `APP_CATALOG_RPC` publicnode; `APP_CATALOG_RPCS` = publicnode, drpc, 1rpc, mainnet.base.org (hosted mode); independent mode uses the profile's `IND.rpcs` | catalog, ledger and dashboard reads (`site/js/core/chain.js:277-305` `baseRpc` rotation). **No proof seam in the browser.** Interim **endpoint-only** option: a site release whose pool is the own hosted RPC role. That removes third parties but stays unproven. A proof-backed browser would need a new in-browser light-client/proof seam (separate design). **Needs a site release** (ENS/IPFS), not runtime config |
| `site/js/core/wallet.js:28-31` | `fallbackRead()` posts to `https://mainnet.base.org` in hosted mode when the wallet cannot answer | the same pool question. Could route through `baseRpc()` (the pool), which is still public. Not changed |
| `site/js/core/wallet.js:34-36,130` | `addChainRpcs` / WalletConnect `rpcMap` = mainnet.base.org | **wallet-provider configuration for user signing. EXCLUDED** (it must not be removed; the user's wallet chooses) |
| `site/index.html:52`, `develop.html:40`, `apps.html:41` | `<link rel=preconnect href=https://mainnet.base.org>` | a connection hint only. Remove with the pool change |
| `site/credit/credit-config.json:21-24` + `site/credit/credit.js:26-36` | credit-vault quorum reader over 4 public RPCs (quorum 2, confirmations 2), with a localStorage override | the same browser limitation: endpoint-only replacement via config/release; no proof seam |
| `sdk/sessions/src/constants.ts:73,80` (and `dist/`) | publicnode defaults | SDK for third parties: a documentation/default question, not a platform runtime |

### Mobile (`enclave-apps/mobile-shell` `50f93d7`)
- `grep` for RPC hosts or JSON-RPC methods: **0 hits**. `configure.mjs:66` points at `apiBase: https://api.enclave.host`;
  the shell wraps web origins.
- **Its chain reads are the site's and the API relay's paths above.** There is no separate mobile RPC default to replace;
  the mobile releases follow the site release and the API relay deployment.

### Bootstrap
- **`network/cold-bootstrap.mjs:52-73`:** an explicit `chainAuthority === 'verifier'` path already exists. The index and
  policy are read through the verifier; otherwise the caller's peer quorum is used. There are no public defaults in the
  module.
- **`network/bootstrap-gateway.mjs`:** no RPC host or RPC field in source (grep: 0). The live config has no RPC fields
  (refresh §1). Its chain needs come from its callers' configuration. **No candidate.** Which peers the deployed release
  passes is a deployment question; the live `enclave-retained/cc96aad` code defaults were not audited.

### Out of the requested categories (listed, not changed)
- `cli/enclave.mjs:67-68` (operator CLI);
- `windows/node/host-onchain.mjs:39`, `host-identity.mjs:35-36`, `chain.mjs:38`, `network-enroll.mjs:47` (Windows host
  side, public defaults);
- `relay/mcp.js:403` (documentation text);
- custody v2 `custody/v2/host.mjs` public default (custody stage).

## 2. Candidate (stage only; NOT run): `consumer-remaining-stage/`

- **Base:** `base/relay/{fleet.mjs,dns-relay.js}`, from `relay-consumer-source` `e78a764d1`.
- **Candidate:** `src/relay/fleet.mjs`, `src/relay/dns-relay.js` and the new `src/test/relay-fleet-chain-authority.test.mjs`.
- **Patch:** `consumer-remaining.patch`, 3 files; sha256 `6f5ae99e…` (full hashes in `MANIFEST.sha256`).
  - `src/relay/fleet.mjs` `3f6d7900…`
  - `src/relay/dns-relay.js` `d775a7bd…`
  - test `87f125e7…`
- **The change:** one `chainClient()` helper in `createFleet`, whose two existing client constructions now call it. In
  `dns-relay.js`, a 3-line selection through the existing `relayChainAuthority` (exported by `relay/network-runtime.mjs:6`
  and so by the bundle).
- **Default behaviour unchanged:** the same `BASE_RPC` client is used when nothing is selected.
- **Tests (offline, fetch spy; written, NOT RUN):**
  1. With the authority injected, all registry reads go to it, and no provider URL is requested.
  2. An authority outage leaves an empty fleet, with no fallback to `BASE_RPC`.
  3. Legacy default: without injection, `mainnet.base.org` is requested, as before.
  4. Selection: unset gives null; verifier + `BASE_RPC` is refused; a public URL as the verifier is refused.

  These are endpoint-selection tests. Proof and finality belong to the verifier and are covered by
  `test/chain-authority.test.mjs` and `test/relay-chain-authority.test.mjs`.
- **Root to run** (pure, queue 256, foreground; in a full private `git archive e78a764d1` tree with the 3 files overlaid,
  `node_modules` symlinked, and `lo` up if under `unshare -rn`):
  `node --test --test-concurrency=1 test/relay-fleet-chain-authority.test.mjs test/fleet.test.mjs test/relay-chain-authority.test.mjs`.
  - **Acceptance:** 0 failed, 0 skipped; the existing `fleet.test.mjs` passes unchanged.

**Compile and runtime risks (honest):**
- The fake `readContract` returns decoded rows directly, so viem ABI decoding is not exercised.
- `refresh()` swallowing the outage relies on the existing catch.
- `dns-relay.js` itself is not started by any test.

## 3. Deployment prerequisites (none met by this work; no cutover claimed)

1. **The own Base node:** download finished; the A2–A4 bootstrap and bytecode gate (`OPEN_GAPS`) closed; the local
   verifier qualified on it.
2. **DNS relay:**
   - root review and test of this candidate;
   - rebuild `relay/network-runtime.bundle.mjs` (generated; it must export `relayChainAuthority`);
   - deploy with `ENCLAVE_CHAIN_AUTHORITY=verifier`, a loopback `ENCLAVE_CHAIN_VERIFIER`, and `BASE_RPC` /
     `RPC_FALLBACKS` / `SESSIONS_RPC` / `CUSTODY_*` unset;
   - check the startup log, then the zero-connection check against the public hosts, then stop the verifier and confirm
     it fails closed (refresh §4).
3. **API relay:** locate the live host first (refresh: **not located**; units inactive on `nan`). Accept the partial scope:
   writer fencing is not provided. Consider refusing `NETWORK_CHAIN_RPCS` alongside the verifier (§1 gap) in a
   coordinated change with the measured-control copy.
4. **Site, dashboard, credit page, mobile:**
   - a site release decision: an endpoint-only own RPC role in the pool (unproven, still an RPC), or a new proof seam
     (design task);
   - an ENS/IPFS publication;
   - mobile follows the site;
   - wallet-provider `rpcMap` / `addChainRpcs` stay (user signing).
5. **Bootstrap:** audit the deployed `enclave-retained/cc96aad` callers' peers and choose `chainAuthority: 'verifier'`
   where the caller has a local verifier.
6. **Not covered by any of this:** custody v2 (refused), the measured guest MCP list, Windows host defaults, and other
   fleet daemons outside this repo.
