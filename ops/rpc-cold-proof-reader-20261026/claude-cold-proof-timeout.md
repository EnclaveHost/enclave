# Cold-proof timeout: a proposed bounded fix, prepared, frozen and UNTESTED

**Status:** this is a proposal. Nothing has been run or tested by Claude.
- **Done:** static checks only (`node --check`, `bash -n`, `ast.parse`) and one read-only run of the cascade-plan tool.
- **Not done:** no tests, SSH, queue jobs or commits.
- **Untouched:** r12-final (still verifies against its `SHA256SUMS` 9de0d8d7…), canary r3, every other stage, and `source/`.
- Finalization stays blocked.

## Cause (from root's actual diagnostic `guest-call-timeout-diagnostic-stage/r3/logs/run-20261026T073520Z-2f5bf737`)

The diagnostic completed all phases with invariants and cleanup PASS. The A1 readers give **every** request a 20 s abort (`rpc()` in `a1-read.mjs`). Two kinds of request are proof-bearing:
- the direct `io.el("eth_getProof", …, {blockHash})` to our own reth (`a1-anchor.mjs:242`, `a1-recheck.mjs:114`);
- `io.helios("eth_call", …)`, because Helios fetches `eth_getProof` from our EL to execute the call.

Measured:

| Request | Time |
|---|---|
| Cold `eth_getProof` at the finalized block, 82 blocks behind head | **21986 ms** |
| Same proof, repeated | 5390 ms, then 1614 ms |
| Plain `eth_call` | 8 ms |
| Warm Helios getter at CPUQuota 100% / 400% | 3794 ms / 3247 ms (nearly identical) |

- Helios memory peak was about 70 MB, with no OOM.
- A proof 300 blocks back is correctly refused by the proof window.
- The relay log shows Helios issuing up to 4 concurrent `eth_getProof` requests.

The measured cold proof (22 s) is longer than the 20 s abort, which is exactly the canary r3 failure. Caveat: Q=100 versus Q=400 compares **warm** behaviour only; phase A had already warmed the cache. I make no claim about cold behaviour at each CPU quota.

## Proposed fix: `cold-proof-timeout-stage/` (`SHA256SUMS` **22428307950c9855a4dd19489bd58dd17c767d62513759f57ae49f6f0dcc5d79**)

Only the two **reader** files change. `a1-anchor.mjs`, `a1-recheck.mjs`, `a1gate/*`, the capture module's logic, the crypto, the block-hash pinning, the proof verification and every A1 rule are byte-unchanged.

| File | Old sha | New sha |
|---|---|---|
| `src/l1-anchor-a1/a1-read.mjs` (also `src/a1-original-game-prepared/a1-read.mjs`) | a501a3ec… | **725f1e6e3da224c560ee141b1ab1c76ccc5159f357c977905f5dbdb1336ad8e5** |
| `src/a1-original-game-prepared/a1-recheck-read.mjs` | 41b83975… | **5d6242a976412c087c42df3fc3b765646fe445922fe03a157ba51f07cc0f5aa0** |
| `integration/a1-read.mjs.patch` | | 6e9f6996… |
| `integration/a1-recheck-read.mjs.patch` | | c71d6475… |

### What changes

1. **Deadlines by method class** (`a1io()`, used by **both** readers, so the initial A1 and the original-game recheck behave alike):
   - `eth_getProof` and `eth_call` get **60 s**. That is about 2.7× the measured cold 22 s, which leaves headroom for Helios's parallel cold proofs.
   - Every other request keeps **20 s**.
   - The whole read gets one shared **200 s budget**. This is below `capture()`'s `a1_timeout` of 240 s, so the reader refuses cleanly instead of being killed. Once the budget is exhausted, it refuses **before** sending another request.
2. **No retries:** one fetch per request. No fallback, no `latest`, no public RPC. The loopback-only URLs, `redirect: error`, the streamed 8 MiB byte cap and the JSON-RPC envelope checks are all unchanged.
3. **Short-deadline semantics preserved:** `rpc(url, {timeoutMs})` called alone still applies `timeoutMs` to every method, because the proof class defaults to `timeoutMs`.
4. **New end-of-read freshness check** (`checkFreshAfterRead`): when the read **finishes**, the finalized header must still satisfy the same `validateConfig` `maxFinalizedAgeSec` rule; otherwise it refuses with `finalized_stale_after_read`. It also refuses a header in the future, or a missing `l1.timestamp`. This closes the time-of-check/time-of-use gap that a longer read opens. The evidence `at` is the finish time.

