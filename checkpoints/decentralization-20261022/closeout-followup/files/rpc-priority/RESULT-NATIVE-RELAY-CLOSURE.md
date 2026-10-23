# rpc-priority: native issuer, relay and launch-boundary closure

Written 2026-10-23T05:39Z (UTC clock). Worker: rpc-priority. Tree: `rpc-priority/repo`, branch `rpc-priority`.

Scope: source and tests only. No live systems, SSH, wallets, pushes, toolchains, full sync, or writes to other workers' trees. Every test ran through `work/claude-test-queue.py` at 1024 or 1408 MiB.

No bundle or package was rebuilt and committed. The runtime bundle the tests use is generated per run from this source and then deleted (§4).

**This does not make Enclave RPC-independent.** Configuring a reader with the local verifier is not RPC independence. Still required:
* the 43 CLI/MCP `QuorumChain` references and other raw reads;
* every transaction path;
* custody;
* a fresh witness supply for the verifier.

All of these remain explicit gaps (§6).

## 1. Commits and patches

| Commit | Content |
|---|---|
| `71448f63ba189b1f61153e7df766f9421b350205` | This round (14 files, +422/−36), on `2efc4a83e`. SteveDeFacto author and committer, not pushed. |

Earlier, unchanged and still available for publication:
* `437d6ced6` and `2efc4a83e`, with `RESULT-CONSUMER-CLOSURE.md`;
* `921d60c2b` and `0c43e4db8`, with `RESULT-CONSUMERS.md`.

Patches:
* `patches/enclave/0009-Carry-the-explicit-local-verifier-through-the-relay-.patch`, sha256 `58b0ab390ab1eabbc0beeab9299b664226171cd1b46e3084e22700b9321699fc`.
* It is generated standalone on `2efc4a83e`, so the existing `0001-0008` files and their published sums are untouched.
* `patches/SHA256SUMS` has the 0009 line appended, and every sum verifies.
* Applying `0001-0009` with `git am` to a clean `dfe020abf` reproduces HEAD's tree `593c7c49e90bc82d809ceefc9dd6eb05f73806e5`.

**Not composed:** `network/lease-reader.mjs` is untouched, so B's final whole-operation deadline (`62feb3aaf`, `8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346`) composes textually.
* None of this round's tests depends on that deadline: every refusal case is an immediate refusal, not a hung callback.
* Therefore nothing here claims that the 921d LeaseReader bounds a hung callback.
* The runtime processes tested here use 921d's verifier-mode LeaseReader. Root should rerun this round's process tests after composing B's fix.

## 2. Launch boundaries closed (each one filters or rebuilds a child's configuration)

The explicit authority means `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER=<loopback URL>`, or the equivalent config keys. The provider quorum stays the default at every boundary below. In every verifier case no provider client is constructed, so a verifier refusal stays a refusal.

