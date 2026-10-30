# Verifier canonical block-hash (EIP-1898 requireCanonical): native tests PASSED (root run 0000); mutants run 0006 FAILED (harness classifier defect), negative controls UNPROVEN

## Current status (actual root result, 2026-10-26 UTC)

**`root-canonical-native-build-tests-0000`: rc 0, `RESULT: PASS`, `[queue] EXIT 0`.**
- **Peak memory:** 1206 MiB tree RSS; minimum host available 22331 MiB.
- **Candidate:** the current patch `canonical-block.patch` (`41667ec9…`, `PATCHED.sha256` `7e87fad8…`), applied to a fresh
  clone of `eeffcc9` and checked with `[ok] patched files == PATCHED.sha256`.
- **Harness:** `jobs/` as published in `66bc7468a` (phase A is `cargo build … --keep-going`).
- **Setup:** every pre-check was `[ok]`. The A0 locked closure and `cargo fetch --offline --locked` passed (both
  `fetch.out` and `metadata.err` are empty), and `Cargo.lock` was unchanged at the start and the end.

**Phase results (counts are from the logs, `runs/tests-20261026T000001Z/`):**
- **A** (compile all 5 new test targets): ok.
- **B** (`b.out`): **35 passed, 0 failed, 0 ignored, 0 measured, 0 filtered**, in exactly 5 binaries. The named check
  passed (`named=0`).

  | Binary | Passed |
  | --- | --- |
  | `ancestor_block_hash` | 4 |
  | `block_cache_exact_hash` | 4 |
  | `canonical_block_gate` | 17 |
  | `node_canonical_methods` | 8 |
  | `rpc_exact_hash_postcondition` | 2 |
- **C** (`c.out`, all `helios-core` tests): **91 passed, 0 failed, 0 ignored, 0 measured, 0 filtered** over 20 summaries
  (lib unit tests 18, 18 integration binaries, doc-tests 0). Two of the summaries ran 0 tests (`execution.rs` and the
  doc-tests), but neither had anything ignored or filtered. The regression check passed (`regression=0`).
- **`helios-revm-utils` build:** ok (`revm=0`).
- **D** (Helios CLI debug build): ok (`cli=0`).

**Build warnings (not failures):** 3 unused imports in `revm-utils/src/proof_db.rs` (`BlockResponse`, `HeaderResponse`,
`ExecutionError`), and unused fixture functions in two test targets.

**Cache reuse:** the run reused, as mutable caches, the cargo-home and target of the ended run
`run/tests-20261025T234358Z` (the 2345 run): `CACHE-REUSED-FROM`, with every reuse guard `[ok]` and the cargo-home
content equal to the reviewed CH0. **This is not an independent reproduction.**

**What this is NOT:**
- **Negative controls UNPROVEN:** the mutants run `root-canonical-mutants-0006` ended with **rc 1, `[queue] EXIT 1`**.
  - **Its classifications:** M0–M12 and I2 were all `INVALID (compiler error)`; I1 and I3 `SURVIVED`.
  - **Every `--no-run` mutant build succeeded.** The INVALID labels come from a **defect in
    `jobs/check_cargo_output.py mutant`**. Its rule `^error(\[E\d+\])?:` also matches cargo's normal trailer after a
    test failure, `error: test failed, to rerun pass …`. So a mutant whose tests FAILED is labelled a compiler error.
  - **Example:** M1's output shows `canonical_block_gate` with 7 failed tests followed by that trailer.
  - **No kill is claimed or inferred from this run.** The classifier needs a fix and the mutants a rerun (root's
    stage). The earlier synthetic parser self-test did not include that trailer line.
- **No production claims:** no production release, no measured release, no deployment and no independent
  reproduction. **Not security-complete.** There is still no reth forced-reorg E2E and no full EVM (`call`,
  `estimate_gas`, `create_access_list`) test through the real Node. Depth is limited to 256.
- **Custody v2 stays REFUSED.**

## Earlier status (kept as written before run 0000; those records were UNTESTED at the time)

**Status then: source preparation only. The candidate (test lifetime fix) was UNTESTED, not a fixed production patch.**
- **Four native runs, all FAILED exit 20 before any test ran** (see "Native run history"):
  - `root-canonical-native-2309`: the dependency closure was incomplete. The harness was repaired.
  - `root-canonical-native-closure-2318`: the closure passed, then `helios-core` (lib) failed with 13 × E0599, because
    the `alloy::consensus::BlockHeader` trait was not in scope in `canonical.rs` and `ancestry.rs`.
  - `root-canonical-native-import-2333`: production `helios-core` (lib) **compiled**. The new test
    `core/tests/node_canonical_methods.rs` failed with 5 × E0576, because it named the `Network` associated types through
    `<Ethereum as NetworkSpec>::`.
  - `root-canonical-native-types-2345`: those 5 errors were fixed. The next target, `core/tests/canonical_block_gate.rs`,
    failed with 1 × E0106 at line 125: the test helper `push` returned a `+ '_` future with two reference parameters.
