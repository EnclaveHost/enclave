# Bootstrap closure peer review: first-harness A1 gate vs the reviewed capture-module closure (read-only; nothing run or edited)

**Scope:**
- r12-final `harness-first/a2a4.py` (`dbd4cbe3`), `harness/a2a4.py`, `src/finality_state.py`;
- `source/.../a1-original-game-prepared/run-recheck.py`;
- the cold-reader cascade (`cold-proof-timeout-stage/r3`);
- **PROVISIONAL:** da0's unfinished `production-bootstrap-wiring-stage/overlay` (files dated 01:09–01:13; the `patches/`, `install/` and `jobs/` directories are empty). r13-compose and the wiring stage were read only.

## A. Findings (concrete; severity from the production-trust point of view)

**A1. HIGH: the first-bootstrap A1 path never passes through the reviewed capture closure.**
- `harness-first gate_a1` accepts only **legacy files**:
  - `fresh-initial`: a raw `a1Evidence` JSON;
  - `original-game-recheck`: `recheck.json` + `run-result.json` from ONE `run-recheck.py` directory (`gate_recheck_run`, lines 394–410).
- Its provenance is a **self-asserted** run record: `inputPins` = hashes of sibling files, `recheckExit 0`, `processStopped`, `productionActivated false`, and the time window. Nothing binds it to:
  - the runtime (node/python identity);
  - the Helios binary/config/checkpoint;
  - the capture `argv`/copies;
  - `capture.json`/`verify()`;
  - the admission ledger.
- The pinned JS gate (`a1-gate.mjs`) re-checks the receipt's internal consistency, but it cannot re-verify Helios authentication (the receipt carries values and pins, not proofs).
- **Effect:** any root-owned `recheck.json` + `run-result.json` pair that is internally consistent and fresh is accepted. Re-anchor (`harness/a2a4.py` `capture-recheck`) and reproof (`finality_state`) **do** use the capture module, so the weakest link is the FIRST launch.

**A2. HIGH (portability): `run-recheck.py` cannot be the production producer.**
- Workstation paths: `W/P/O` = `/home/steven/...` (lines 8–9).
- Workstation forward ports: `heliosUrl 127.0.0.1:28550`, `elUrl 127.0.0.1:28645` (line 16); this is the same port class as canary r2's failure.
- An unpinned `node` from PATH (line 36), and a 240 s subprocess timeout around the old 20 s readers.
- Running it on the workstation through the forwards and copying the result in moves A1 verification **outside** the guest trust domain. Running it on the guest needs a port/path edit, which changes its inputs without review.

**A3. HIGH (cascade/activation conflict): the cold-reader re-pin breaks the legacy first-bootstrap provenance unless it is decided explicitly.**
- r13's cascade re-pins harness-first `RECHECK_INPUT_PINS` (lines 73/75: `a1-read` a501a3ec→da9a9e9c, `a1-recheck-read` 41b83975→78df2211).
- `run-recheck.py` computes `inputPins` from **its own siblings**, which are the OLD readers in `source/`.
  - If r13 re-pins: every legacy run record refuses `a1_provenance`, and no reviewed producer of new-reader legacy records exists. First bootstrap is then blocked.
  - If r13 does NOT re-pin: first bootstrap keeps the 20 s readers, so the measured 22 s cold-proof failure stays on the first launch.
- **Either way this needs a recorded decision.** Recommended: route first bootstrap through the capture module (see C), not through legacy records.

**A4. MEDIUM (activation constraint): `fresh-initial` can never produce a launch.**
- `base_launch._initial_ok` (first bootstrap, `reanchor is None`) requires `a1Gate.initialSha256 == A1_INITIAL_SHA256` (b9a90847, the live-1958 receipt: game 0x343b3a99…, N 52866960).
- A `fresh-initial` gate summary carries the fresh receipt's own sha, so the launch refuses `'a1'`.
- **The only workable first-bootstrap A1 is therefore `original-game-recheck` of the 1958 receipt.** That means:
  - the planned N/root/game must be exactly 52866960 / 0xa996c517… / 0x343b3a99…;
  - the extracted snapshot must hold N with state frontier ≥ N (`step_plan` `state_below_anchor`);
  - the game must still be eligible at use time. If it has been retired or blacklisted, first bootstrap needs a SOURCE re-pin.
