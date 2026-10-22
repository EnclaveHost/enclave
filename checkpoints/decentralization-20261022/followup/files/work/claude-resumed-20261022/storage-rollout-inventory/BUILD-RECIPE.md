# Storage rollout: ONE build recipe for root review (rc3 host-role package + the sia-s3 C2 client). Nothing built yet.

W = /home/steven/Documents/Codex/2026-10-18/wo/work, P = $W/claude-resumed-20261022/storage-rollout-inventory.
Run every step from /home/steven/Documents/Codex/2026-10-18/wo. A queue exit of 98 means NOT STARTED: retry with a fresh log once the lane is free.

## What is built, and what is NOT

- BUILT: `enclave-storage-indexer-1.0.0-rc3.tar.zst`. It is the rc2 package (3b78d4f1) with exactly one payload change:
  - `bin/indexd` is `2c0e5b06` (c2-enclave, A1-reproducible, root-accepted) instead of `e6e812fd` (G-C2 with stock
    sizing, which the migration plan refuses for its spend).
  - The rest of the diff is metadata, documented in `rc2-to-rc3.patch` (88 lines):
    - version rc3;
    - PACKAGE.json gets the indexd version and source;
    - GeoLite2 is pinned explicitly instead of hashed at build time (same bytes `18bf1695`);
    - `build.sh` refuses unless out/c2-enclave-a == out/c2-enclave-b;
    - the package tests check the new pin and version.
  - libexec, the unit and the host.json template are byte-identical to rc2.
- NOT rebuilt:
  - indexd: the A1 bytes are copied as they are.
  - sia-s3: the artifact is `00e9cde0`, as it is.
  - The role `storage-indexer-host.mjs` 20abb681 and its host-software closure (tar 83c95b4b, manifest 658e5a44): unchanged.
- No Go, Rust or wasm build.

## Steps (all local; no network, SSH, wallet, Docker, shared PostgreSQL fixture or production)

```
P=work/claude-resumed-20261022/storage-rollout-inventory
sha256sum -c $P/PINS.sha256
# 1. build twice + compare + package tests (rc2's identical job peaked at 142 MiB)
python3 work/claude-test-queue.py --mib 512 --log $P/logs/build-1.guard.log -- \
  bash $P/build-rc3.sh b1 > $P/logs/build-1.out 2>&1; echo "exit=$?"
# expect: "package tests: 22 passed, 0 failed", "BUILD-RC3 OK b1", tarball <T>, manifestPin sha256:<M>
# 2. the REAL host-role lifecycle on the rc3 bytes. This is the existing test, unchanged: policy-world admission and
#    refusals, real PostgreSQL 18.6 from work/storage-host-role/pg18 (its own extracted runtime), real indexd 2c0e5b06:
#    init, run, schema migration, backup, admin ban/unban, crash restart, restore. The rc2 run peaked at 749 MiB.
(cd work/storage-host-role/tree && STORAGE_PACKAGE_TARBALL=$PWD/../../claude-resumed-20261022/storage-rollout-inventory/out/b1/a/enclave-storage-indexer-1.0.0-rc3.tar.zst \
  python3 ../../claude-test-queue.py --mib 1024 --log ../../claude-resumed-20261022/storage-rollout-inventory/logs/role-1.guard.log -- \
  node --test --test-concurrency=1 test/storage-indexer-host.test.mjs) > $P/logs/role-1.out 2>&1; echo "exit=$?"
# 3. activation tooling on the rc3 bytes (copy of the root-reviewed act-5/6 test; only the tarball path differs; act-6 peak 228 MiB)
STORAGE_PACKAGE_TARBALL=$PWD/$P/out/b1/a/enclave-storage-indexer-1.0.0-rc3.tar.zst \
  python3 work/claude-test-queue.py --mib 512 --log $P/logs/act-1.guard.log -- \
  node --test --test-concurrency=1 $P/tests/activation-rc3.test.mjs > $P/logs/act-1.out 2>&1; echo "exit=$?"
```

- Pass criteria:
  - step 1 exit 0, with a == b;
  - step 2 `# pass 1 / # fail 0` and db_version 28 (the test accepts >= 27);
  - step 3 `# pass 1`.
- Known flake (storage-closeout act-1/act-3): the policy-world loopback RPCs lag for the whole 60 s window. A FAIL with
  "RPC state moves behind" is a fixture flake, to be retried once with a fresh log. Any other failure is a result.
- Not duplicated:
  - the 40-check placement suite, the 124-check component validation of 00e9cde0, and the contracts and 8-stage suites;
  - the SDK repeat-r2 groups, already accepted.
  - The role, protocol and artifact bytes are unchanged.

## Optional, separate (root decides; NOT part of this recipe)

- The 00e9cde0 component validation (full4) ran against e6e812fd. The SDK interop that ran against 2c0e5b06 (repeat-r2
  and root's run) used the driver d45df48e from sia-s3 snapshot c2-4.
  - c2-4 differs from 00e9cde0's source only in client-side encryption/nonce derivation (sia_storage
    erasure_coding/object_encryption/slabs) and test-only code. Every indexd-facing file is identical
    (INPUTS-CHECK.json sourceDiffs).
  - 2c0e5b06 differs from e6e812fd only in the app API timeouts (30 s -> 5 min) and host-side contract sizing.
  - A direct 00e9cde0 x 2c0e5b06 component run would need the component harness rebuilt against c2-enclave and its own
    PostgreSQL: the existing e2e.py uses the shared fixture env, which this worker must not use. It is a new test, not
    in scope.
- copy-mode-guard.patch (b8e135d9): this would change the wasm hash, which means a Rust rebuild plus re-running the
  124-check validation. It is not proposed here.
