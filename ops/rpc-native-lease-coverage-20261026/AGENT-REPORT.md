# Native lease coverage v3 (`derivation-lease-coverage-stage`): source + tests + root build recipe + protocol PREPARED; never compiled

**Stage:** `SHA256SUMS` **1103520a8074fbbcdb38c49985b8381fea499aa2df0294813710924b21914c07**.
- **Not done:** no Cargo, no build, no SSH, no network, no commits.
- **Unchanged and frozen:** combined-r1 (`69160868`), the v2 format, the KVM tree and the contracts.

| File | sha256 |
|---|---|
| `src/zk-utils/examples/derivation_harness_lease_v3.rs` | `e3d55264…` |
| `PROTOCOL.md` (format, provenance, what a consumer may or may not conclude, conflicts) | `3b4e8514…` |
| `jobs/build-test.sh` (root-only build) | `c51ed40b…` |
| `jobs/check_upstream_copy.py` (+ `test_check_upstream_copy.py`) | `6049f884…` / `9dd7f6f9…` |
| `jobs/test_lease_coverage_contract.mjs` | `2208ea1a…` |

## Design (agreed shape exactly; details in PROTOCOL.md)
**Output:** v3 = the v2 fields (format `enclave-base-derivation-result/v3`) plus `coverage{format:'enclave-lease16-coverage/v1', filterId:'lease16-events/v1', fromBlock:agreed+1, toBlock:claimed, blocks[every block: number, hash, stateRoot, messagePasserStorageRoot, outputRoot, receiptsRoot, transactionsRoot, timestamp], logs[address, blockNumber, blockHash, logIndex, topics, data, txHash]}`.

**Inputs and checks reused from v2:**
- the frozen v2 harness (`faa14271`) is `#[path]`-included **unchanged**;
- the 10 trusted keys, Local-key stripping, hash/KZG/number/root checks, `accept()`, `bind_head()` and its 9 tests are all reused;
- there are no new trusted or Local keys;
- interval = 1 and range ≤ 1800 are value checks, made before any block executes.

**Upstream hook (investigated):**
- The pinned 5476069f extension point is `base_proof_driver::Executor`. Its `execute_payload` takes `base_common_rpc_types_engine::BasePayloadAttributes`, a crate zk-utils does not depend on, so an example cannot implement it without changing the frozen Cargo.lock.
- So the harness carries **verbatim copies** of upstream `advance_to_target` and the `WitnessExecutor::run` body, plus **3 inserted lines** marked `// v3-capture` (one parameter, one capture call, one argument).
- `check_upstream_copy.py` verifies this mechanically against the pinned tarball 9784e20a, and `build-test.sh` runs it before cargo. **No vendored patch to upstream.**

**Data from execution only:**
- After each successful `execute_payload` + `compute_output_root`, the executor's own sealed header, receipts and the **executed** tx bytes are compacted.
- Compaction: `receiptsRoot` via upstream `compute_receipts_root`, `transactionsRoot` from the executed bytes, one receipt per tx. Only matching logs are kept, with block-wide logIndex and txHash = keccak(executed bytes).
- **Memory stays O(matching logs).**
- Failed or retried attempts record nothing.
- No witness or RPC log metadata is used.

**Coverage binding:**
- contiguous numbers;
- the parent chain from the agreed safe head;
- each recomputed sealed hash;
- each outputRoot equal to the executor's own root and to `intermediateRoots[i]`;
- strictly increasing logIndex;
- the last block equals the verified executed head;
- coverage ≤ 16 MiB and stdout ≤ 16 MiB.

Any failure refuses, and matching logs are never dropped.

**Filter:** topic0 ∈ the three EnclaveDeployments ABI events, from any address. The signatures are checked against the compiled ABI and against the constants used by `relay/lease-generation.mjs`, the guest bootstrap and the Rust test.

## Tests actually run (shared queue, 512 MiB, `unshare -Urn`, `env -i`, offline)
| Receipt | rc | Result |
|---|---|---|
| `logs/claude-lease-coverage-v3-tests-1.{out,rc}` | 0 | Python 6/6 OK, Node 3/3 (on the pre-compaction harness) |
| `logs/claude-lease-coverage-v3-tests-2.{out,rc}` (`090de9bf…`) | 0 | **Python 6/6 OK, Node 3/3** on the final files |