- This needs stating in the activation runbook; it is not a bypass.

**A5. MEDIUM: no admission ledger on the first path.**
- harness-first has no `A1_ADMISSION_LEDGER`/`admit`. The same recheck receipt is reusable for any number of A2/release attempts within `a1MaxAgeSec` (config, up to 3600 s).
- It is bounded downstream: `bind_a1` matches A2 and release; `produce` refuses an existing output; `arm` refuses `watermark_exists`.
- **Test that these downstream bounds really stop a second launch** (B8).

**A6. MEDIUM (freshness bridge): the window must stay inside harness-first's `A1_RUN_WINDOW_SEC` = 300.**
- `at − l1.timestamp` must lie in `[ageSec, ageSec + 300]`.
- The r3 readers record `ageSec` at read **start** and `at` at read **end** (≤ 200 s monotonic budget), so the window holds with about 100 s margin.
- Any adapter that rewrites `at` (for example to the capture finish time, or to a copy time) or adds post-processing delay can break it, or silently widen it if the constant is changed.
- Keep 300 tied to the 200 s reader budget (B6).

**A7. MEDIUM (provisional): the wiring overlay is a fork of r12-final pins, not of r13.**
- The overlay's `base_launch.py` keeps `A2A4_SOURCE_SHA256 = dbd4cbe3` (r9/r12 harness-first) and `RECOVERY_A2A4_SHA256 = 6c1d0b1b`, and its `reproof.py` `PRODUCER` pin is `6a94584e`.
- r13's cascade changes all three files (`base_launch` 30/34, `reproof` 25/26) **and** harness-first. The overlay must be rebased on r13 and re-pinned through the same fixed-point cascade (`cold-proof-timeout-stage/r3/tools/cascade_plan.py`, pointed at r13). Otherwise one of the two changes is silently dropped, or the producer pin chain breaks.
- The overlay's only `base_launch` diff (empty root 0700 `finality/` inside the atomic publish) looks correct.

