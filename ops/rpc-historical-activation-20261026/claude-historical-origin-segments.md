# historical-origin-segments-stage: N-anchored L1 coverage. r2 prepared for ROOT's foreground run; not PASS yet

**Status:**
- **r1 was tested by root** (`root-historical-origin-tests-1235`, rc 1): Ran 25, failures 3, errors 1. All four failures were in test fixtures, none in production code.
- **r2** fixes only the fixtures and the runner. Production `src/` is **byte-identical to r1**.
- **I did not run r2.** I launch no test and no background job: the job is root-owned, and root runs it in the foreground.

No SSH, network, live action, native build or commit was made. r1's bytes and root's failure log are preserved: `historical-origin-segments-stage/SHA256SUMS` still verifies, and `logs/run-20261026T105916Z-1534634/` is unchanged. r14-witness, candidate 80cea, `source/` and native stages were not modified. Admin rights are unchanged.

## Corrections to `logs/claude-historical-blob-readiness.md`

- **Availability:** "the whole range is physically present" was too strong, because it rested on retention metadata only. The correct statement: **availability expected; exact per-block and KZG verification pending** (the job below performs it).
- **Pruning date:** the earliest-pruning estimate of ≈2026-11-07 13:00 UTC is **planning only**.

## Root run of r1 (actual), and the r2 fixes

`logs/run-20261026T105916Z-1534634/unittest.txt`:
- **Passed (21):** all 9 anchored-origin tests, plus these segment tests:
  - swapped canonical origin;
  - same prevRandao with a different parent beacon root;
  - wrong header pbr or mix;
  - non-canonical origin;
  - wrong header number/hash/pbr and tampered documents;
  - untrusted batcher;
  - partial/duplicate/stale/tampered/foreign segments;
  - gate per-block refusal;
  - plan gap/overlap/cap;
  - boundary missed slot;
  - two segments via the CLI;
  - real-scale plan.
- **Failed (4)**, each fixed in r2 by changing the fixture only:

| r1 test | Cause | r2 fix (no production change) |
|---|---|---|
| `test_old_activation_code_rejects_every_new_document` (ERROR) | `Fixture.write` creates only `<root>/coverage`; the test did not create `<root>` | `os.makedirs(root)` first |
| `test_anchored_overlay_accepts_only_fully_re_verified_evidence` | Fixture L1 window is 4, the overlay uses production `BASE_SEQ_WINDOW` 3600 | Patch `CS.BASE_SEQ_WINDOW` to the fixture's window, as `test_coverage_gate.py` patches `cg.SEQ_WINDOW`. A new assertion keeps a real check: with 3600 the overlay **refuses** (`anchored range is not l1Origin(N) - 3600`) |
| `test_el_discontinuity…` / `test_cl_discontinuity…` | The fork chain was served on a second port, so the stricter `endpoint-mismatch` guard fired first | Serve the fork through the **same** server/URL (swap `srv.chain`), so only the continuity guard can fire. `endpoint-mismatch` is still tested with a genuinely different endpoint in the partial/duplicate test |

**Runner.** r2 replaces the line grep with `tests/run_all.py`, which writes `receipt.json` from `unittest.TestResult` itself:
- `testsRun`, `failures`, `errors`, `skipped`, `expectedFailures`, `unexpectedSuccesses`, plus a `notPassed` list and failure details.
- PASS only if `wasSuccessful` and the counts are exactly 25/0/0/0/0/0.
- The job re-checks the receipt's counts dict independently.

