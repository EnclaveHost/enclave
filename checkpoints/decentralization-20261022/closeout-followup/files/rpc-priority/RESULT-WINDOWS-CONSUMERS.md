# rpc-priority: lifecycle composition and Windows consumer wiring

Written 2026-10-23T07:39Z (UTC clock). Worker: rpc-priority. Tree: `rpc-priority/repo`, branch `rpc-priority`.

Scope: source and tests only. No live systems, SSH, wallets, pushes, Wine, toolchains, full sync, or writes to other workers' trees. C's tree was read only through `git archive`. Every build and test ran through `work/claude-test-queue.py` at 1024 or 1408 MiB.

**This is not RPC independence.** Closing the read path on the Windows node does not provide:
* independent transaction inclusion (P/E);
* a fresh witness supply or L1 (the holder work);
* the 43 CLI/MCP `QuorumChain` references or other raw reads;
* custody transactions.

All of these remain explicit gaps (§6). No native Windows Helios build or deployment is claimed; that remains a separate bounded runtime gate. Every Windows test here runs Node on Linux (a non-native boundary), and the stateful chain is a test-signed reth `--dev` chain, not real Base.

## 1. Commits and patches

On `71448f63b` (the reviewed native/relay round), in order. Author and committer are SteveDeFacto; nothing is pushed.

| Commit | Content | Patch |
|---|---|---|
| `b56a469969c301c37f1553df2d5902c64bcd1af4` | B `62feb3aaf` applied unchanged: whole-operation deadline, callback included; client closed | `0010` |
| `f3443e537fc51c9428980db91c983ae00f4296eb` | B `8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346` unchanged: referenced deadline timer | `0011` |
| `25c051a9532c4ac85275f566b99affb3852a14a9` | root `fd6a1762ed1218d5d32fb43df2ccb97caa2b17e4` unchanged: verified-chain terminal snapshots; adds root's `ROOT-REVIEW.md` | `0012` |
| `e820e2405af91010c18913acf4740f651618c644` | LeaseReader terminal metadata (§2) | `0013` |
| `df8fbafae081321f3c9a9c774e41007200913f32` | Windows consumer wiring (§3) | `0014` |

Patches:
* `rpc-priority/patches/enclave/0010-0014` are standalone; `0001-0009` and their published sums are untouched. Sums are appended to `patches/SHA256SUMS`:

  | Patch | sha256 |
  |---|---|
  | `0010` | `ae0ce729…69c39c` |
  | `0011` | `66a5f838…76241` |
  | `0012` | `868b8fd2…7dcc1` |
  | `0013` | `cfec95d2…066ff` |
  | `0014` | `9400cca0…a9d01` |

  Every sum verifies.
* `git am` of `0001-0014` onto a clean `dfe020abf` reproduces `df8fbafae`'s tree `3acae5433be9ba92a439c025dd36434fb3d21846`.
* The inputs exported from B's and root's immutable commits are in `rpc-priority/compose-patches/0001-0003`:

  | Input | sha256 |
  |---|---|
  | `0001` | `f52b36d9…ba265cf` |
  | `0002` | `fd72b802…b50595d38cbd0` |
  | `0003` | `490fa264…78759316` |

  The composed `network/lease-reader.mjs` and its test are blob-identical to B's `8d110101f` (`92d7126a…`, `4c92a00b…`). The composed `network/verified-chain.mjs` and root's lifecycle test are blob-identical to root's `fd6a1762e` (`e55f0359…`, `f1d0b20d…`). There were no conflicts.