**A8. LOW–MEDIUM (provisional; verify, don't assume): `60-release-mode.conf`.**
- It sets `InaccessiblePaths=-/etc/enclave-rpc/jwt.hex`. Confirm the release-mode wrapper/base binary never needs an engine JWT. If it does, start fails closed: an availability issue, not a bypass.
- `own-datadir` lchowns every non-rpcbase entry in the data subtree to rpcbase. It is safe only because the subtree is its own filesystem (4 TB base disk), so no hard link can reach a root file. Add a check: refuse/skip regular files with `st_nlink > 1` and entries whose `st_dev` differs from the mount's.
- `datadir-idle` exits 1 when undeterminable, which is correct (skip, not fail).

## B. Negative-test plan (reuse existing fixtures; no new framework)

**Reuse:**
- A2 stage `test/test_a2a4.py` (`TA.fresh_a1`, `TA.Recheck.use_recheck`);
- r12-final `tests/r7-ported/test_r3_launcher.py` (`L3.Pipeline`) and `test_reanchor_recovery.py`;
- the capture-r10/closure fixtures;
- the canary r3 driver.

Each case below gives the expected result.

| # | Case | Expected |
|---|---|---|
| B1 | Forged but consistent legacy pair: a root-owned `run-result.json` with exact `inputPins`, `recheckExit 0`, a correct window, and a `recheck.json` built by `TA` without any Helios run | **Currently ACCEPTED** (documents A1). Must refuse once first bootstrap requires capture-module evidence. |
| B2 | After r13, a legacy run record with OLD `inputPins` | `a1_provenance` (proves the A3 decision is live, not silently passing) |
| B3 | Capture-format files in legacy mode: `a1Evidence = …/capture/evidence.json` | `a1_provenance` (name/dir rule). Legacy `recheck.json` in `capture-recheck` mode → `bad_config` (`harness/a2a4.py` line 222). |
| B4 | `fresh-initial` evidence naming the planned N, then `base_launch` produce | refuse `'a1'` (A4); keep it as an explicit regression |
| B5 | `a1InitialSha256` ≠ `A1_INITIAL_SHA256`; recheck sha ≠ `a1RecheckSha256`; run record `initialSha256` ≠ config | `a1_initial_pin` / `a1_recheck_sha` / `a1_provenance` |
| B6 | Window bounds with r3 timings: `at − ts = ageSec + 199` | accept |
| B6 | `at − ts = ageSec + 301` | `a1_l1_stale` |
| B6 | `ageSec = 1801` | `a1_l1_stale` |
| B6 | receipt `at` outside the run record `[startedAt, finishedAt]` | `a1_provenance` |
| B7 | Stale use: receipt `at` older than `a1MaxAgeSec` at A2 | `a1_stale` |
| B7 | release-time A1 at an older L1 block than A2's | `a1_binding` (`bind_a1`) |
| B8 | Replay: the same receipt for a second first-bootstrap after a launch exists | produce refuses (output exists) and/or `arm` `watermark_exists`; assert the refusal code, not just "fails" |
| B9 | Original game no longer eligible (`isGameRetired` / `isGameBlacklisted` = 1 in the recheck world) | refused by the unchanged `a1-recheck.mjs` (existing 27-test suite covers it); assert first bootstrap cannot proceed |
| B10 | Portability guard: any first-bootstrap producer config/argv naming `/home/`, `:28545`, `:28645`, `:28550`, `:25052` or `10.0.2.x` | refuse (reuse `production-cutover-inventory-stage/tools/forward_port_guard.py` pattern) |

## C. First-harness adapter: input contract to review when da0's adapter appears (not present yet)

The adapter must **consume capture-module outputs directly, never translate them into legacy files.** Required:
1. Load the capture module only via the harness's pinned `load_capture()` (`A1_CAPTURE_SOURCE` + `A1_CAPTURE_SHA256`, r13 value), under the `A1_CAPTURE_REVIEWED` HOLD.
2. Evidence is two capture dirs:
   - `mode` `recheck` (the capture module's original-game recheck of the pinned `pins.initial` = b9a90847);
   - or `initial` + `recheck-capture`, with `verify(initial_out=…, expected_initial_capture_sha256=<root-reviewed config value>)`.

   The expected sha comes from root's config or record, **never from the recheck's own record**.
3. `verify()` must run in the adapter. It binds runtime identity (`runtime_accepted`), argv/env, copies, a1-config elUrl derivation, and the a1gate pins. Then admit it in an **admission ledger** (the same `admit` semantics as `harness/a2a4.py`: one use per capture id).
4. The gate summary N/outputRoot/game/ASR/codeHash pins must equal the plan, and freshness comes from the capture's own `at` (`a1MaxAgeSec`) plus the A6 window. Record `initialCapture` in A2 so `base_launch` can re-verify it (as `_initial_ok` does for `capture-recheck`), and update `_initial_ok`'s first-bootstrap branch accordingly. Today it accepts only the legacy source pin.
5. `Sources` come only from `/etc/enclave-rpc/a1-capture-sources.json` (root-owned, EL `127.0.0.1:18645`), never `Sources()` defaults.
6. No fallback to the legacy `run-recheck.py` path when a capture fails. If the legacy mode is kept for tests, production config must refuse it.

**Review the exact diff of these when they appear:** harness-first `gate_a1`/`load_config`, `base_launch._initial_ok`, the A2 `a1Gate` record, and the activation flag mapping (`A1_CAPTURE_REVIEWED` covers this path).

## D. Canary template meaning (`cold-proof-timeout-stage/r3/canary`)

- **What it validates, on the final composed bytes:** capture `initial` + `verify`, then `recheck-capture` of THAT initial + `verify` with the consumer-owned expected sha, plus elUrl binding and core compatibility.
- **What it does NOT run:** the capture module's `recheck` mode against the **pinned original game (b9a90847)**. That is the A1 that first bootstrap needs (A4). Root must also validate that mode on the final composed bytes (and, after C, the adapter's exact path) before the first launch.
- **`coldProof.exercised`** records only that a proof taking more than 20 s succeeded through the relay. It is a latency measurement, **not** a cold-OS-cache claim. `false` means the cold path was not demonstrated.
