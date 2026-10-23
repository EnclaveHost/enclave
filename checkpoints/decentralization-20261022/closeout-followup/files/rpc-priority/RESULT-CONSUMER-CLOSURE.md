# rpc-priority: consumer closure (independent policy readers and caller wiring)

Written 2026-10-23T04:12Z (UTC clock). Worker: rpc-priority. Tree: `rpc-priority/repo`, branch `rpc-priority`.

Scope of this round:
* No live systems, SSH, wallets, pushes, production, full sync or NVMe hosting.
* Every test and build went through the shared queue (`jobs/q-retry.sh`), at 1024 MiB or 256 MiB.
* Nothing generated here is a deployed artifact. No bundle or package was rebuilt (§5).

**Full RPC independence is not achieved by this work.** It still needs:
* **fresh witness availability:** a live source of state proofs and signed heads for the verifier;
* **a transaction path:** broadcast, inclusion and receipts are still on providers or the sequencer.

What this round does is let the two remaining independent policy readers, and the callers that already hold a LeaseReader, take their reads from the local proof-backed verifier when an operator explicitly chooses it.

## 1. Commits and patches

| Commit | Content |
|---|---|
| `437d6ced66aae416258ba44abc175c731a396d55` | Priority 1: the service index and platform host policy read through the local verifier when chosen (15 files, +706/−47). |
| `2efc4a83ec6636f875fa4523d50674bda06bcdcb` | Priority 2: independent CLI/MCP, management and native callers can choose the local verifier (8 files + tests). |

Both commits sit on `0c43e4db8`, the round root reviewed. Author and committer are SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>. Nothing is pushed.

Patch series: `rpc-priority/patches/enclave/0001-0008` (base `dfe020abf`) and `patches/helios/0001-0004` (unchanged), all checksummed in `patches/SHA256SUMS`.
* `0007` = 437d6ced6, sha256 `c1fdc948de4abd8d18d73bb8a592b381ddb70cffabee4ce77588afcf98c9c086`.
* `0008` = 2efc4a83e, sha256 `84c0c5311c8cc426e814500fab9a0cdee77171f4202c40a7e4395484a30de9f4`.
* `0001-0006` were regenerated in the same run. Their content is identical to the previous files; only the `[PATCH n/8]` subject numbering changed, so their sums changed.
* Applying all eight to a clean `dfe020abf` worktree with `git am` reproduces HEAD's tree exactly: `88475d04f10c422d22faa97c5026e6ce65f07e24`.

## 2. Priority 1: the two independent policy readers

### Mechanism (`network/verified-chain.mjs`, new)

Each read is taken at one block from the loopback verifier (patched Helios). The block must be:
* confirmed below the verifier head;
* fresh against `maxBlockAgeMs`;
* not in the future;
* the right chain;
* monotonic against an in-memory floor;
* re-checked by header.

The callback receives a client pinned to that block hash. Only proof-backed methods exist on it: readContract, getCode/getBytecode, getStorageAt, getBalance, getBlock (that block), getChainId and getBlockNumber. Every other method refuses by name.

There is **one referenced deadline over the whole operation, callback included**. After it settles, the pinned client refuses. Failures keep the provider quorum's error classes (chain_stale, chain_future, chain_rollback, chain_reorg, chain_wrong_network, chain_timeout, chain_unconfirmed, chain_closed; status 503). So every gate keeps its existing refuse/hold semantics.

Choosing the verifier:
* It is chosen only explicitly: `chainAuthority: 'verifier'` + `chainVerifier: <loopback URL>`, or `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER`.
* A verifier without the authority, an unknown authority, or a non-loopback URL is refused at configuration.
* In verifier mode no provider client is constructed, so a refusal can never fall back to raw RPC.
* The provider quorum remains the default everywhere.

### Consumers that now use it

