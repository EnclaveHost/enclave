# derivation-witness-stage (PREPARED; only runner/test_runner.py was run; nothing built; no node contacted)

- `overlay/zk-utils/examples/derivation_harness_v2.rs`: v2 of the frozen r3 harness.
  - Strips the Local boot keys a real upstream witness records. r3 refused every real witness.
  - Binds the executed safe-head header to the verified output root.
  - Outputs `base {number, hash, stateRoot, messagePasserStorageRoot, timestamp, outputRoot}`.
  - Reads rkyv or serde-JSON witnesses.
- `overlay/zk-witness/examples/witness_fetch.rs`: the upstream `base-proof-zk-witness` host capture (`OPSuccinctDataFetcher` → `SuccinctHost::fetch/run`), against OUR loopback L1 EL, L1 beacon, Base EL and Base node only, writing the witness as JSON.
- `runner/runner.py`: `gate` / `measure` (1 → 30 → 1800 blocks from the authenticated original ASR anchor, bounded, stops at the first failure) / `negatives` (real mutations of the fetched size-1 witness and of the trusted input). `runner/test_runner.py` tests the runner's own logic only.

## Root build recipe (does NOT touch r3's frozen sources or its build cache)

1. Make a NEW build dir with a reflink copy of r3's dependency key dir: `cp -a --reflink=auto derivation-client-stage/r3/build/deps-43698236e9186750 <new>/deps-copy`. Only after r3's own build has finished; root owns that build.
2. Copy the two overlay examples into `<new>/deps-copy/base/crates/proof/zk/{utils,witness}/examples/`.
3. Run with the same env as r3 (`CARGO_HOME`/`CARGO_TARGET_DIR` = the copy, toolchain 1.96.0, `-j1`, `--frozen --offline`, queue 1536):
   - `cargo test -p base-proof-zk-utils --example derivation_harness_v2`
   - `cargo build -p base-proof-zk-utils --example derivation_harness_v2`
   - `cargo build -p base-proof-zk-witness --example witness_fetch`
4. Check Cargo.lock is byte-identical, then record the two binaries' sha256.

**Unverified compile risks:** `tokio` `rt` feature unification for `witness_fetch`; the serde JSON field names of `PreimageStore`/`BlobData`.

## Root run (after the build, with our Base and L1 ready; network = our loopback nodes only)

`run.json` contents:
- `harness`, `fetch`: `{path, sha256}`;
- `anchor`: `{path, sha256}`, the authenticated original ASR anchor record (`finality: l1-finalized-asr-anchor`, `base{number, outputRoot, hash, stateRoot, messagePasserStorageRoot}`);
- `l1Head`: `{path, sha256}`, `{number, hash, timestamp, source: "in-domain-light-client"}`;
- `schedule`: `{path, sha256}`, `{rollupConfig, expectedRollupConfigHash, expectedScheduleId}`, authenticated pins;
- `endpoints`: `{l1Rpc, l1Beacon, l2Rpc, l2Node}`, all `http://127.0.0.1:<port>`;
- `sizes`: `[1, 30, 1800]`;
- `outDir`.

Commands (no `unshare -n`: the nodes are reached over loopback):
```
jobs/q-exit-status.sh claude-derivation-witness-gate 256  python3 -I derivation-witness-stage/runner/runner.py gate --config <run.json>
jobs/q-exit-status.sh claude-derivation-witness-meas 1536 python3 -I derivation-witness-stage/runner/runner.py measure --config <run.json>
jobs/q-exit-status.sh claude-derivation-witness-neg  1536 python3 -I derivation-witness-stage/runner/runner.py negatives --config <run.json>
```
A host run is a MEASUREMENT, not in-domain authority.