**What those tests cover:**
- **Python:**
  - the real harness is verbatim upstream plus exactly 3 capture lines;
  - an edited upstream line, an unmarked insertion, a dropped `ensure_derived_block_matches_claim`, an extra capture marker and a missing region marker are each detected.
- **Node:**
  - the signatures equal the ABI events (and their indexed layout);
  - topic0 equals the relay constants, the guest bootstrap pins and the Rust test;
  - the format names and caps are as agreed;
  - v2 is included unchanged.

**Rust tests: written, NOT run. Root's build runs them.** The expected count is 14 = combined's 9 + v3's 5:
- the topics are the ABI hashes;
- every block and every matching log from any address (an empty-event block is covered; logIndex counts every log; txHash comes from the executed bytes);
- 13 refusal cases (plus a check that the honest capture is clean):
  - a missing block, a foreign parent, a fork block;
  - a dropped log (receipts root), other tx bytes (tx root), receipt/tx count;
  - the intermediate root, the executor's root, a number gap, an unsealed hash;
  - no withdrawalsRoot, a duplicate logIndex, the roots length;
- interval 2, an empty range, over 1800, and the size cap refusing (never truncating);
- v3 keeps every v2 binding, ends at the head, the stdout cap refuses, interval 2 is refused before any work, and the input is still exactly the 10 trusted keys.

**Compilation risk (stated):** I checked every API against the pinned sources and registry (alloy-consensus 2.4.1, alloy-primitives 1.6.1, alloy-trie 0.9.5, and the upstream exports). Nothing is compiled until root runs the build.

## Root build (ROOT ONLY, after review)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
pgrep -a -x cargo; pgrep -a -x rustc        # nothing
jobs/q-exit-status.sh claude-lease-v3-native-1 1536 unshare -rnm bash derivation-lease-coverage-stage/jobs/build-test.sh
```
**What the job does:**
- **Pin checks:** stage SUMS, combined-r1 SUMS `69160868`, tarball `9784e20a`, lock `f122da76`, rustc 1.96.0.
- **Verbatim-copy check first.**
- **ONE copy of combined-r1's already-built dependency dir:** taken under a shared lock on its `.combined-lock`. This is ext4, so expect a plain copy of about 2–4 GB rather than a reflink. The copy is then bind-mounted at r3's absolute path, so fingerprints match and **no dependency recompiles**.
- **cargo:** `cargo test --example derivation_harness_lease_v3` (expects 14 ok) and then `cargo build`, both `-j1 --frozen --offline`.
- **Afterwards:** Cargo.lock unchanged, and the binary's sha256 goes to `derivation-lease-coverage-stage/logs/run-*/`.
- **Nothing on disk outside this stage is written.** A failure keeps its logs.

## Conflicts to resolve before finalizing (KVM-owned; details in PROTOCOL.md)
1. **Stdout cap.** KVM's reader caps native stdout at `65536 + n·192` (411,136 B at n = 1800). v3 needs about 1.0–1.2 MB at n = 1800, so KVM must use the agreed 16 MiB for v3.
2. **Format.** `bindNativeV2` accepts only v2. A `bindNativeV3` must re-check the coverage (rules listed) and journal it before publishing.
3. **Native peak memory** with interval 1 over 1800 real blocks is unmeasured against `maxMemoryMiB` 1536.
4. **Durable budget.** At about 24 MB/day of block records, KVM's 4 GiB lasts about 170 days, with no auto-eviction. KVM owns the policy.

**Existing claims before the first covered block remain unproven.** Nothing auto-reclaims or relabels them.

## Not complete (no hand-waving)
- **No positive v3 proof exists yet.** That needs, in order:
  1. root's build passing 14/14;
  2. a real Base witness through KVM's reader with a v3 binding;
  3. 1/30/1800-block resource runs;
  4. accepted-image (SNP) qualification.
- **The relay writer adapter (§5 of `logs/claude-finalized-writer-integration.md`)** follows once KVM's v3 capability contract (`readDerivedLogs`, or equivalent) is final.
- **Custody stays as it is:** the 120 s freshness guard is kept, and data from the unverified (unsafe) head may only deny, never count as proof that a pause is absent.