Composition aid for C's tree: `patches/windows-on-0757085e/windows-consumers-src.diff` (sha256 `e28f10d6c788941d1b1d7d4d11f2a10555be5a3ef6f6d1539c0a9beffd7a3bbe`, README `f5829dea…`).
* It is the final Windows source change re-applied onto C's immutable `0757085e` `windows/node` files: fuzz and offset only, no rejects.
* Every `windows/node/*.mjs` passes `node --check`, and C's own changes are kept: the `chain.mjs` send gate (live `3e9fae` lineage) and the `agent.mjs` lease-readiness / wallet-channel / host-services lines.
* Live `host.mjs` `ea0f6b` is C's base here. The diff touches only the `#startupAuthority` reader lines in it.
* It is not tested as a running C tree.

## 2. Composition of the lifecycle fixes (done first)

* **B's whole-operation deadline:** one referenced deadline over the whole verified LeaseReader operation, callback included. After it settles, every request is refused and HTTP is aborted.
* **Root's terminal snapshot (verified-chain):**
  * a late final header cannot move the accepted floor;
  * a retained client refuses even metadata methods after closure;
  * a callback failure aborts pending HTTP.
* **The LeaseReader equivalent:** B's reader already re-checks the deadline before committing the floor (`op.assertOpen()`), and already aborts on settlement. Its pinned client's metadata methods (`getChainId`, `getBlockNumber`) still answered after closure, the case root fixed in verified-chain. Commit `e820e2405` makes them refuse once the operation settles, for both `agreed` and `readAt`. Neither verifier implementation regresses to 921d.

Evidence (job `compose-r1`, frozen worktree at `e820e2405`, offline):

| Suite | Result |
|---|---|
| verified-chain | 9/9 |
| root's verified-chain-lifecycle | 3/3 |
| B's lease-reader-verifier-deadline | 11/11 |
| new lease-reader-terminal-snapshot | 2/2 |
| lease-reader-verifier | 9/9 |
| lease-reader | 31/31 |
| caller-verifier-wiring | 5/5 |
| native-relay-chain-authority | 8/8 |
| lease-reader-verifier E2E (canonical reth + Helios) | 7/7 (1 Anvil-only skip) |
| policy-verifier E2E | 8/8 (peak 854 MiB) |

**Control:** the new file run on `25c051a95` (B + root, without `e820`) fails exactly the retained-metadata case. Its late-header case passes there, because B's reader already guarded it.

## 3. Windows consumers wired (commit `df8fbafae`)

* **Shared authority:** `network/verified-read-client.mjs` is exported through the shipped admission bundle (`network/host-admission-node.mjs` → `windows/node/host-admission.bundle.mjs`) together with `LeaseReader` and `chainAuthorityFromEnv`.
  * `chainVerifierFromEnv` validates the pair: loopback only, and a verifier without the authority, a remote URL or an unknown authority throws.
  * `verifiedStateReader` is the shared LeaseReader under authority `verifier`.
  * `verifiedSnapshot` runs fn at one verified block.
  * `verifiedStateClient` answers single state reads (readContract, getCode, getBytecode, getStorageAt, getBalance, getBlockNumber, getChainId) and refuses everything else by name.
  * `transactionRpcsFromEnv` reads `ENCLAVE_CHAIN_TX_RPCS`.
  * There is no second quorum implementation.
* **Startup validation:** `windows/node/chain.mjs` validates the authority when it loads. Because `agent.mjs` imports it statically, a bad value stops the node before anything runs (tested by spawning `agent.mjs`).
* **Status:** the agent logs the chain authority and its tier at start. `chainAuthority()` reports `local-verifier`/`unsafe` with the transaction-transport state, or `provider-fallback` (the honest name for the legacy viem fallback).

### Per-read audit of the generic client (`chain.mjs`) and its callers