### Tests (prepared, not run)

`tests/test_cold_proof_transport.mjs` (2fccec33…) contains exactly 10 offline `node --test` tests. They use mock servers on 127.0.0.1 only, and private copies of the r12-final-pinned A1 trees with just the two readers overlaid. A real derived `a1-config.json` (e72f271e…) and the pinned deps are used. The 10 tests:
1. the constants;
2. the explicit short-deadline semantics;
3. the per-class deadline;
4. budget clamping and refusal before sending;
5. no retry on timeout, HTTP 503 or a JSON-RPC error;
6. envelope and size rules for the proof class (wrong id, result plus error, non-JSON, oversize);
7. malformed proof bodies refused by the **unchanged** `checkProofResponse`;
8. `a1io` accepts loopback addresses only;
9. stale-after-read, future and missing-timestamp cases;
10. the CLI refusal path wired through `a1io`, plus a static check that the recheck reader uses `a1io` and the end-of-read check.

Job: `jobs/root-cold-proof-tests.sh` (f1b863ab…), queue 256, `unshare -rn`, private mktemp dir. A PASS writes `logs/cold-proof-tests-*/RESULT`.

## Integration recipe (`INTEGRATION.md` 263f60e8…; cascade from `tools/cascade_plan.py` a104155e…)

The cascade covers **19 files** of a composition derived from r12-final. The core chain:
1. the readers;
2. `capture/a1_capture.py` `MODULES` (lines 54/56/61);
3. reader pins in `harness/a2a4.py` (74/76) and `harness-first/a2a4.py` (73/75), plus `A1_CAPTURE_SHA256`;
4. harness pins in `src/finality_state.py` (70), `producer/base_launch.py` (30/34) and `recovery/forward_sync.py` (443);
5. `src/reproof.py` (25/26);
6. `install/MANIFEST.json` (reader destinations 259/289/301, plus every re-pinned module) and `bundle-origin.json` (new origins in this stage, never `source/`);
7. `COMPOSITION.tsv`, `SHA256SUMS`, and the recipe docs.

The historical r10/r11 `integration*/` patches are records: leave them as they are and add new patches. The installer qualification strings move to the new stage name. 50cf composes **after** r12-final's qualification finishes; r12-final itself is never edited.

## Outer deadlines (inspected, not changed)

- **`a1_timeout`** is 240 s. The new 200 s budget fires first.
- **`helios_timeout`** is 90 s. `reproof` calls `capture()` with these defaults. A fresh Helios datadir on the guest took about 120 s to bootstrap (canary r2/r3, which allowed 900 s). The diagnostic, with an existing datadir, was ready in about 3 s. Production keeps a persistent datadir, but a first or cold start could exceed 90 s. That needs a separate reviewed decision and is not part of this fix.
- **Downstream freshness** is unchanged: `FRESH_A1_MAX_AGE_SEC` 600 and `A1_APPEND_MAX_AGE_SEC` 1800.

## Cold-recovery canary (`canary/`; pins pending, so it refuses until composed)

It is derived from the frozen canary r3 flow:
- initial capture, verify, recheck-capture and verify against the consumer-owned initial sha;
- elUrl binding;
- finality-core compatibility;
- same 512M scope, host floor and owned cleanup.

| File | sha256 |
|---|---|
| `tools/assemble_canary_bundle.py` | 61ba3daf… |
| `guest/canary.sh` | 14cb5818… |
| `guest/canary_driver.py` | ae6a897a… |
| `guest/cleanup.sh` | 34fd446e… |
| `jobs/root-cold-proof-canary.sh` | a9e3c4bc… |
| `COMPOSED-STAGE-PINS.json` | 707b5a04… |

