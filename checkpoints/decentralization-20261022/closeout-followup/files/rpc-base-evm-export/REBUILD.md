# Base EVM work (rpc-priority, worker A): how to rebuild it from this checkpoint

**What this is:** source plus offline/recorded fixtures only. It is not a deployment and not RPC independence. Root owns
integration and production. See `INVENTORY.json` → `label` for the exact proven and unproven scope.

All pins below are checked by `INVENTORY.json` (commit and tree ids, blob ids, sha256). `REPRODUCE-CHECK.txt` records
that every commit tree was rebuilt exactly from these patches; the checker is
`source-preservation/verify-base-evm-export.py`.

## 1. Enclave candidate `9fdc1418c` (branch `rpc-priority`, NOT merged into the normal tree)

1. Start from the public base `dfe020abf1794bedc42943e43fe85eb02593dd8d` (EnclaveHost/enclave branch
   `candidate/decentralized-control-20261022`).
2. Run `git am enclave-rpc-priority-9fdc1418c/patches/*.patch`. This gives four commits, tree
   `5c84c3da6c3142d5fe0742e6ac6f516d84926062`.
3. `files/` holds the 8 authored files at `9fdc1418c`, verbatim.

The changes add only new files: `network/op-head-relay.mjs`, `network/witness-gateway.mjs`, the test fixture helper and
5 tests. `package.json` is unchanged, so `npm ci` at the base supplies the dependencies.

## 2. Patched Helios `eeffcc9` (branch `enclave-base-evm`; compat branch `enclave-base-compat` = `0a02256`)

1. Clone upstream `https://github.com/a16z/helios` at tag `0.12.0` (`2af9b41887e069144ee56cd710f3ddca195473f8`).
2. Run `git am helios-enclave-base-evm-eeffcc9/patches/*.patch`. These four patches leave out one binary test object.
3. Restore that object from the hex fixture already in this checkpoint, then commit it into the last commit (or
   `git add` it):
   `xxd -r -p <checkpoint>/closeout-followup/files/rpc-peer-audit/head-listener/crates/enclave-base-head-listener/tests/fixtures/base-mainnet-52965074.v4.snappy.hex > opstack/tests/data/ec197b9f01acd9b93c900014b5b16142183fc77b559e0e0a727687d171e3e467.v4.snappy`
   The result must be sha256 `ec197b9f…e467` (the file name). The final tree is
   `2171ad2bfd3c97f2e0e029e866b1a8535cbbd187`.
4. Fetch the path dependency, base/base v1.5.1 (MIT), at
   `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42`. Put it at `../vendor-inspect/base-v1.5.1` relative to the Helios checkout:
   `git clone --depth 1 --branch v1.5.1 https://github.com/base/base ../vendor-inspect/base-v1.5.1` (verify `HEAD`).
   This is what `opstack/Cargo.toml` names; the checkout used was unmodified.
5. Dependencies: everything else is pinned by the preserved `Cargo.lock`. Packages come from crates.io (version and
   checksum), plus Helios's own git patch `ethereum_hashing` at rev `7ee70944…`. Base pins and deviations are listed in
   `RESULT-BASE-EVM.md` §2: revm 42.0.1, alloy-evm 0.38.0 and alloy-primitives 1.6.1 match base's lock; the alloy family
   is at 2.5.0 where base pins 2.4.1.
6. Toolchain: Rust **1.96.0** (`RUSTUP_TOOLCHAIN=1.96.0`; upstream's `rust-toolchain.toml` says 1.94.0).
7. Build and test with the recipe in `rpc-priority/jobs/base-evm-build-test-r4.sh`:
   - debug profile, `CARGO_PROFILE_DEV_DEBUG=0`, one job, single-threaded link;
   - it needed ~1.2 GiB peak, so it ran in the 1536 MiB queue lane;
   - it runs `cargo test -p helios-opstack --lib`, then builds `helios-cli` and `opstack-server`.
   Release builds (fat LTO) are untested.

## 3. Offline tests and the real-mainnet fixture

- `rpc-priority/fixtures/base-calls-20261023T014412Z/` is block 52965249, with `fixture.json` and 49 block-hash-pinned
  witness entries.
  - It is public chain state only.
  - The head commitment is signed by a TEST key, `"5e" x 32` in `fixture-tools/record-base-calls.mjs`.
  - It is used by `test/helios-base-replay.e2e.test.mjs` with `BASE_FIXTURE_DIR`. The recipe is
    `jobs/base-replay-r1.sh <fixture dir>` (run as r2).
- `jobs/base-final-tests-r2.sh` runs the helios-witness E2E. It needs `anvil`, plus the compat build and the stock
  0.12.0 release binary (sha256 `a7f777b4…`, upstream release) for its comparisons.
- `jobs/base-head-e2e-r2.sh` runs the head E2E. It needs worker B's 52 real gossip objects (`BASE_HEADS_DIR`).
  - Those objects are listed by content hash in `INVENTORY.json` → `baseHeadsReferencedNotCopied`; the raw binaries
    are deliberately not duplicated here.
- All offline suites run inside `unshare -r -n` and assert that the network is unreachable.
- Recording a new fixture (live, read-only public RPC) uses `fixture-tools/record-base-calls.mjs` (job
  `base-record-r3.sh`). Lifting the Denim horizon needs a Denim-era recording and replay first.