| Read or operation | Legacy (unchanged) | Under `ENCLAVE_CHAIN_AUTHORITY=verifier` |
|---|---|---|
| `resolveAddresses` (book `all()`; pins bypass) | provider fallback | one verified read; admin book migration followed (E2E) |
| `readEnclave`, `readDeployment`, `claimableBy`, `earnedOf`, `unprovenSec`, `operatorBalance`, `catalogSchemaRev` | provider fallback | one verified read each |
| `allDeployments` (count + `getPage`s) | provider fallback, page by page | count and **every page at ONE verified block** (own 120 s whole-operation budget) |
| `resolveAppRef` (version + catalog schema + config CID) | provider fallback | **one verified block** |
| checkpoints (`checkpoint`, `checkpointBatch`) | anchor = parent of latest; plan via provider | anchor = the **verified block** and its proof-checked hash; plan reads at that block; the send uses the transaction transport |
| audit jobs (`host.mjs` → `chain.publicClient()`) | provider fallback | verified state client (readContract only) |
| session API (`agent.mjs` → `session-api-auth.mjs`) | provider fallback, 5 s per-read cache | **snapshot mode**: factory, session and owner at one verified block per request, uncached; custody or delegation per refusal in a snapshot. Terminated session refused on the next request (E2E) |
| owner-committed Shield startup (`host.mjs`), ownership CLI (`host-onchain.mjs`), check-endpoint (`host-identity.mjs`, the installer's ownership check) | `quorumReader` over RPCs | `chain-reader.mjs` → shared verifier-mode LeaseReader; **no public client constructed** (rpcClients never called) |
| host admission + host-service gate (bundle `hostAdmissionFromEnv`, `createHostServiceGate`) | RPC quorum | env-driven since 921d/437d; **now actually shipped** in the rebuilt bundle |
| network (privacy) agent lease/registry reads | `chain.rpc` list | enrollment writes `chain: {addressBook, authority:'verifier', verifier}` (no RPC list); a switch either way restarts the agent once |
| pending nonce, simulation, gas and fee estimates, broadcast and receipts (`send`, `estimate`), payout logs (`payoutDeclarations`, `blockNumber`), `txInput`, sponsored user operation (agent `sponsorRegister`), owner CLI `simulateContract`/`waitForTransactionReceipt`/`sendTransaction`, wallet transports | provider fallback | **only `ENCLAVE_CHAIN_TX_RPCS`** (untrusted for state). Unset: each refuses by name (`<method>: … no transaction/history transport (set ENCLAVE_CHAIN_TX_RPCS); the public RPC defaults are never used instead`). `BASE_RPCS` is never used |
| `rpcUrls()` (agent config, identity) | `BASE_RPCS` | `[]`, so no provider is reported as a read source |

Default legacy mode keeps its existing semantics. In the regression run, 90 of the 93 existing files pass; the 3 that fail, fail identically on the baseline (§4).

## 4. Tests

All runs were offline, inside `unshare -r -n`.

**`test/windows-chain-authority.test.mjs`: 9/9** (job `win-r2`). It loads the real modules; `chain.mjs` runs in child processes through `test/helpers/windows-chain-driver.mjs`. Loopback stand-ins count requests. Cases:
1. **Legacy control:** the default uses `BASE_RPCS` and never the verifier.
2. **Verifier mode:** all seven state operations ask only the verifier, and its refusals stay refusals. A transaction method on the state client is refused by name. Transaction and history work refuses without a transport. `BASE_RPCS` gets **0** requests.
3. **With `ENCLAVE_CHAIN_TX_RPCS`:** nonce and logs go only to that transport; `BASE_RPCS` and the verifier get 0.
4. **Startup refusal:** ambiguous, remote, missing or malformed settings stop the chain module, and `agent.mjs` itself exits non-zero.
5. **`chainReader`:** returns the verifier LeaseReader with no clients, and never validates or uses the RPC list. The legacy path still builds its quorum.
6. **check-endpoint CLI process:** refused through the verifier, with 0 requests to its `--rpc` list.
7. **Enrollment:** writes the verifier chain section. On an existing box, legacy → verifier → legacy restarts the agent exactly once each way; an unchanged verifier changes nothing.
8. **Session snapshot mode:** revocation is seen on the very next request, nothing is read outside snapshots, and legacy caching is unchanged.
9. **Shipped deploy-files closure:** it carries `chain-reader.mjs` and the rebuilt bundle, not the shared module as a loose file. A staged copy of the closure loads the verifier authority and refuses with 0 provider requests.

**`test/windows-verifier.e2e.test.mjs`: 5/5** (job `win-r2`, peak 710 MiB). It uses the canonical reth `--dev` rig and the patched Helios `cc962e2b…`; the head is test-signed. Every Windows consumer runs as a child process with a counting `BASE_RPCS` that stays at **0**. Cases:
1. Coherent paged enumeration (one page per row) equals the ledger `count()`. The deployment owner, the registry row (operator, endpoint) and the catalog version (`cid`, `version`) equal direct chain reads. Transaction methods refuse.
2. **Admin AddressBook migration** is followed by `resolveAddresses` through the verifier; an outsider's `set` reverts.
3. check-endpoint through `chainReader` reports ours, taken and free correctly.
4. **Session revocation:** a real SessionVault session verifies through the verifier; after the owner `terminate`s it, the next request is refused with `session_ended`.
5. Tampered witnesses, missing witnesses and a stale head (>90 s) refuse readEnclave, allDeployments and check-endpoint.

The first run (`win-r1`) had two faults, both fixed and rerun in `win-r2`:
* **A readability bug:** a refusing viem transport surfaced only "An unknown RPC error occurred". The transaction client now refuses by name.
* **A test bug:** `readDeployment` was called without `resolveAddresses`.

**Windows regression** (job `win-r1`; same bundle, `chain.mjs` before that last change, which affects only verifier mode without a transport). 93 existing files, 611 tests: **603 pass, 6 fail, 2 skipped.** The failures are 3 files that fail identically on `win-base` (`e820e2405`, before the Windows changes):
* registry-reconcile 1/2;
* windows-node-hv-attach-relay 0/4 (the known missing relay bundle);
* windows-release-journal 6/7.

The set covers:
* all `test/windows-*.test.mjs`;
* host-contract-pins, session-api-auth, session-authority-pins;
* host-admission-runtime and -retry;
* registry-reconcile, offchain-heartbeat-writers;
* lease-pinned-relay, lease-designated-relays.

**Final regression at `df8fbafae`** (job `final-r1`, frozen worktree, relay runtime bundle built from source for the run):

| Suite | Result |
|---|---|
| management-plane | 39/39 |
| management-move-unit | 3/3 |
| private-app-frontends | 9/9 |
| native-relay-chain-authority | 8/8 (relay bundle now includes `chain-reader.mjs` via `host-identity.mjs`) |
| shield-dns-challenge | 15/15 |
| relay-chain-sources | 3/3 |
| mcp-guest-bundle | 2/2 |
| rpc-identity-common | 4/4 |

## 5. Required release copies and integration

| Copy | Content | Action |
|---|---|---|
| `windows/node/host-admission.bundle.mjs` | now also exports LeaseReader, chainAuthorityFromEnv, verified-read-client | **Candidate** rebuilt from this tree with `scripts/build-host-admission.mjs`'s exact options, sha256 `28778491ccd6f56bd7a5a823408692e9229b73ae6a91835bbbe26549e234611a` (was `40e8ba71…`). F/root must rebuild it from the final composed `network/` tree; it embeds this lineage's network code. The metal `host-policy.bundle.mjs` was deliberately not rebuilt |
| Windows node files (deploy-files closure, installer stage bundle) | `chain.mjs`, `chain-reader.mjs` (new), `agent.mjs`, `host.mjs`, `host-identity.mjs`, `host-onchain.mjs`, `session-api-auth.mjs`, `network-enroll.mjs`, `node-config.example.cmd` | Re-stage after composing onto C/F's host-services tree (`windows-on-0757085e` aid). Then the Windows release train: new `latest.json`, not done here |
| Linux supervisor image (Dockerfile COPYs `session-api-auth.mjs` and the admission bundle) | additive; default behavior unchanged | Rebuild only to carry the bundle |
| Relay runtime bundle (`relay/build-network.mjs`) | bundles `host-identity.mjs` → `chain-reader.mjs` | Rebuild at the relay rebuild already listed in RESULT-NATIVE-RELAY-CLOSURE §4 |
| `metal/guest/mcp-server.bundle.mjs` | embeds `session-api-auth.mjs` | Rebuild at the MCP bundle rebuild already listed |

Activation on a Windows host (root-owned; nothing done here):
1. Run a local verifier on the host's loopback. No native Windows Helios build exists; that is a separate gate.
2. Set `ENCLAVE_CHAIN_AUTHORITY=verifier` and `ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:<port>/` in `node-config.local.cmd`. Updates never write that file, and `node-config.cmd` calls it last.
3. Optionally set an explicit `ENCLAVE_CHAIN_TX_RPCS`. Without it, operator transactions refuse, including registration, price changes, operator-paid claim/renew/release, checkpoints and withdrawals. App-funded lease sends use their own lease-gas configuration (below).
4. Restart the node. The next enrollment pass restarts the network agent with the verifier chain section.

**Rollback:** remove the two lines and restart. The legacy default returns, and the next enrollment pass restores the agent's RPC list.

## 6. Gaps (explicit)

* **Installer flag:** `install-host.ps1` has no `-ChainVerifier` parameter.
  * Reasons: no PowerShell is available to test it; C's version differs by 317 lines in that region; and a flag written into the regenerated `node-config.cmd` would silently disappear on a re-run without it.
  * The entry point is `node-config.local.cmd`, validated by the node at start and by enrollment.
  * The installer's install-time `check-endpoint` honours the authority only if the PowerShell session's environment carries it.
* **App-funded lease sends:** `windows/node/lease-gas-runtime.bundle.mjs` has its own relay plus quorum configuration (`LEASE_GAS_*`) for sponsored claim/renew/release and receipt checks. It is a transaction/inclusion path and is unchanged.
* **Privacy agent owner signatures:** contract-wallet (ERC-1271) owner signatures verify through `createNetworkHost`'s `clients` built from `chain.rpc`. In verifier mode there are no clients and the Windows agent config has no `authorityPins`, so contract-wallet owner signatures refuse (fail closed). EOA signatures are unaffected. Fix: carry `authorityPins` into the agent's chain section so `verifyOwnerSignature` uses the verifier reader.
* **History/transaction methods without a transport refuse:** payout declarations (logs), `txInput`, nonce, simulation, estimates, receipts and broadcast. The verifier does not serve them, and no proof-backed receipt/inclusion interface exists yet (P/E). An existing self-hosted full RPC could serve as an explicit `ENCLAVE_CHAIN_TX_RPCS` transport, but its answers are untrusted for state.
* **Session coherence:** verify() and a following refusal() are separate snapshots (monotonic blocks), not one.
* **Unchanged from earlier rounds:**
  * the 43 CLI/MCP `QuorumChain` references and transactions;
  * custody; raw lease executor; owner nomination; `relay/lease-generation.mjs`;
  * native control `quorumRegistry`; api-relay `BASE_RPC` reads;
  * browser `site/*`;
  * fresh witness supply and L1;
  * a native Windows Helios build.

## 7. Artifacts

* Jobs: `rpc-priority/jobs/compose-r1`, `win-r1`, `win-diag-r1`, `win-r2`, `final-r1` (`.sh`/`.out`). The `win-bundle-r1` job was stopped before it started and is superseded by `win-r1`.
* Temporary worktrees `compose-wt`, `compose-control`, `win-base` and `final-wt` are removed after this report. `baseline-0c43` remains.
* The scratch C-file copy is `rpc-priority/c-0757-check` (git-archive extract, own throwaway repo).
