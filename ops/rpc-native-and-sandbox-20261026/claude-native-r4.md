# Native derivation r4 + bridge integration-r2: the intermediateBlockInterval blocker fixed in source; JS PASS 14/14; native r4 NOT built (root)

**New stages** (frozen; r3, the reader and integration-r1 were verified unchanged):

| Stage | `SHA256SUMS` | Files |
|---|---|---|
| `derivation-client-stage/r4/` | `5edb7031fd7da798b21b4eeae410e9753414e7d6ec788279b627839fc8d4bdd8` | `src/examples/derivation_harness.rs` `6554926fa633df37af48909ee9f0b94b1878dc4f725ba6861ad85d5fc330d709`; `jobs/build-test.sh` `f9457d34b8e17c14846598dbc0afda585deb39ccebdc60f2d4ca942a478380c4` |
| `derivation-schedule-auth-stage/integration-r2/` | listed in its own `SHA256SUMS` | `bridge.mjs`, `test/bridge.test.mjs`, `README.md` |

**Not done:** no native build was launched, no `cargo`/`rustc` was running at check time, and there was no network, SSH, production change or commit.

## The blocker and the fix (upstream base `5476069f`)

- **Upstream requirement:** `proof/src/boot.rs` `BootInfo::load` **requires** `INTERMEDIATE_BLOCK_INTERVAL_KEY` (9): 8 big-endian bytes, non-zero (`MissingIntermediateBlockInterval`/`ZeroIntermediateBlockInterval`).
- **Why r3 always refused:** r3 injected 7 Local keys without it, and refuses Local keys from the witness. So every real run refused at boot.
- **r4 harness changes:**
  - `TRUSTED_KEYS` has **10** entries; `intermediateBlockInterval` is a JSON u64 parsed into `NonZeroU64` (missing, 0, negative, fractional, string, null or ≥ 2^64 refuses);
  - it is injected as `INTERMEDIATE_BLOCK_INTERVAL_KEY` from the **trusted input only**; a witness Local key is still refused;
  - `accept()` binds `intermediateBlockInterval` and requires `intermediateRoots` to be whole, non-empty 32-byte roots **ending at the claimed root**;
  - `result_json` reports `intermediateBlockInterval` and `intermediateRoots`.
- **Upstream semantics:** `IntermediateRootSampler` (`proof/src/intermediate_roots.rs`) keeps every `interval`-th block's root, and requires (claim − agreed) to be a **non-zero multiple** (`EmptyRange`/`PartialInterval`).
- **Commitment effects:**
  - **Committed:** `BootInfoStruct` commits the interval and the concatenated roots into `bootInfoAbi`/`bootInfoKeccak`.
  - **Not committed:** the interval is not in the on-chain proposal journal.
  - **Aggregation:** upstream aggregation requires equal intervals across ranges.
  - **Scope:** it changes which roots are committed, never the derived chain.
- **Authority:** the interval is the proven game's parameter, so it is **caller-authorized** and never host-chosen.

## Native tests for root (12 = r3's 7 + 5 new, in `r4/src/examples/derivation_harness.rs`)

| Test | Checks |
|---|---|
| `interval_is_a_required_non_zero_u64` | missing, 0, -1, 1.5, "10", null and 2^64 refuse; u64::MAX accepted |
| `interval_is_injected_only_from_the_trusted_input_never_from_the_witness` | — |
| `result_binds_the_interval_and_roots_ending_at_the_claim` | — |
| **`compiled_mainnet_config_hash_is_the_source_pin`** | `hash_rollup_config(base_common_chains::rollup_config!(8453))` == `0x1607709d…3c57`, also after a serde JSON round trip. This turns the pin candidate into a native check once it runs |
| **`bridge_schedule_keys_are_the_upstream_serde_keys_in_contract_order`** | from the compiled MAINNET serialization, setting the bridge's 15 keys gives exactly `activation_timestamp(CONTRACT_VARIANTS[i])`, and removing them gives `None` (Never) |