| Reader | Consumers routed (actual call sites) |
|---|---|
| Service index (`readServiceIndex`, new `indexAuthority`/`indexRead`) | `readServiceIndex` itself; native control candidates (`native-control-routes.mjs readControlCandidates`, env from the caller); cold discovery (`cold-bootstrap.mjs coldDiscover`: index **and** policy, skipping `rpcPeers`); policy carriers (`policy-carriers.mjs indexCarriers`); lease relay discovery (`lease-gas-runtime.mjs` → `discoverLeaseRelays` `readOptions` from env) |
| Platform host policy (`hostPolicySnapshot`, `verifiedHostSnapshot`; `createHostPolicyRuntime` follows `cfg.chainAuthority`) | Config resolution `resolveHostPolicyConfig` reads the authority from env/JSON in **every** mode (production, explicit JSON, production default by chain+book), so every runtime resolved from an env that carries `ENCLAVE_CHAIN_*` follows it: native control (`native-control-routes.mjs`), `native-host-policy.mjs` (NativeClient's `env`, default `process.env`), `host-service-gate.mjs`, `relay/api-relay.js` and `relay/dns-relay.js` HOST_POLICY (`process.env`). `metal/guest/native-issuer.mjs` gets a filtered relay env (`policyEnv`). Whether that filter passes `ENCLAVE_CHAIN_*` was **not verified**, so treat it as unwired until it is checked. Explicitly wired: the host-services runner (`policyCarrierFetch`, top-level `chainAuthority`/`chainVerifier` validated, mapped to `ENCLAVE_CHAIN_*` for children), the policy-mirror role (`roles.mjs` + `policy-mirror.mjs freshVerifier`; `rpc` optional only in verifier mode), gate carriers (`host-service-gate-carriers.mjs`), the storage-indexer registry row (`storage-indexer-host.mjs`), cold bootstrap. `status()` reports `chainAuthority` (`provider-quorum` / `local-verifier (unsafe tier)` / `injected`). |

### Preserved behaviour

* **Admin/owner controls:**
  * Policy authority still comes only from the admin AddressBook's anchors (the book is pinned, and migration follows the admin's repoint).
  * Host ownership, moderation (ban/unban by new anchor) and the carrier/mirror byte verification are unchanged code. Only the source of the chain snapshot differs.
* **Existing service lease holding:**
  * The measured gate's configured `graceMs` and its refuse/hold rules are untouched. No new grace was added.
  * The E2E proves the original grace under the verifier: serving continues within `graceMs` of the last admit, then stops.
* **Proof checking** is not weakened. All positive tests run on the canonical reth `--dev` chain (Anvil zero leaves remain refused).

## 3. Priority 2: caller configuration where the existing LeaseReader applies (commit 2efc4a83e)

| Caller | Change | What is routed |
|---|---|---|
| CLI independent mode (`cli/enclave.mjs`, `cli/independent.mjs`, `cli/independent-host.mjs`) | `--chain-verifier http://127.0.0.1:PORT/` (independent mode only; otherwise an error); `loadIndependentTrust` validates it (loopback only) → `trust.chainVerifier`; `independentReaderAuthority(trust, chain)` | the management LeaseReader (`managementClient`) and the platform host policy (`independentHostPolicy` → `verifiedHostSnapshot`). The forwarded argv carries the flag. |
| MCP independent (`mcp/independent.mjs`, `mcp/independent-tools.mjs`) | profile key `chainVerifier` → the same `loadIndependentTrust` | the management LeaseReader and the platform host policy |
| `ManagementClient` | `chainAuthority`/`chainVerifier` → `chainAuthorityOptions` | its LeaseReader |
| `NativeClient` | profile keys `chainAuthority`/`chainVerifier` → `chainAuthorityOptions` | its LeaseReader (`scripts/network/native-{request,get,ws}.mjs` construct it from the profile file, so they follow it) |

**The RPC quorum stays required in independent mode.** `--chain-verifier` replaces no other read and no transaction. A verifier refusal surfaces as an error; nothing retries on the quorum.

## 4. Still uncovered (precise)

* **CLI/MCP `QuorumChain` reads:** 43 references in cli/mcp. These cover registry host lists, ledger rows, session vaults, catalog, balances, `assertReviewedCode` and so on.
  * They are a separate snapshot interface, not LeaseReader.
  * Several need methods the verifier does not serve: `eth_getLogs` session scans (`sessionScan`), receipts, nonces.
  * Routing them needs a per-read audit, not a config key, so they stay on the provider quorum.
