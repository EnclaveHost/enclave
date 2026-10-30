# Combined native derivation (`derivation-client-stage/combined-r1`): merged, frozen, ready for root's ONE build (nothing compiled yet)

**Stage:** `SHA256SUMS` **69160868712324190a95e06cef91dd30526c7afe79896838ca8d1dae2bc32da1**.
- r3 and r4 still verify and were not edited. No heavy build was launched, and there was no network/SSH/commit.

| File | sha256 |
|---|---|
| `src/zk-utils/examples/derivation_harness_combined.rs` | faa14271… |
| `src/zk-witness/examples/witness_fetch.rs` | 69812507… (= `derivation-witness-stage`) |
| `jobs/build-test.sh` | 2c0da529… |
| `runner/runner.py` | fc3ee2de… |
| `runner/test_runner.py` | 0aa325c9… |

## What was merged

**From `derivation-witness-stage` v2:**
- Witness Local keys are **stripped**, never trusted.
- A JSON or rkyv witness is accepted.
- The executed safe-head header from the pipeline tip must reproduce the verified output root (`keccak(0³²‖stateRoot‖withdrawalsRoot‖hash)`) and the claimed number.

**From r4 (6554926f), the same contract:**
- the required caller-authorized `intermediateBlockInterval`, injected as `INTERMEDIATE_BLOCK_INTERVAL_KEY` (upstream `BootInfo::load` refuses without it);
- `accept()` binds the interval, and the committed `intermediateRoots` must be non-empty whole roots **ending at the claim** (r4's `intermediate_roots_end_at_claim`, verbatim);
- identical field names and encodings.

**Defect r4 still carries (fixed only here):** r4 refuses any witness containing a Local key. Upstream's `PreimageWitnessCollector` records the boot Local keys, so **r4 would refuse every real upstream witness**.

## Stable result contract for the KVM chat provider: `enclave-base-derivation-result/v2` (exit 0 only after every check)

```
{ format: "enclave-base-derivation-result/v2", chainId: 8453,
  l1Head, l1HeadNumber,                       // = the caller's in-domain light-client finalized input (echoed, bound in BootInfoStruct)
  agreedL2OutputRoot, l2PreBlockNumber,       // agreed root (caller) and the block it names
  l2OutputRoot, l2BlockNumber,                // derived + executed; == caller's claimed root AND number (upstream run + accept)
  base: { number, hash, stateRoot, messagePasserStorageRoot, timestamp, outputRoot },   // executed header; outputRoot = keccak(0‖stateRoot‖mp‖hash)
  rollupConfigHash, scheduleId,               // == caller's authenticated pins
  intermediateBlockInterval, intermediateRoots: "0x<32-byte roots…>",   // == caller interval; roots end at the claim
  bootInfoAbi, bootInfoKeccak }               // abi(BootInfoStruct)
refusal: { format, refused: "<reason>" }, exit 1
```

- **v2 vs r4's v1:** v2 is r4's v1 fields plus `base{}`. All hashes are lowercase `0x`+64 hex, and `base.timestamp` is in seconds.
- **For lifecycle `readAnchor`:** `base = {number, hash, stateRoot, outputRoot, timestamp}` from v2. `l1 = {number: l1HeadNumber, hash: l1Head, timestamp: <from the SAME in-domain light-client record that supplied l1Head>}`.
- **Required bridge change (50cf's stage; not edited by me):** `derivation-schedule-auth-stage/integration-r2/bridge.mjs` accepts only `format === …/v1` and labels the Base hash/stateRoot/timestamp "unauthenticated". To consume v2 it must:
  - accept `…/v2`;
  - require `base.number == l2BlockNumber` and `base.outputRoot == l2OutputRoot`;
  - recompute `outputRootV0(base.stateRoot, base.messagePasserStorageRoot, base.hash) == l2OutputRoot`.

## Host metadata cannot replace accepted-domain inputs (audit)

**Only the caller's `trusted.json` supplies:**
- chain 8453;
- L1 head and number;
- agreed root;
- claimed root and number;
- interval;
- rollup config (only its contract-backed activations, committed by `scheduleId`);
- expected config hash and schedule ID.

Every one of these is re-bound in `accept()` or `bind_head()`.

**From the witness/host:**
- **Local keys** are stripped before the caller's are injected, and the caller's cannot be overwritten (test).
- **GlobalGeneric, Precompile and Blob-in-store keys** refuse.
- **Keccak/sha256 preimages** are hash-checked; **blobs** are KZG-checked; a **missing key** aborts (a refusal).
- **The fetcher's** `outputAtBlock`, rollup config and L1-head estimate are never inputs. The runner passes the caller's L1 head to the fetcher. The node's root is only the claim that execution must reproduce.

## Root build: ONE command, persistent, reuses r3's dependency key without touching r3

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
pgrep -a -x cargo; pgrep -a -x rustc        # nothing
jobs/q-exit-status.sh claude-combined-native-1 1536 unshare -rnm bash derivation-client-stage/combined-r1/jobs/build-test.sh all
```

**Integrity checks:** combined `SHA256SUMS`, tarball 9784e20a, Cargo.lock f122da76, rustup 1.96.0, `-j1 --frozen --offline`.

**Dependency reuse:**
1. **Once**, under a **shared read-only lock** on r3's `.lock`, the job reflink-copies `r3/build/deps-43698236e9186750` into `combined-r1/build/`. It refuses while r3/r4's build holds the lock.
2. It then **bind-mounts the copy over r3's path inside its private mount namespace** (`unshare -rnm`), so absolute paths and cargo fingerprints are identical and compiled dependencies are reused.
3. All writes land in the copy; **r3 on disk is never written**.

**Steps, logged to `combined-r1/logs/run-*/`:**
1. `cargo test -p base-proof-zk-utils --example derivation_harness_combined`;
2. if it passes, `cargo build` of the same example;
3. if that passes, `cargo build -p base-proof-zk-witness --example witness_fetch`;
4. Cargo.lock byte check, then the sha256 of both binaries.

**Ordering:** if root builds r4 in r3's dir first, run this afterwards to inherit its compiled dependencies.

**Expected tests: exactly 9 `#[test]` functions:**
- `trusted_input_is_strict` (now also: interval missing or 0 refuses);
- `untrusted_witness_locals_are_stripped_and_other_unhashable_keys_refuse`;
- `executed_head_must_reproduce_the_verified_output_root_and_number`;
- `json_witness_shape_is_strict`;
- `corrupt_keccak_preimage_is_refused_by_the_reused_check`;
- `truncated_or_garbage_witness_is_refused`;
- `empty_witness_refuses_but_proves_nothing_about_execution` (explicitly not execution evidence);
- `result_must_bind_every_trusted_input` (9 mutations, incl. interval, empty roots, roots not ending at the claim);
- `injected_local_keys_cannot_be_overwritten_with_other_values` (also: the interval is injected from the caller).

A PASS means `9 passed; 0 failed`. r4's two native-only tests are not included:
- `compiled_mainnet_config_hash_is_the_source_pin`;
- `bridge_schedule_keys_are_the_upstream_serde_keys_in_contract_order`.

## Tested vs prepared

| Item | Status |
|---|---|
| **Runner logic** (`combined-r1/runner/test_runner.py`) | **TESTED 8/8 OK.** Via queue `claude-combined-runner-tests-1` (512 MiB, `unshare -Urn`, rc 0). Covers pins, gates, the L1-head source, the unauthenticated anchor, public endpoints, trusted assembly incl. **the required interval that must divide the range**, and mutation targeting (no blob → NOT TESTED, never PASS) |
| **Combined harness / `witness_fetch`** | **Never compiled.** Root's single build is the first compile |
| **Runner `measure`/`negatives`** | Not run (needs the binaries, Base ready, and pinned authenticated inputs) |

**Runner details:**
- **Interval:** per size n, `intermediateBlockInterval = n`. The fetcher gets the same value. Replay succeeds only if the result is v2, the interval is n, and the single root equals the claim.
- **Negatives:** wrong root, wrong number, **wrong interval**, foreign L1 head, missing preimage, hash-bad preimage, KZG-bad blob.

**Not production-ready:** no in-domain L1 client, no SNP integration, no anti-rollback storage, and the bridge does not yet accept v2.