**Differences from r3:**
- **Bytes:** they come from the **composed stage** named in `COMPOSED-STAGE-PINS.json`. The assembler also requires that the composition installs exactly the new reader shas.
- **Gate:** the job refuses without a cold-proof-tests PASS for the current stage bytes.
- **Relay:** a transparent logging relay (diagnostic r3's `rpc_log_proxy.py`, f2b22d58…, byte-identical) on `127.0.0.1:18646` sits in front of our own `:18645`, for both Helios's `executionRpc` and the reader's `elUrl`. It has its own 128M scope (aggregate 640M), so the queue claim is **768**.
- **Receipt:** it gains `coldProof`, which records the maximum proof time and the number of proofs over 20 s that succeeded.
- **What counts as verified:** cold recovery is verified **only** if the capture flow passes **and** `coldProof.exercised == true`. A pass on a warm cache does **not** prove the fix; it is reported as unproven.

## Proposal vs. actually tested

| Item | State |
|---|---|
| Cause: 20 s abort < 22 s cold proof | **Measured** (root's diagnostic) |
| 60 s / 20 s / 200 s policy and end-of-read check | **Proposed**; prepared, never run |
| Offline transport and freshness tests | **Prepared**; root runs them |
| Composition with the cascade | **Not started**; for 50cf |
| Cold-path canary | **Prepared**; pending composition |

**Root order:**
1. Run the cold-proof tests (queue 256).
2. 50cf composes after r12-final's qualification.
3. Root qualifies the composition.
4. Fill the pins, re-freeze this stage, and re-run the tests.
5. Run the cold canary (queue 768).

Production is unqualified, Custody v2 is REFUSED, and lease consumers are on HOLD.

## r2: root review correction (FROZEN; supersedes r1; nothing run by Claude)

**Correct root this first:** in r1, the 200 s budget only capped each request when it was sent. Parsing, proof crypto and `evaluateA1`/recheck evaluation after the **last** request could overrun it, with no check before the evidence was emitted. r1 (`cold-proof-timeout-stage/` root files, 22428307…) is left frozen and untouched, **but do not use it**.

**Stage:** `cold-proof-timeout-stage/r2/`. `SHA256SUMS` sha256 is **7ec3b803bd375877869cdaade2cff126ec792be7054fc3e2dff7bc83815b0a08**, and the files are read-only. r12-final is still `9de0d8d7…` (root's qualification PASS, pushed cc30bb890e7f910e99d017f741917735dd3e2d56, not activated) and is untouched.

| File (under `r2/`) | sha256 |
|---|---|
| `src/l1-anchor-a1/a1-read.mjs` = `src/a1-original-game-prepared/a1-read.mjs` | **991f1ae07a3d32747c9df6a2b5978e4faeab0244d6ba0d4ba659198ddcc8a699** (was a501a3ec…) |
| `src/a1-original-game-prepared/a1-recheck-read.mjs` | **6ead7f0da19459e8726abe0d5deb5fc8a9ef4de8c90acf1c24f66a63b3f5862a** (was 41b83975…) |
| `integration/a1-read.mjs.patch` / `a1-recheck-read.mjs.patch` | e98bdba9… / a29cc79c… (exact diffs against the `source/` origins) |
| `tests/test_cold_proof_transport.mjs` | d8dc2705… (exactly 12 tests) |
| `jobs/root-cold-proof-tests.sh` | 6f93b3ff… (queue 256, `unshare -rn`) |
| `tools/cascade_plan.py` | 507480f0… (read-only) |
| `INTEGRATION.md` | cab30a73… (19-file cascade, recomputed for the r2 shas) |
| `README.md` | c3d8c764… |
| `canary/jobs/root-cold-proof-canary.sh` | 0a599eb2… (r2 paths and r2 RESULT gate) |
| `canary/COMPOSED-STAGE-PINS.json` | 9d67baab… (`a1Read` 991f1ae0…, `a1RecheckRead` 6ead7f0d…; composition pins null) |
| `canary/{tools,guest}/*` | byte-identical to r1's canary |

### The correction (readers only; no other change)

- **Monotonic budget.** `a1io()` now measures the budget with `performance.now()`, separately from the **wall clock** used for the header age. It returns `checkBudget()` along with the transport.
- **One gate before emitting evidence.** `finishRead(io, out, cfg, wallNowMs)` first checks the **total** monotonic budget, which includes all time after the last request; if exceeded, it refuses with `read_budget_exceeded`. It then applies the unchanged wall-clock rule (`finalized_stale_after_read`, `finalized_future`, `no_l1_timestamp`).
- **Both readers** call `finishRead` before printing: the initial A1 (`a1-read.mjs` main) and the original-game recheck (`a1-recheck-read.mjs`).
- **Unchanged from r1:**
  - `eth_getProof`/`eth_call` get 60 s; everything else 20 s;
  - the dispatch-time budget clamp;
  - one attempt per request: no retry, no fallback, no `latest`;
  - loopback only, with the same envelope and byte-cap rules;
  - `a1-anchor.mjs`, `a1-recheck.mjs` and `a1gate` untouched.
- **Hard bound:** `capture()`'s `a1_timeout` of 240 s remains the hard kill.

### Tests root runs (`jobs/root-cold-proof-tests.sh`; offline; private dir; prepared, NOT run)

1. **`test_cold_proof_transport.mjs`, exactly 12.** The 10 r1 tests, with the wiring test updated so both readers must use `const io = a1io(cfg)` → `runA1/runRecheck(…, io, …)` → `finishRead(io, out, cfg, end)`. Plus **two new** tests:
   - the last request succeeds inside the budget, then the fake monotonic clock moves past it, simulating parse/crypto/evaluation. `checkBudget` and `finishRead` refuse with `read_budget_exceeded` even though the header age is fine, and no request is sent;
   - `finishRead` ordering and clock independence: budget first, then age; success returns `{usedMs, ageSec}`; the default clock is monotonic.
2. **The existing pinned A1 suite `l1-anchor-a1/test/a1-anchor.test.mjs`.** It covers `runA1` refusals for forged or malformed proofs, `proof_slots`, `proof_json_mismatch`, `header_mismatch`, `wrong_chain`, `no_finality`, `helios_call_failed`, the game-eligibility checks, stale/future finalized headers and finalized-tag moves, plus `a1-read` `rpc()` loopback/byte-cap/HTTP-500/redirect/timeout. It runs on the pinned **original** tree as a baseline and on the tree **with the new reader**. The new-reader run must pass with the **same pass count** and 0 failures.
3. **The existing pinned original-game suite `a1-recheck.test.mjs`.** It covers initial-receipt binding and refusals, pin changes, stale/future/moved/mixed-block refusals, and `not_fresh`. It runs on its pinned tree: its policy code is byte-identical in the fix. Its "pinned reuse" test asserts the **old** `a1-read` sha, which the fix deliberately re-pins through the cascade, so it is not run on the overlay.

Before running, the job checks:
- the source trees against their own `SHA256SUMS` (0633977…, 929f1f5c…);
- their policy files against r12-final's bundle-origin shas;
- r12-final `SHA256SUMS` 9de0d8d7…, the real derived `a1-config` e72f271e…, and the deps lock 9ada1611….

On a pass it writes `logs/cold-proof-tests-*/RESULT`, which reads `PASS cold-proof-tests r2 transport 12 a1-anchor N/N a1-recheck M stage-sums <r2 sha>`.

### Root and 50cf next

1. Root runs:
   ```
   python3 -u ../claude-test-queue.py --mib 256 --log cold-proof-timeout-stage/r2/logs/root-cold-proof-tests.guard -- unshare -rn bash cold-proof-timeout-stage/r2/jobs/root-cold-proof-tests.sh
   ```
2. On PASS, 50cf composes a new stage from r12-final using `r2/INTEGRATION.md`: new bundle-origin entries pointing at `cold-proof-timeout-stage/r2/src/…`, then the 19-file pin cascade.
3. Root qualifies that composition.
4. Fill `r2/canary/COMPOSED-STAGE-PINS.json`, re-freeze r2, re-run step 1 (the canary gate needs a PASS for the current bytes), then run the canary (queue 768).

**What the canary can and cannot show:**
- `coldProof.exercised == true` means only that a proof taking more than 20 s **succeeded** through the relay. It does **not** show that the OS page cache was cold.
- `exercised == false` means the cold path was **not** demonstrated.

**Status:**
- **Measured:** the cause (from root's diagnostic).
- **Proposed only:** everything in r2.
- **Not done:** no tests, live actions or commits. Finalization stays blocked.