| Boundary | Before | Now |
|---|---|---|
| Measured guest `platformApi.relayEnv` (`metal/guest/measured-control.mjs`) | Any non-secret name was accepted unvalidated, so a bad pair failed only at the first read | The pair is validated at bind time. The authority must be `verifier` or `quorum`; the verifier must be a loopback http(s) URL and requires the `verifier` authority. A bad pair refuses the config |
| Relay child env (`metal/guest/platform-api-role.mjs`) | `relayEnvBase + relayEnv + sealed credentials`: a credential named `ENCLAVE_CHAIN_*` could override the bound value, so the relay and the issuer could disagree | New `relayChildEnv` (the function `startRelay` spawns with) pins `CHAIN_AUTHORITY_ENV` to exactly the bound value, the same rule as `NATIVE_CA_*`. A credential can neither set nor change it |
| Native issuer host policy (`issuerDeps`, `policyEnv = relayEnvBase + relayEnv`) | Carried the names, but unvalidated | The same validated bound pair. `resolveHostPolicyConfig` then gives the runtime the verifier snapshot, and the issuer and relay child agree by construction |
| api-relay network LeaseReader (`relay/api-relay.js`, `relay/chain-sources.mjs networkReaderOptions`) | Always `NETWORK_CHAIN_RPCS` or the default four providers | Verifier mode passes no RPC list. The relay stops (`fatal: network chain authority: …`) on any of: <br>• a verifier with no `ADDRESS_BOOK_ADDRESS`, since its lease and registry reads would otherwise go to `BASE_RPC`; <br>• a remote URL; <br>• a verifier without the authority; <br>• a runtime bundle whose LeaseReader lacks the verifier authority (the stale-bundle guard). <br>The startup log states the authority and tier |
| dns-relay app-zone LeaseReader (`APP_CHALLENGE_*`) | `APP_CHALLENGE_RPCS` only | `chainAuthorityFromEnv` plus the same stale-bundle guard. `APP_CHALLENGE_RPCS` is unused in verifier mode. The log line states the authority |
| dns-relay Shield host-identity registry reader (`*_SHIELD_RPCS`, `shieldRegistryInputs`) | Windows `quorumReader` | In verifier mode it uses a verifier-mode `LeaseReader` (same `agreed(fn)` interface). The callback uses only `getCode`/`readContract`, both served by the pinned client. Otherwise it is unchanged |
| Runtime bundle (`relay/network-runtime.mjs`) | — | Now also exports `chainAuthorityFromEnv` and `networkReaderOptions` |
| Challenge replica (`network/challenge-replica-host.mjs`; it builds its dns-relay child's COMPLETE env from scratch) | No chain-authority keys, and `ENCLAVE_CHAIN_*` never reached the child | Top-level `chainAuthority`/`chainVerifier` (validated by `chainVerifierOf`) reach three places: <br>• the dns-relay child env (both roles); <br>• the host-policy gate env (`hostPolicyGateEnv`); <br>• the runner's carrier shape (`policyCarrierFetch`). <br>`chain.rpcs` and `shield.rpcs` are optional only in verifier mode. A verifier that no chain read would use (owner responder without Shield, policy off) is refused |
| Host-services `directory-replica` role (`network/host-services/roles.mjs`) | The role filter refused the keys `directory-server` already reads | The keys pass into the role config file, with `rpc` optional only in verifier mode. `directory-server` logs its reader's authority |
| `scripts/network/native-profile.mjs` | The tool's own reader ignored a profile's authority; nothing emitted it | `--chain-verifier` (or the input profile's pair) drives its own lease reads and is written into the emitted profile. A remote URL is refused before any I/O, and a conflict with the input pair is refused |

Audited and needing no change:
* **host-services runner children:** they get `baseEnv() + launch.env`. The `route-dns` role runs read-only with no chain reads (no host policy or `APP_CHALLENGE` in that mode). `policy-mirror` already carries the keys in its config file (437d).
* **lease-relay host child:** it gets an explicit `plan.env`. Its chain use is the relay's `LEASE_RELAY_RPCS` quorum plus transaction sponsoring, which is a transaction path and stays a gap.
* **host-service gate in-process env:** this is the runner's `policyEnv` (437d).

The unsafe-tier distinction is kept. Every new log line and the existing `status()`/`authorityInfo()` report `local-verifier (unsafe tier …)` versus `provider-quorum (provider-reported tier)`.

Admin, owner and platform rules are unchanged code. Only the source of the chain snapshot differs.

## 3. Tests and negative controls

All runs were offline, inside `unshare -r -n`.

New `test/native-relay-chain-authority.test.mjs` (**8/8**, job `native-relay-r3`; the r2 run's three failures were test errors, fixed and rerun). It drives real entry points, not source text: `relay/build-network.mjs` builds the runtime bundle from this source into a flat relay directory, and the real api-relay, dns-relay and directory-server processes start from it. A stand-in verifier records every method it is asked and refuses each one.
1. **Measured config:** the valid pair is carried; the quorum default is unchanged.
   * Refused: a remote URL, a verifier without an authority, a verifier with `quorum`, an unknown authority.
2. **`relayChildEnv`:** the bound pair wins over credential values; a credential-only pair never reaches the relay; `NATIVE_CA_*` is still removed.
3. **Real `issuerDeps().decideHost`** with the bound verifier:
   * no admission, and the refusal says why;
   * the verifier was asked; **the policy's RPC stand-in was asked 0 times**; no policy document was fetched.
   * **Control:** in quorum mode the RPC stand-in is asked, and the verifier is never asked.
4. **api-relay processes:**
   * the quorum log line by default; the `local-verifier (unsafe tier …)` line in verifier mode;
   * **exit 1** for each of: verifier without an address book, a remote URL, a verifier without the authority.
5. **Challenge-replica config:**
   * the pair reaches the gate env, the runner shape and `resolveHostPolicyConfig(...).config.chainAuthority`;
   * the app-zone child env has the pair and an empty `APP_CHALLENGE_RPCS`;
   * the owner responder with Shield gets the pair and an empty `ATTESTED_SHIELD_RPCS`;
   * refused: remote, ambiguous, missing verifier, missing rpcs in quorum mode, unused verifier.
6. **dns-relay process started from that config's child env:**
   * it logs `local-verifier`, and its forced first ledger sync asked the stand-in verifier and reported the refusal;
   * **control:** the default config logs `provider-quorum` and never asks the verifier;
   * a remote verifier exits 1 (`fatal: APP_CHALLENGE_AUTH`).
7. **`directory-replica` role:** the role's own config file starts the real directory-server process, which logs `local-verifier`. Quorum logs `provider-quorum`. Refused: remote, ambiguous, and no rpc without a verifier.
8. **`native-profile`:** the stand-in verifier is asked; the refusal stays a refusal (nothing is measured); a remote URL and a conflicting pair are refused.

**Real canonical-chain case**, added to `test/policy-verifier.e2e.test.mjs` and run alone by `--test-name-pattern` (**1/1**, job `native-relay-r3`, peak 821 MiB). It uses the reth `--dev` rig and the patched Helios `cc962e2b…`; it does not use real Base. The case:
* creates two owner deployments in the real ledger;
* starts a real dns-relay from the flat bundle directory, with the challenge replica's own config and env pointed at Helios;
* checks that `/health` reaches `ledgerIndex {complete: true, size: <ledger count()>}`, proof-backed through the verifier;
* switches to **tampered witnesses**: a fresh process reports the refusal and its index stays **incomplete**, so no push could be judged unique.

The other 7 policy E2E cases were not rerun. Their code paths are unchanged from 437d's 7/7 run.

`test/native-profile.test.mjs` has a new `verifier` scenario: the emitted profile carries the pair, and the other scenarios emit none. **9/9.**

Existing suites of every edited module, run in job `native-relay-r2` with the runtime bundle built into `relay/` for the run and removed afterwards:

| Suite | Result |
|---|---|
| relay-chain-sources | 3/3 |
| challenge-replica-host | 9/9 |
| hosted-service-placement | 5/5 |
| public-directory | 17/17 |
| platform-api-config | 5/5 |
| platform-api-forward | 6/6 (the real `startRole` relay child through `relayChildEnv`) |
| platform-api-native-issuer | 11/11 |
| app-zone-replica | 6/6 |
| dns-read-only | 4/4 |
| shield-dns-challenge | 15/15 |
| metal-measured-control | 12/13 |
| relay-network-bundle | 0/1 |

challenge-replica-host's three failures from the last round, which also failed on the baseline, pass here with the generated bundle present beside `dns-relay.js`. That run had no bundle; I infer that was the cause but did not isolate it.

The two failures are **pre-existing**. Each fails identically on the pristine baseline `0c43e4db8` in job `native-relay-r3`, which ran both trees:
* metal-measured-control `gsup legacy path` is a source-text diff about flavor-capacity comments;
* relay-network-bundle's inner `node --test test/relay-routes.test.mjs test/connectivity-chain.test.mjs` exits 1.

## 4. Release copies and the required bundle closure (none rebuilt)

Before activation, these must be rebuilt from this source, re-pinned and, where measured, re-measured. None is labelled deployed.

| Copy | Embeds | Required action |
|---|---|---|
| `relay/network-runtime.bundle.mjs` (+ manifest), generated by `relay/deploy.sh` (`node build-network.mjs`) and shipped to the API and DNS targets | `lease-reader.mjs`, `chain-sources.mjs` (`networkReaderOptions`), `chainAuthorityFromEnv` | Rebuild. api-relay and dns-relay **refuse to start** in verifier mode with an older bundle (the stale-bundle guard), and an older bundle lacking the named exports fails at import |
| Challenge replica release (`release.dir` with pinned `dnsSha256` = `dns.mjs`, `runtimeBundleSha256` = `network-runtime.bundle.mjs`) | `dns-relay.js` + runtime bundle | New release files and new pins in every challenge-replica config |
| `metal/guest/platform-api.bundle.mjs` (+ manifest; copied into the measured image by `metal/build-image.mjs`) | `platform-api-role.mjs` (`relayChildEnv`), `native-issuer.mjs`, the relay child's `api-relay.js` | Rebuild bundle, then **new image measurement** |
| `metal/guest/measured-control.mjs` (copied as a file into the image) | relayEnv validation | Part of the same new image measurement |
| `network/host-services/packages/route-dns.mjs` (+ package.json) | `dns-relay.js` + runtime | Rebuild package and new package pin |
| `network/host-services/packages/directory-replica.mjs` (+ package.json) | `directory-server.mjs` (log line) | Rebuild package. The role-filter change is in `roles.mjs`, which the runner loads from source |
| Previous rounds, still stale | `metal/guest/mcp-server.bundle.mjs`, `packages/policy-mirror.mjs`, `packages/credit-vault-submitter.mjs`, `windows/node/host-admission.bundle.mjs` | As recorded in `RESULT-CONSUMER-CLOSURE.md` §6 |

Root asked not to rebuild these before C/F's host-service lifecycle work and B's runtime are final. This list is the closure to rebuild then.

Test-only environment, untracked and not committed:
* `repo/relay/node_modules` and `baseline-0c43/relay/node_modules` are symlinks to the frozen `native-control-attested/base-eaea7e46/relay/node_modules`, mirroring how the root `node_modules` is linked.
* The flat-relay helper is `test/helpers/relay-flat.mjs`.

## 5. Windows reader inventory (read-only audit; nothing in `windows/` was edited)

Windows native reader wiring is still required. C/F's current work is carrier/lifecycle, so the readers below are **unwired** and owned by nobody in particular. Current shape:

| Reader | Where | Shape | Minimal next integration |
|---|---|---|---|
| Host admission + host-service gate | `windows/node/host.mjs:124` → `host-admission.bundle.mjs` `hostAdmissionFromEnv` / `createHostServiceGate` | **Stale bundle**: zero `verifier`/`ENCLAVE_CHAIN` occurrences. The source (`network/host-admission-node.mjs`) supports `ENCLAVE_CHAIN_*` since 921d | 1. Rebuild with `scripts/build-host-admission.mjs`. <br>2. Pass `ENCLAVE_CHAIN_AUTHORITY`/`ENCLAVE_CHAIN_VERIFIER` through `node-config.cmd` → the Node env (the example sets only `ENCLAVE_PLATFORM_HOST_POLICY`). <br>3. Run a local verifier (Windows Helios build: no toolchain or Wine here, not done) |
| `quorumReader` (its own reimplementation of `LeaseReader.agreed`, because the admission bundle does not export LeaseReader) | `windows/node/host-identity.mjs:176`; built at `host.mjs:240` (owner-committed Shield startup), `host-onchain.mjs:53` (prepare-ownership / ownership-status), `host-identity.mjs:319` (CLI) | `agreed(fn(client, blockNumber, signal))`. Callers (`shield-startup.mjs:140`, `host-ownership.mjs:75`) use `readContract`/`getCode` | Export `LeaseReader` + `chainAuthorityFromEnv` from the admission bundle. At those three construction sites use `new LeaseReader({addressBook: ZERO, ...chainAuthorityFromEnv(env)})` when the verifier is chosen, the same interface dns-relay now uses for Shield. Callers needing `signal` must tolerate its absence |
| `chain.mjs publicClient()` | `windows/node/chain.mjs:138`; used by `host.mjs` (`readDeployment` ×7, `resolveAppRef` ×4, `readEnclave`, `claimableBy`, `allDeployments`, `operatorBalance`, `resolveAddresses`, `catalogSchemaRev`, block reads for proof-of-time checkpoints, `payoutDeclarations` logs, `txInput`) and by `keys.mjs` | A viem `fallback` transport over `BASE_RPCS`: the **first answering provider, not even a quorum** | Needs a per-read audit, not a config key. Several reads need methods the pinned client lacks (logs, `getTransaction`, latest-block reads for checkpoints). Those that fit the allowlist (`readContract`/`getBlock` at a block/`getBalance`) could move to a verifier-mode reader one by one |
| Writes and transactions | `chain.mjs` wallet client (`registerBox`, `setPrices`, `setProofKey`, claim/renew/release via `leaseSend`, `checkpoint*`, `withdrawEarnings`), `host-onchain.mjs:77` | Transaction path | Out of scope: no verifier tx path exists |
| `lease-gas-runtime.bundle.mjs` | Windows lease-gas runtime | Raw reads + relay transaction sponsoring | Transaction path, same as the lease relay |
| Injected-reader modules | `shield-startup.mjs`, `host-ownership.mjs`, `session-api-auth.mjs`, `sponsor.mjs` | Take a reader | Follow whichever reader their constructor passes (above) |

## 6. Remaining gaps (explicit)

* **CLI/MCP `QuorumChain`:** 43 references. These need `eth_getLogs` session scans, receipts and nonces, and are a separate interface. They stay on the provider quorum.
* **Transactions everywhere:** `sendQuorumTx`, Windows `chain.mjs` writes, the lease relay and lease-gas sponsoring, and any api-relay sends through its `BASE_RPC` client.
* **Other api-relay reads:** its `BASE_RPC` `chain()` client (ledger rows, registry poll, book resolution) is outside the network LeaseReader and is unchanged. Only route leases and registry operators move.
* **Raw-RPC paths:**
  * lease executor;
  * owner nomination;
  * `relay/lease-generation.mjs`;
  * custody (`custody/v2`) and session factories.
* **Native control registry:** `quorumRegistry` (platform-api-verify) is used by the native issuer's measured-control verification. That registry read stays on `ownConfig.rpcs`. Only the issuer's host policy follows the bound verifier.
* **A verifier in the measured guest:** there is no Helios process in the measured image or host-service set yet. This round only makes the configuration carry and enforce the choice. Runtime composition (listener → witness gateway → Helios) is B's `rpc-runtime-composition`.
* **Windows:** see §5.
* **Browser `site/*`:** needs an in-browser verifier. No remote proxy was added.
* **Operator tools:** `scripts/*` other than native-profile, and `stage-tool.mjs`.
* **Fresh witness availability and a transaction path** are still required for any RPC-independence claim. The E2E chain is a test-signed reth `--dev` chain, not real Base.

## 7. Artifacts

* Job scripts and outputs: `rpc-priority/jobs/native-relay-r1.sh` (stopped before it started; superseded), `native-relay-r2.{sh,out}`, `native-relay-r3.{sh,out}`.
* Baseline worktree: `rpc-priority/baseline-0c43` (detached `0c43e4db8`).