### Root command (foreground; 512 MiB; offline; loopback only; private TMPDIR removed on exit)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
jobs/q-exit-status.sh root-historical-origin-r2-tests-1 512 unshare -Urn bash historical-origin-segments-stage/r2/jobs/run-tests.sh
```

- **Output:** `historical-origin-segments-stage/r2/logs/run-*/{receipt.json, unittest.txt, summary.txt, RESULT}`.
- **Expected RESULT:** `PASS historical-origin-segments-r2 testsRun 25 failures 0 errors 0 skipped 0 rc 0`.
- **The job verifies, before running:**
  - r2 `SHA256SUMS`;
  - the gate b4f6d639, origin_extract 6b63b901 and their tests 5d5d8604 / b9b026da;
  - `chain_service` 75c879ec and `test_coverage_activation` 24c37c51;
  - A1 receipt b9a90847, anchor-bootstrap 90a8afba, noble sha3 313da357, kzgcheck 00b3eeb9;
  - that no non-loopback route exists.

## r2 pins

r2 `SHA256SUMS` = **3e82a3572133fb3fb740e5130b3934bbf81b3703e56474785b09fa896e39de47**.

| File | sha256 | Note |
|---|---|---|
| `src/anchored_origin.py` | ed1a547d… | = r1 |
| `src/segments.py` | 8764f5cc… | = r1 |
| `src/anchored_acceptance.py` | 45675c0b… | = r1 |
| `src/bind_anchor.mjs` | f729420c… | = r1 |
| `tests/test_segments.py` | c515a5dd… | fixtures fixed |
| `tests/anchor_fixture.py` | ea7a22fb… | closes the binary-hash file handle |
| `tests/test_anchored_origin.py` | 7e7f054e… | = r1 |
| `tests/anchor_fixture.mjs` | 4338a934… | = r1 |
| `tests/run_all.py` | 2850fd3e… | new |
| `jobs/run-tests.sh` | 70a4f4fd… | |
| `integration/r14/chain_service.diff` | dbc98894… | UNTESTED; see below |

## What is authenticated, and how

### 1. Header N
`anchored_origin.py` reads exactly block N (N = 52866960, from the source-pinned A1 receipt b9a90847), not `LastSafeBlock`. It uses the unmodified, sha-pinned `origin_extract` Reader through `base reth db get` (AccessRights::RO, read-only mount, scratch RocksDB view).

The pinned `authenticateAnchor` (anchor-bootstrap 90a8afba, with pinned noble keccak) recomputes `keccak(RLP(Isthmus header))` and OutputRootV0. These must equal:
- the receipt's outputRoot `0xa996c517…`;
- the DB BlockHash.

`segments.py plan` and the `aggregate` CLI re-run this binding from the recorded header alone, without the DB.

### 2. The DB deposit transaction is NOT authenticated
Nothing binds it to `transactionsRoot`. Its decoded L1-origin number/hash and batcher are labelled `UNAUTHENTICATED` hints. The number only selects which L1 block to test.

### 3. L1 origin binding (this replaces trusting the deposit)
**Source grounding** (base v1.5.1 sources, the r3 extraction of tarball 9784e20a):
- `crates/consensus/derive/src/attributes/stateful.rs:251` sets `parent_beacon_root = l1_header.parent_beacon_block_root`;
- `:257` sets `prev_randao: l1_header.mix_hash`;
- `:259` passes `parent_beacon_block_root` into the attributes;
- `crates/proof/executor/src/builder/assemble.rs:107/112` writes `mix_hash = attrs.prev_randao` and `parent_beacon_block_root = attrs.parent_beacon_block_root` into the executed header, which is the one the output root commits to.

So the authenticated header N carries its L1 origin's `parentBeaconBlockRoot` (call it R) and `mixHash`.

**Uniqueness argument:**
1. R is the root of a beacon block P.
2. A canonical beacon chain is a single chain, so **exactly one** canonical beacon block has `parent_root == R`: P's canonical child C. Empty slots do not matter, because the parent link skips them.
3. After the merge, every beacon block carries exactly one execution payload. By EIP-4788, that EL block's header `parentBeaconBlockRoot` equals C's `parent_root`.
4. Hence exactly one canonical L1 EL block has `parentBeaconBlockRoot == R`: the block inside C. That block is N's origin.

**Checks the aggregate requires,** in the segment holding the hinted number (refusal code `origin-not-bound-to-anchor-header`):
- the gate verified that block's beacon header is `canonical` and non-optimistic;
- the beacon block commits to this EL hash;
- the EL header hash is recomputed by kzgcheck, so its `parentBeaconBlockRoot` and `mixHash` are bound to it;
- beacon `parent_root` == EL `parentBeaconBlockRoot` == header N's `parentBeaconBlockRoot`;
- EL `mixHash` == header N's `mixHash`;
- the EL hash equals the hinted hash.

**What this rules out:**
- A swapped but valid canonical origin has a different parent beacon root. Tested: refused.
- An equal prevRandao with a different parent root is refused. Tested on an L1 fixture where block 1003 carries 1004's prevRandao.
- A wrong header pbr or mix is refused. Tested.
- A non-canonical hinted hash is refused by every segment's own gate check. Tested.

**Assumptions:**
- our own L1 node's finalized view is canonical;
- Ecotone+ is active at N (it is: `requireIsthmus` refuses non-Isthmus headers);
- the source rule above, under which the output-root-committed header carries the origin's fields.

### 4. Batcher (source-grounded correction)
The pinned gate's `batcher` blob scope selects **every type-3 transaction with `to == BATCH_INBOX` (0xff…8453), regardless of sender** (`coverage_gate.py:364-366`). The label's batcher only appears in the report (`:288`). So the untrusted batcher never selected coverage.

r2 also removes it entirely:
- the gate input carries `batcher: None`;
- the plan keeps only `batcherHintUnauthenticated`;
- the aggregate refuses any gate report whose `batcher` is not None.

**Tested:**
- with an attacker-chosen batcher in the DB, coverage counts are identical and both gate files show `batcher: null`;
- `--blob-scope all` (a strict superset) works and verified 4 blobs instead of 3;
- mixing scopes across segments refuses.

Inbox-only, any sender, is a superset of Base's filter (`inbox AND from == batcher`). The `to` field and transaction bodies are bound by the recomputed `transactionsRoot`.

### 5. Coverage
`segments.py` splits the range into contiguous segments of at most 30000 blocks. **The cap is not raised:**
- the gate's `HARD_MAX_BLOCKS` is asserted to be 30000;
- each run passes `--max-blocks` equal to its segment length;
- plans with a 30001-block segment refuse.

Each segment runs the **unmodified** pinned gate `main()`, so every per-block check applies:
- L1 readiness;
- EL parent links;
- receipts, and header/tx/receipt roots recomputed via kzgcheck;
- beacon canonical / parent_root / EL-hash commitment;
- inbox-blob KZG;
- batcher-change refusal;
- origin canonicality;
- the loopback and bounds policy.

Segment gate reports use the format `…segment-gate/v1`, so they can never be read as a whole verdict.

**The aggregate requires:**
- exactly one COVERED segment per planned index from this plan's sha;
- exact endpoints `[l1Origin−3600, toBlock]`;
- no gap, overlap or duplicate;
- block counts summing to the range;
- EL `parentHash` and beacon `parent_root` links across every boundary, with missed slots counted;
- identical endpoints, kzgcheck and blob scope across segments;
- the same gate sha;
- evidence no older than 12 h (this window cannot be widened);
- the plan matches the anchored document.

**Honest scope:** the aggregate is **ORIGIN BINDING + AVAILABILITY** evidence, **not consensus authority**:
- L1 canonicality is our own L1 node's finalized view;
- nothing re-derives or re-executes Base;
- blobs remain subject to the CL retention window after the run.

## Activation

- **Old code fails closed.** `chain_service.coverage_activation` (source 75c879ec, and r14's body is identical) and `readiness_sampler` accept only `…verdict/v1` under the safe-label rule. Tested on 75c879ec: the aggregate, a segment gate report, and the anchored origin are each **rejected**, and an anchored-mode config is rejected.
- **The new overlay** is `src/anchored_acceptance.py`. It reuses the running module's own `_evidence`, `config_identity`, `snapshot_manifest_check` and KZG pin, and accepts only when **all** of these hold:
  - explicit `baseBootstrap.mode: 'anchored-segments'`, with the legacy `coverageAcceptance` absent;
  - pinned shas of the receipt, aggregate, plan, anchored origin, A1 receipt and snapshot manifest;
  - an independent review;
  - the bootstrap manifest, chain config identity, base binary, gate and kzgcheck pins all bound;
  - the A1 receipt is the b9a90847 bytes;
  - the snapshot block is at or above N;
  - the plan matches the anchored origin;
  - all segment files are root-owned and non-writable;
  - **`segments.aggregate()` re-run over the segment evidence reproduces `aggregate.json` exactly**;
  - `l1Block` = l1Origin − 3600 with the receipt binding agreeing.

  Tested refusals: tampered aggregate, foreign A1, swapped anchored pbr, wrong blobSlot, self-review, missing segment, edited gate report, writable file.
- **r14-witness (SHA256SUMS 1ba2d51a) wiring.** This is PREPARED and **UNTESTED**; r14 was not modified. `r2/integration/r14/chain_service.diff` applies to r14 `wrapper/chain_service.py` 9607b831 and makes these changes:
  - adds `base_coverage()`:
    - no `mode` → the legacy path, unchanged;
    - `anchored-segments` → loads the overlay from a root-owned, sha-pinned `ROOT/lib/anchored-coverage/` and returns `(binding, l1Origin)`;
    - any other mode refuses;
  - legacy `coverage_activation` now refuses any `mode`;
  - in `_start('base')`, anchored mode requires the release lock and that `launch.json` anchor == `"{N}:{headerHash}"` before the handshake consumes anything;
  - the canonicality and receipts/blobs gates use the bound origin;
  - `coverage-check` reports either mode.

  **Root must run the r14 wrapper suite on the patched copy before composing it.**
- **readiness_sampler.** This is not implemented, so the sampler does not yet report the new mode as passing. Today it fails closed: `receipt-format` Negative. That correctly gives no implicit readiness, but anchored coverage cannot show READY. The minimal closure is:
  1. add `--coverage-anchored-dir` that calls the same overlay with a small adapter for its `_read_evidence` and expected pins;
  2. map the binding to `snapshotSafe = {N, headerHash}` and `snapshotSafeL1Origin = bound l1Origin`;
  3. reuse `coverage_live` unchanged: the Base EL serves N with headerHash, and the L1 origin is canonical;
  4. add parity tests with the chain_service overlay.

  **Not done; pending.**

## Root live sequence (after r2 PASS and review; not run by me)

1. **Prerequisites:** extraction is finished, and the datadir is read-only bind-mounted. Use the **installed release base binary**: the overlay requires `anchored-origin.source.binarySha256 == manifest binaries.base`.
2. **Anchored origin:**
   ```
   python3 historical-origin-segments-stage/r2/src/anchored_origin.py --base-bin BASE --base-sha256 SHA --datadir RO_DATADIR \
     --scratch EMPTY_DIR --receipt source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/a1-evidence.json \
     --node /usr/bin/node --out anchored-origin.json
   ```
3. **Plan:**
   ```
   segments.py plan --anchored anchored-origin.json --receipt <same A1> --node /usr/bin/node --to-block <observed L1 finalized> \
     --segment-blocks 30000 --out plan.json
   ```
   This gives 2 segments of about 22k blocks each at the hint scale.
4. **For each index 0..k−1:**
   ```
   segments.py run-segment --plan plan.json --index I --out-dir seg-I --el http://127.0.0.1:<own EL> --beacon http://127.0.0.1:<own CL> \
     --kzg coverage-stage/kzgcheck/target/release/kzgcheck --kzg-sha256 00b3eeb9…
   ```
   - Add `--blob-scope all` only if root prefers the costlier superset.
   - Default bounds: `--max-requests = 6·len+200` and `--rps 100`, so each segment is about 132k requests. It is local loopback only, but it is bulk work against our own L1, so root must schedule it.
5. **Aggregate:**
   ```
   segments.py aggregate --plan plan.json --anchored anchored-origin.json --receipt <A1> --node /usr/bin/node \
     --segment seg-0 --segment seg-1 --out aggregate.json
   ```
   This must run within 12 h of the segments.
6. **Before activation:** independent review, then an `enclave-base-anchored-coverage-acceptance/v1` receipt, then the r14 wiring tested. Do all of this well before the planning-only pruning estimate for need_from(N).

## Remaining, honestly

- **r2 25-test PASS:** pending root's run.
- **Real extraction, segments and aggregate:** not run. Exact l1Origin(N) is unknown; the 26235784 value is a hint.
- **Integration:** the r14 patch is untested, and the readiness anchored mode is not implemented.
- **Production readiness:** not claimed.

---
## r3 (IN PROGRESS, interim): readiness anchored mode + wrapper integration against r14-witness 1ba2d51a / wrapper 9607b831
r2 is frozen (root runs `root-historical-origin-r2-1254`; I do not modify or rerun it). r3 adds, in a NEW directory only: patched copies of
r14 `wrapper/chain_service.py` and `readiness/readiness_sampler.py` with an explicit `anchored-segments` mode reusing the same overlay
verification, parity tests, a root-owned job running the existing r14 wrapper/readiness suites on the patched copies plus new tests,
and an install/manifest closure plan. Status below is replaced when finished.