* **Transactions everywhere:** `sendQuorumTx`, estimateGas, receipts, `eth_sendRawTransaction`.
* **Raw-RPC paths:**
  * lease executor (`network/lease-executor-authority.mjs`, `client/lease-executor-*`);
  * owner nomination (`network/host-owner-nomination.mjs`);
  * `relay/lease-generation.mjs`;
  * custody (`custody/v2/{quorum,chain}.mjs`) and `network/session-factories.mjs`.

  These use raw `eth_call`/`eth_getBlockByNumber` or tx flows, not the LeaseReader interface. They are separate explicit gaps.
* **Native control registry:** `quorumRegistry` (metal platform-api-verify) is its own provider quorum.
* **Native issuer:** `metal/guest/native-issuer.mjs`'s host policy follows the authority only if its filtered `policyEnv` carries `ENCLAVE_CHAIN_*`. That is unverified.
* **Env-only, not consumer-tested:** the env-resolved runtimes (native-host-policy, host-service-gate, the relay HOST_POLICY) are covered by the config unit test and by the E2E's `createHostPolicyRuntime`, but each one was not run with a verifier.
* **Relay LeaseReaders:** `relay/api-relay.js networkLeaseReader` and `relay/dns-relay.js` are not wired. Their HOST_POLICY does follow the env authority (§2). Wiring the readers would be a small `chainAuthorityFromEnv` change, but it is a relay-process change outside this round's caller set.
* **Windows readers and relays:** worker C's area, untouched.
* **Browser `site/*`:** it would need an in-browser WASM verifier. A browser cannot use another machine's loopback, and a remote "verifier" response alone is not proof, so no remote proxy was added.
* **Operator tools:** `scripts/*`, `network/host-services/stage-tool.mjs` (`quorumSnapshot`) and `scripts/network/native-profile.mjs` (does not emit the new profile keys).
* **Duck-typed injected readers** in `relay/dns-challenge-shield.mjs` and the `windows/node` shield/identity/ownership readers are not tested with the verifier.

## 5. Tests

All runs are offline (`unshare -r -n`) except the policy regression list, which needs no network. Runs:

| Job | Tree | Result |
|---|---|---|
| `policy-chain-r1` (1024) | source = 437d6ced6 (every committed source file predates the run; only `test/verified-chain.test.mjs` changed after) | **policy E2E 7/7 on the canonical reth rig**: patched Helios `cc962e2b…`, reth `8cdd1f35…`, peak 800 MiB. Unit 8/9; the 9th was a test-config error, fixed before the commit. |
| `policy-unit-r2` (1024) | HEAD 2efc4a83e | 135 tests: **130 pass, 5 fail, 0 cancelled**. Covers verified-chain 9/9, caller wiring 5/5 and the host-policy, service-index, storage-indexer, lease-gas, native-control/discovery, challenge-replica, relay-policy, metal/site host-policy suites. Peak 594 MiB. |
| `caller-wiring-r1` (1024) | 437d6ced6 + Priority 2 edits | verified-chain 9/9, native-client 25/25, mcp-independent-unit 10/10, management-plane 39/39, native-policy 14/14. cli-independent (anvil rig, quorum default) 13/14. site-independent-host-policy 0/1. |
| `caller-wiring-r4` (256) | final caller test file | caller-verifier-wiring **5/5** |

The E2E (`test/policy-verifier.e2e.test.mjs`) deploys EnclaveServiceIndex, the admin AddressBook, host ownership, hosts, an admin-signed and anchored policy, ads, and local mirror/directory servers. It proves:
1. the verifier's service-index read equals the provider-quorum read of the same contract;
2. native control candidates come through the verifier;
3. host policy through the verifier: the admin policy admits, a new admin anchor bans, an outsider's anchor reverts and changes nothing;
4. cold discovery reads the index and the carrier-verified admin policy through the verifier with **no RPC**;
5. tampered or missing witnesses refuse every policy reader, and nothing is admitted;
6. a stale head refuses while the chain keeps moving;
7. the measured gate keeps its original grace.