- **The fixes:** the earlier test fix corrected the trait path to `<Ethereum as Network>::`. The current patch also
  names that helper's lifetime: `fn push<'a>(c: &'a BlockCache<Ethereum>, b: &Blk) -> impl Future<Output = ()> + 'a`.
  `b` is cloned and owned, and only `c` is borrowed. Both are test-only.
- **Not yet shown:** no test or mutant has run, nothing is deployed, and the test targets have not yet compiled.
- **Not secure yet:** do not treat this patch as secure until root's native runs of `jobs/canonical-tests.sh` and
  `jobs/canonical-mutants.sh` pass.
- **Custody v2 stays REFUSED.** It needs those runs, a reth forced-reorg end-to-end test, and a reviewed measured
  release.

## Native run history (every run kept)

| Run | Result | Logs (`runs/`) |
| --- | --- | --- |
| `root-canonical-native-2309` | **FAIL, exit 20, before compiling.** All `[ok]` pre-checks passed (offline, clone tree and `Cargo.lock`, base manifest, patch apply plus `PATCHED.sha256`, cargo-home copy). Then `cargo test --no-run` could not load `helios-opstack`'s path dependency `../../vendor-inspect/base-v1.5.1/crates/common/chains/Cargo.toml`: the fresh work dir had no sibling `vendor-inspect`. **Not a test verdict; nothing compiled.** | `root-canonical-native-2309.{out,guard,rc}` |
| `root-canonical-native-closure-2318` | **FAIL, exit 20, COMPILE-FAILURE before tests.** All pre-checks `[ok]`; A0 closure passed (26 path packages, 0 outside the work dir; `cargo fetch --offline --locked` ok; `Cargo.lock` unchanged). 401 crates compiled, then `helios-core` (lib) failed: 13 × E0599 (`number`/`timestamp`/`parent_hash` not found on `N::HeaderResponse`; the trait `BlockHeader` is not in scope), 7 in `core/src/client/canonical.rs`, 6 in `core/src/execution/ancestry.rs`. Peak RSS 677 MiB. **Not a test verdict; no test binary was built.** | `root-canonical-native-closure-2318.{out,guard,rc}` |
| `root-canonical-native-import-2333` | **FAIL, exit 20, COMPILE-FAILURE before tests.** Production `helios-core` (lib) and `helios-revm-utils` compiled (2 unused-import warnings in `proof_db.rs`). The test target `node_canonical_methods` failed with 5 × E0576: `TransactionResponse` (lines 84, 85), `ReceiptResponse` (91, 92) and `TransactionRequest` (100) were not found in trait `NetworkSpec`, because they belong to `alloy::network::Network` (`NetworkSpec: Network`). Peak RSS 676 MiB. **Not a test verdict; no test ran.** | `root-canonical-native-import-2333.{out,guard,rc}` |
| `root-canonical-native-types-2345` | **FAIL, exit 20, COMPILE-FAILURE before tests.** The 5 E0576 errors from 2333 were gone. The test target `canonical_block_gate` failed with 1 × E0106 (missing lifetime specifier) at 125:87, in the helper `fn push(c: &BlockCache<Ethereum>, b: &Blk) -> impl Future<Output = ()> + '_`. Peak RSS 680 MiB. **Not a test verdict; no test ran.** | `root-canonical-native-types-2345.{out,guard,rc}` |
| `root-canonical-native-reuse-2358` | **FAIL, exit 20, before compiling** (root's record below): `cargo test --keep-going` is unsupported by Cargo 1.96. **Not a test verdict.** | `root-canonical-native-reuse-2358.{out,guard,rc}` |
| `root-canonical-native-build-tests-0000` | **PASS, exit 0.** B 35/35 in 5 binaries; C 91 passed, 0 failed/ignored/filtered; revm-utils and CLI builds ok; `Cargo.lock` unchanged. Cache reused from `tests-20261025T234358Z` (not an independent reproduction). Peak 1206 MiB. | `root-canonical-native-build-tests-0000.{out,guard,rc}`, `tests-20261026T000001Z/{b.out,c.out,fetch.out,metadata.err,CACHE-REUSED-FROM}` |
| `root-canonical-mutants-0006` | **FAIL, rc 1** (completed; `.rc` and `[queue] EXIT 1` present). All pre-checks and cache-reuse guards `[ok]`. Every mutant build (`--no-run`) succeeded. Then M0–M12 and I2 were classified `INVALID (compiler error)` and I1 and I3 `SURVIVED`. **The INVALID classification is a harness defect:** the parser's compiler-error rule matches cargo's `error: test failed, to rerun pass …` trailer. **Negative controls unproven; no kill claimed.** Peak 684 MiB. | `root-canonical-mutants-0006.{out,guard,rc}` |

**Import fix (after 2318).**
- **Source change:** `use alloy::consensus::BlockHeader;` is added to `core/src/client/canonical.rs` and
  `core/src/execution/ancestry.rs`. This is the same import the base already uses in `node.rs`, `block_cache.rs` and
  `eip2935.rs`. It is the only change.
- **Unchanged:** semantics, tests, the 35 expected controls, jobs, dependencies and `Cargo.lock`.
- **Tests:** none of the test files needed the import. They call only `header().hash()`, with `HeaderResponse` and
  `BlockResponse` already imported, or use struct fields.
- **Kept:** the previous patch, manifest, README and `SHA256SUMS` are in `history/prior-20261025-round3-closure-failed-2318-import/`.

**Test type-path fix (after 2333), test-only.** In `core/tests/node_canonical_methods.rs`:
- the 5 mock signatures use `<Ethereum as Network>::{TransactionResponse, ReceiptResponse, TransactionRequest}`. These
  are associated types of `alloy::network::Network` in the pinned `alloy-network` 2.5.0, written the way the base writes
  them (`ethereum/src/spec.rs`, `tests/test-utils`);
- `use alloy::network::Network;` is added;
- the now-unused `network_spec::NetworkSpec` is dropped from the `helios_common` import.

**Unchanged:** product sources, assertions, expected controls, the gate, jobs, dependencies and `Cargo.lock`.

**Kept:** the previous revision is in `history/prior-20261025-import-fix-failed-2333-test-types/`.

**Test lifetime fix and harness changes (after 2345).**
- **The test fix:** `canonical_block_gate.rs:125` now names the lifetime `'a` on `c` only. The crate is edition 2021, so
  the returned future captures only `'a`. No body or assertion changed. A scan of the other test targets found no
  other `-> impl` or `'_` helper.
- **Phase A uses `cargo build … --test <name> … --keep-going`.** One run reports every target's compile errors, and any error
  still exits 20.
- **Optional cache reuse, root-reviewed (`CANONICAL_CACHE_FROM=<ended run dir>`; unset means a fresh copy of the
  reviewed cache, as before):**
  - **Each run is still fresh:** its own clone, patch, `PATCHED.sha256` check, pinned `vendor-inspect`, closure
    checks, logs, and phases A–D all compile and run.
  - **Reused in place, as mutable caches:** only the ended run's `cargo-home` and `target`. Its source and logs are not
    touched. The original cargo-home is never written.
  - **Refused with exit 23 (never a verdict) unless:**
    - the run ended: its queue `.out` names it, ends with `[queue] EXIT`, and its `.rc` is not older than the `.out`;
    - no visible process uses the run dir;
    - no other job holds the reuse lock (an exclusive `flock`, held for the whole job);
    - its cargo-home `registry/cache`, `registry/src` and `git` equal the reviewed cache's.
  - **No reproducibility claim.**
- **Kept:** the previous revision, including its jobs, is in `history/prior-20261025-types-fix-failed-2345-lifetime/`.

**Cause.** R3x built its clone **mounted over the original path**, so the workspace's sibling path dependencies resolved
to `rpc-priority/vendor-inspect`. The job's fresh clone had no sibling.

**Closure repair (harness only; patch, `Cargo.lock` and dependencies unchanged), in `jobs/common.sh`:**
- **Pinned archive:** `vendor-inspect/base-v1.5.1` is now extracted in the work dir from the **pinned archive**
  `rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz` (sha256 `9784e20a…`). The extraction is exactly that
  of the reviewed `r1r.sh:28` and `build-binaries.sh:39-40`, and is verified against the extracted tree hash `c9301490…`.
  It is then made read-only.
- **Equivalence with R3x:** R3x's `rpc-priority/vendor-inspect/base-v1.5.1` is a shallow git clone of the **same
  commit** `5476069f` (tag `v1.5.1-rc.15`). Its files are byte-identical to this extraction; it differs only by a
  mutable `.git`. It is not linked or read.
- **New phase A0 (before any build):**
  - `cargo metadata --offline --locked`; failure gives exit **21, CLOSURE-FAILURE**. It also requires all 26 path
    packages to resolve **inside the work dir** (14 helios plus 12 `base-*`).
  - `cargo fetch --offline --locked --target x86_64-unknown-linux-gnu`; a missing crate gives exit **22,
    DEV-CACHE-MISSING**, an explicit blocker and never a verdict.
- **Static pre-check (read-only):** all 952 registry packages in `Cargo.lock` are present in the reviewed cache, and the
  single git package (`ethereum_hashing@7ee70944`) has its checkout and database. A runtime gap would still be reported
  as exit 22.

## Base and pins

**Base:** Helios `eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e`, tree `2171ad2bfd3c97f2e0e029e866b1a8535cbbd187`,
`Cargo.lock` `28f4400c…`. This is the committed tree whose rebuild reproduced the pinned runtime binary `cc962e2b…`
byte-for-byte (native R3x).

| File | sha256 | What |
| --- | --- | --- |
| `INPUT-MANIFEST.base-eeffcc9.sha256` | `df1f198a…` | base file hashes and tree id |
| `canonical-block.patch` | `41667ec9…` | 1243 lines, 15 files (test lifetime fix; priors `881c5473…`, `3d2c5180…`, `0bdab7cf…` in `history/`) |
| `PATCHED.sha256` | `7e87fad8…` | the patched files, also under `patched/`; `git apply` onto the base reproduces them exactly (checked) |

There is no dependency, `Cargo.toml` or `Cargo.lock` change.

## What the patch does

1. **`BlockCache` (atomic, branch-invalidating).**
   - Each push holds all four locks in a fixed order.
   - A different block at a height, or a new latest below cached heights, removes that height and every cached
     descendant above it, by hash and by height.
   - A latest that no longer belongs to the chain is cleared (fail closed).
   - A hash lookup returns only a block whose own hash matches.
2. **The provider's exact-hash postcondition.** A `BlockId::Hash` answer, from the cache or EIP-2935, must have exactly
   the requested hash.
3. **`client/canonical.rs`, the gate.**
   - **Every hash request:** requires the exact authenticated block.
   - **`requireCanonical: true`:** takes ONE fresh head snapshot (the unchanged 60 s rule). The requested height must be
     ≤ the head and within 256. It walks exact parent-hash links down from the head, each link from the verified cache
     or the EIP-2935 proof against the trusted latest block. The block reached must be the requested hash.
   - **Never used:** no by-height lookup, and no untrusted RPC is a canonicality authority.
4. **`Node`.** All 11 BlockId methods run the gate **before and after** their read.
5. **BLOCKHASH (`execution/ancestry.rs`, used by `revm-utils` ProofDB).** It follows the pinned block's own parent-hash
   ancestry, never "the canonical block at that height".

## History: the round-2 flaw (retained)

`history/round2-SUPERSEDED-INSECURE.patch` (`ad2dc199…`) is the round-2 patch. **It is INSECURE. Do not use it.**

**Root's counterexample against it:**
- Push A10, A11, A12, then B10 (whose parent A9 exists). The consistency check passes and nothing is cleared, so A11 and
  A12 stay cached.
- The gate saw a fresh head and `get_block(Number(11)) == A11`, so `requireCanonical:true` on A11 **passed**, although
  A11 is above the head and not its ancestor.
- By-height equality is not proof of ancestry, including for a different cached branch below the head.

`history/round2-to-round3.diff` (`96c8370b…`) shows exactly what changed. The cache now drops stale descendants, and
the gate proves ancestry by hash links from one head snapshot. Each half has its own test and negative control (below).

## Tests (35 named tests in 5 binaries, `EXPECTED-CONTROLS.txt`)

**`block_cache_exact_hash` (4):**
- a reorg and an A→B→A flap;
- **root's multi-height scenario** (A10, A11 and A12 gone by hash and by height);
- a finalized block that replaces a cached branch, which drops it and clears latest.

**`canonical_block_gate` (17):**
- `true`/`false`/absent semantics;
- refusals: an unknown hash, a wrong block for a hash, a stale or missing head;
- **no by-height lookup ever**;
- **root's counterexample against a provider that still answers height 11 with A11** (the gate alone refuses);
- another branch below the head;
- a forged ancestry link;
- the depth limit and a missing link;
- the real-cache counterexample;
- a reorg or A→B→A flap during a read;
- a head advance versus a reorg;
- a structural check of the 11-method wiring.

**`node_canonical_methods` (8), a REAL `helios_core::Node`:**
- **Harness:** a mock consensus, as in the existing `sync_readiness.rs`, over a mock execution provider. Its blocks are
  the real `BlockCache`, its state is keyed by the exact resolved hash, and the chain is moved **during** each read.
- **Methods driven:** `get_balance`, `get_nonce`, `get_code`, `get_storage_at`, `get_proof`, `get_block`,
  `get_block_receipts`, `get_transaction_by_block_and_index`.
- **The tests:**
  - every flag binds the exact block;
  - a reorg during each method's own read is refused;
  - A→B→A answers A's state;
  - a head advance still answers;
  - root's counterexample through the node;
  - a stale head is refused for `true` only;
  - an unknown hash is refused.

**`rpc_exact_hash_postcondition` (2):** the real `RpcExecutionProvider` refuses a different block for a hash.

**`ancestor_block_hash` (4):** BLOCKHASH ancestry.

## Jobs (root runs these from `work/rpc-production-final-20261025`)

The `jobs/` copies here are byte-identical to `verifier-canonical-stage/jobs/`.
```
./jobs/q-exit-status.sh canonical-tests   2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-tests.sh
./jobs/q-exit-status.sh canonical-mutants 2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-mutants.sh   # after tests PASS
```

**Setup checks (`common.sh`):**
- the network is offline (loopback brought up);
- the source repo is clean at `eeffcc9`, and a fresh clone has the tree, `Cargo.lock` and base files from the manifest;
- `vendor-inspect/base-v1.5.1` is extracted from the pinned archive (`9784e20a…`), verified (`c9301490…`), and made read-only;
- `git apply --check`, then `PATCHED.sha256`;
- a hash-verified **copy** of the existing cargo-home;
- toolchain 1.96.0, `--offline --locked`, one compiler job.

**`canonical-tests.sh`:**
- **A0:** locked closure and dependency cache (exit **21** / **22**, never verdicts).
- **A:** compile preflight. A failure gives exit **20, COMPILE-FAILURE, never a verdict**.
- **B:** `check_cargo_output.py named` requires exactly the 5 binaries, exactly the 35 names all `ok`, and each summary
  `N passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`. There is no `--include-ignored`, and any unexpected name
  fails.
- **C:** all `helios-core` tests. `regression` requires 0 failed **and 0 ignored and 0 filtered**; anything ignored or
  filtered gives exit **30, INCOMPLETE, never a pass**. Plus the `revm-utils` build.
- **D:** the `helios-cli` build.
- **Finally:** `Cargo.lock` unchanged.

**`canonical-mutants.sh`:**
- each mutant must compile (`--no-run`);
- **each named test must report `FAILED` with its own `---- name stdout ----` block containing `panicked at`**;
- a compiler error is INVALID, never a kill.

**The controls:**
- **M0:** the cache tests on the **unpatched** base, which must fail.
- **M1–M12:** including M7 (no descendant drop), **M8 (the round-2 by-height gate)**, M10 (no per-link check), M11 (no
  provider postcondition), and M6/M12 (node post-checks, killed **behaviourally** by the real-Node test).
- **I1–I3:** reported, expected to survive (defence in depth).

**Parser:** `check_cargo_output.py` was self-tested on synthetic cargo output (pass, ignored, filtered, unexpected,
missing, panic versus non-panic, compiler error). No product code has run.

## Limitations

- **UNCOMPILED.** The largest unverified piece is the new real-Node harness (mock execution provider and consensus).
  Phase A separates compile failures from verdicts.
- **Cache dev-dependencies not proven.** The existing cargo-home is not proven to contain every dev-dependency.
- **Depth 256.** `requireCanonical:true` is refused more than 256 blocks below the head. Proving deeper would need a
  per-link proof budget decision.
- **Historical walk cost.** A cold-cache walk costs one EIP-2935 fetch per link, within the existing budget. A walk that
  exceeds the budget refuses; it never answers wrongly.
- **No full EVM tests.** `call`, `estimate_gas` and `create_access_list` are **not driven** through the real `Node`.
  They rely on the shared gate, the tested provider postcondition, the tested BLOCKHASH ancestry and the structural
  check.
- **`requireCanonical` absent or false.** A read already bound to A returns A's own state when a reorg races it (no
  canonicality claim); later requests for a dropped A are refused.
- **Not yet:** no reth `--dev` forced-reorg E2E and no measured release.

Root correction (23:59 UTC): the first cache-reuse run `root-canonical-native-reuse-2358` passed the cache/closure checks but exited 20 before compilation because Cargo 1.96 does not support `cargo test --keep-going`. The installed Cargo help confirms that `cargo build --test <name> --keep-going` supports the intended compile-only phase. Phase A now uses that command for the same five targets; B/C/D and all actual test verdict requirements are unchanged. The failure is retained under `runs/`; no test result came from it.