## JS bridge (`integration-r2`): ACTUAL PASS

- **Required inputs:** `buildTrustedInput` adds the required, caller-authorized `intermediateBlockInterval` (a safe integer ≥ 1, refused otherwise) and `agreedL2BlockNumber`.
- **Pre-run refusals:** an empty range and a non-dividing range.
- **Native-result binding:** `acceptNativeResult(result, input)` also binds the interval, `l2PreBlockNumber` == agreed, and the roots (count = range/interval, last = claim, lowercase whole roots).
- **Test receipt:** `bash jobs/q-exit-status.sh claude-schedule-integration-r2-tests 512 unshare -Urn /usr/bin/env -i PATH=/usr/bin:/bin ANCHOR_DEPS_ROOT=<work>/source /usr/bin/node --test derivation-schedule-auth-stage/integration-r2/test/bridge.test.mjs` → `logs/claude-schedule-integration-r2-tests.out`/`.rc`: **`# tests 14` `# pass 14` `# fail 0` `# skipped 0`, rc 0**, queue 512 MiB, host floor 16384 MiB.
- **Coverage:**
  - wrong, missing or invalid interval; non-dividing and empty ranges;
  - interval, pre-block and roots mismatches in the native result;
  - plus everything from r1: anchor or claim mismatch, forged reader result, config hash mismatch, omitted/wrong schedule, wrong chain, reader sha.
- **Earlier syntax errors:** a pre-queue syntax check caught one more `await`-in-arrow error in the r2 test file; it was fixed before queuing, and no failed queue run resulted this time. r1's earlier failed attempt stays recorded in `logs/claude-schedule-integration.md`.

## Root build command (r4; root runs it, after confirming no `cargo`/`rustc` is running)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
pgrep -a -x cargo; pgrep -a -x rustc                     # must print nothing
jobs/q-exit-status.sh claude-derivation-client-r4-1 1536 unshare -rn bash derivation-client-stage/r4/jobs/build-test.sh build
```
(`… build-test.sh metadata` first, if wanted.)

**What the job does:**
- **Integrity:** verifies the `SHA256SUMS` of r3 and r4, the tarball `9784e20a…`, Cargo.lock `f122da76…`, and rustup 1.96.0. It refuses while any `cargo`/`rustc` runs.
- **Reuse:** uses r3's **persistent** `r3/build/deps-43698236e9186750` (key = tarball + lock + toolchain, unchanged) under its `flock`. It replaces only `crates/proof/zk/utils/examples/derivation_harness.rs` in that build tree (the previous sha is logged); r3's frozen inputs are never written.
- **Settings:** `--frozen --offline -j1`.
- **Pass rule:** test-rc 0 **and** exactly `12 passed; 0 failed` **and** build-rc 0, printed as `## derivation-client-r4 build … count=ok`. Logs go under `r4/logs/`.

## Real blockers (not papered over)

1. **The native harness has never compiled.** r1/r2 failed (rc 101, a `chrono` resolution failure); the r3 build has no rc. If `r3/build/deps-*` is incomplete, the r4 build compiles the dependencies from scratch at `-j1` (hours). Compile errors in r4's new tests are possible until root's run.
2. **Who supplies the interval:** the caller must provide the proven game's real interval and the agreed root's block number from its accepted chain. The bridge only enforces the format and the sampler rules.
3. **Unchanged from earlier reports:**
   - no live in-domain Helios binding for the reader (and the Helios historical-verification question);
   - no witness producer, in progress elsewhere (6d24, derivation-witness-stage);
   - **no lifecycle `readAnchor` provider.** The bridge output is labelled `notAProvider`: the Base header hash, stateRoot, timestamp and the L1 timestamp are unauthenticated, and there is no runtime or journal.
4. **Config hash:** `0x1607709d…` is confirmed only once root's r4 test `compiled_mainnet_config_hash_is_the_source_pin` passes, and later by a native run's own `rollupConfigHash`.