Unit tests cover:
* future/wrong-chain/reorg/rollback/proof-failure/unreachable codes;
* the hung-callback deadline and the retained client after settlement;
* ambiguous or remote configuration refused at every entry point: policy JSON/env, runner, policy-mirror, CLI trust, MCP profile, ManagementClient, NativeClient.

**Failures, all pre-existing and environmental:**
* The 5 failures in the policy list fail identically on pristine `0c43e4db8` (`baseline-compare-r1`):
  * challenge-replica-host ×3;
  * the platform-host-policy-process packaged relay;
  * storage-indexer-host's missing release tarball.
* site-independent-host-policy: no Playwright browser is installed (`chrome-headless-shell-1232` missing). Toolchain installs are out of scope.
* cli-independent "deployed schema-4 bytecode": the local compiler output hash is `771a22d3…`, but the test expects `e81f5d51…`.
* Both of the last two fail identically on `0c43e4db8` (`caller-fail-compare-r1`).

**No E2E was rerun after 2efc4a83e.** It touches only cli/mcp/management/native-client modules, none of which the policy E2E exercises.

## 6. Dependency and build closure

* **Runtime:** no new npm dependency. `verified-chain.mjs` uses the existing viem and `rpcEndpoint`. `platform-host-policy-config.mjs` stays dependency-free (it is browser-shared), with an inline loopback check.
* **Verifier binary:** Helios `enclave-base-evm` `eeffcc9`, debug CLI sha256 `cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0`, unchanged this round.
  * Its Cargo path dependencies point at `../../vendor-inspect/base-v1.5.1` (base/base `5476069f`).
  * The integrator must place that checkout or switch to a git dependency at that commit.
* **Test-only:**
  * reth v2.8.0, binary sha256 `8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250`;
  * `fixture-tools/reth-dev-8453-genesis.json`, with `--rpc.eth-proof-window 1024` set by the rig;
  * Foundry build for the contracts.
* **Stale embedded copies: nothing activates until these are rebuilt from this source.** None was rebuilt, and none is labelled deployed.
  * `metal/guest/platform-api.bundle.mjs`: readServiceIndex, quorumSnapshot, createHostPolicyRuntime.
  * `metal/guest/mcp-server.bundle.mjs`: loadIndependentTrust, quorumSnapshot, createHostPolicyRuntime.
  * `network/host-services/packages/{policy-mirror,route-dns,credit-vault-submitter}.mjs`.
  * Any Windows bundle embedding these modules (worker C's packaging).
  * Measured images that ship these bundles need a new measurement.

## 7. Composition with worker B's deadline fix

B's `62feb3aaf` and `8d110101f` (on 921d, under final test) touch only `network/lease-reader.mjs` and `test/lease-reader-verifier-deadline.test.mjs`. This series does **not** touch `lease-reader.mjs`, so the file sets are disjoint and the series compose textually.

This series does not claim that 921d bounds the whole callback: the LeaseReader's verifier path gets that from B's fix. The new `verified-chain.mjs` has its own whole-operation, referenced deadline and closes its client. It intentionally duplicates the loopback endpoint and pinned-client logic so as not to edit B's file.

After B's fix is final, root should:
1. compose it;
2. rerun `test/lease-reader-verifier.e2e.test.mjs` on the reth rig and the caller suites above;
3. optionally have LeaseReader reuse `verified-chain.mjs`.

## 8. Artifacts

* Job scripts and outputs: `rpc-priority/jobs/{policy-unit-r1,policy-unit-r2,baseline-compare-r1,policy-chain-r1,caller-wiring-r1..r4,caller-fail-compare-r1}`.
* Baseline worktree `rpc-priority/baseline-0c43` (detached `0c43e4db8`): used for the pre-existing-failure comparisons. It can be removed with `git -C rpc-priority/repo worktree remove baseline-0c43`.
* Earlier reports: `RESULT-CONSUMERS.md`, `COVERAGE.md`/`.json`. Sections 2–4 of this document supersede COVERAGE.md for the service index, host policy and the CLI/MCP/management/native callers.
