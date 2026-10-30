# 1896: independent SOURCE-ONLY review of state-production-validation-stage/r1 (vs report 1890, composite r6/r10, acceptance r3)

## Scope
- **No edits, tests, queue jobs, builds, mounts, network, or data/backup/part reads.** No commits.
- **Read:** r1 `state_gate.py`, the `composite_session.py` seam, `jobs/root-state-validate.sh` and its README; r10 `memory_gate.py` (`gate`/`runtime`/`make_memory_session`/`memory_classify`/`dirty`/`soft_reason`/`evidence`); acceptance r3 (pins/view/final rules); capture r3 `capture.py`; extractor r2 `extract.py` `state_pins`.
- **The only checks I ran:** `sha256sum -c` and a read-only AST listing of extract.py's top-level statements (no execution of stage code).
- **Verified clean:**
  - spv r1 SUMS `47a87af0e87b981b832ddedc020d1e56251900e8062f839b334cc08931cab355`;
  - capture r3 SUMS `f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2`;
  - extractor r2 SUMS `530757e8bd2bb775ec82fd299b55bb4fe5bbbb52a25d00761317749a38af06fa` (`extract.py` `7e1a39e4d5efff94ab2fdb24f2d8a4452b697df991304c8f22950d01d90b572a`);
  - r10 `memory_gate.py` `d5abdd20…` (matches the r1 pin).

**Verdict:** r1 is **fail-closed and sound to keep frozen**. The lifecycle reuse, the argv/report seam, precedence and memory routing match r6/r10 exactly. **D1–D3 must be fixed in the next revision**, together with the concrete wiring in §2. None of them can produce a false 35 today, because `PRODUCTION_INPUTS = None` and the BLOCKED refusal is unconditional.

## 1. Defects (actionable first; none is the intentional block)
**D1 (HIGH: no false 35, but an unbound multi-hour run) — the production view is not bound to `inp["view"]` before the exec.**
- **Where:** `gate` uses the CLI `--view-dir` and `R7.check_view(a.view_dir)`. `runtime` passes `rest`'s `--view-dir` to r6. Neither compares it with `PRODUCTION_INPUTS["view"]`, and `StateSession.exec_plan` doesn't either.
- **The effect:** the only binding is `final_state_status` (`ev.view != pins.view` → 10), after the full hashed-state scan has run. The structural CLEAN (`verify_structural`) is bound to `inp["view"]`, but the *exposed* view is not.
- **Fix (three lines):**
  - `gate`: `a.view_dir == inp["view"]["dir"]`, checked before `set_memory_high`;
  - `runtime`: `rest[rest.index("--view-dir") + 1] == inp["view"]["dir"]`;
  - `state_exec_plan` (after expose, before the exec): `self.receipt["view"] == inp["view"]` (the r6 `expose` record that acceptance `VIEW_KEYS` mirror). Any mismatch → refuse → r6 REFUSED 3 with `exec_info None`, nothing run.

**D2 (HIGH) — the build receipt predicate is incomplete, and it is parsed and hashed from two separate reads.**
- **What it checks now:** `verify_production_inputs` (`state_gate.py:390-394`) `json.loads` one read and hashes another. It checks only `stageSums`, `guard.outDir` and `guard.binaries[helper].sha256`.
- **What is missing:** `verified is True`, `finalRc == 0`, `mode == "build"`, the location (`B12/runs/build-*/receipt.json`), and uniqueness. A failed or unverified build receipt with matching shas would pass. (`G.verify_binaries` is a separate check.)
- **Fix:**
  - read once (`raw = read_all(...)`; `sha(raw) == pin`; `b = json.loads(raw)`);
  - require `CAPM.matching_build_receipts([(name, sha, b)], PINS["r12Sums"][1], helperDir)` to have length 1, with `CAPM` = capture r3 loaded pinned (§2.1). This is the same predicate the capture used;
  - require the path to match `B12 + "/runs/build-*/receipt.json"`.

**D3 (MEDIUM) — the structural prerequisite is read three times, and the job is not bound to the session.**
- **The three reads:** `verify_structural` hashes each pinned file, then `MG.evidence(path, 0, 0)` re-opens the job path, then the session is re-read for parsing.
- **What is missing:** nothing ties the pinned session receipt to the pinned job: a CLEAN session from another run plus another run's final-0 job would pass.
- **Fix:**
  - hash before AND after `MG.evidence` (equal), and parse the session from the hashed bytes;
  - bind the session to the job: require the session path to be `<the job's gate run dir>/session/receipt.json`. Read that dir from the job receipt / r10 `gate.json` field. **The exact field name in r10 `job-receipt.py` must be read at implementation; I did not verify it.** If no such field exists, require that the `session` and `job` pins share the r10 layout prefix `…/runs/prod-<ID>/session/receipt.json` ↔ `…/runs/job-<ID>/…` with the same `<ID>`.

**D4 (LOW) — weaker checks than the rest of the chain:**
- `verify_acceptance` does not check `rc == 0` or the exact 5 check keys being true. The bytes are sha-pinned to the known passing receipt, so this is cosmetic; still, align it with capture r3's `acceptance_receipt_ok`.
- The job's own tests-receipt check (`root-state-validate.sh`) accepts any `pass` + `stageSums`. It should also require `ran == ["14"]` (or the new count) and the format.

**D5 (LOW) — symlinked ancestors are not refused:**
- `static_identities` and `sha_file` use O_NOFOLLOW on the final component only.
- `helperDir` and `staticFilesDir` ancestors are not checked for symlinks.
- **Fix:** add the extractor's `no_symlink_path` rule, plus the `/vm` 253:1 device check (capture r3 `vm_binding`), for both dirs.
- **Residual (owner-only, documented):** a swap of the owner-writable helper between the hash and the exec.

**D6 (LOW / diagnostic) — the memory telemetry peaks are `mdbx_chk`-specific.**
- **Where:** r10 `_tick_body` records `chk*` VmRSS/RssFile/RssAnon/VmPTE peaks only for `comm == "mdbx_chk"`. The helper's comm would be `base-state-read` (15-character truncation).
- **What remains:** only the tree VmRSS peak, the cgroup peaks and the 120 s `samples[].procs` record the helper.
- This is not a correctness defect. Without it, a soft stop cannot be attributed to file-mapped vs. anonymous memory.

## 2. Exact wiring for the next revision (replacing the two BLOCKED refusals)
These interfaces now exist in the frozen code: capture r3 `receipt_errors`, `expected_identities`, `matching_build_receipts`, `outputs_line_errors`, `evidence_manifest`, `expected_evidence_names`, `evidence_errors`; and extractor r2 `state_pins`. **Both modules have side-effect-free top levels** (constants and defs only; `main` sits behind `__name__`). So `load_exact` can compile them from the pinned bytes, as r1 already does for acceptance.

### 2.1 `captureReceipts`
**New PINS:**
- `captureSums` = (`state-fixture-capture-stage/r3/SHA256SUMS`, `f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2`);
- `capture` = (`…/r3/capture.py`, `81ddd643f41e91a16b6bda76d60873dda1d79ab066862b47c199958c072cc3e7`);
- `captureTests` = (the ACTUAL `sfc-r3-tests` receipt, sha). **It does not exist yet: intentional pending.**

**Steps:**
1. **Stage and tests:** `verify_sums(CAP3, "captureSums")`. `t = pinned_json("captureTests")` must be exactly: format `state-fixture-capture-test-receipt/r3`, pass, rc 0, expected 18, `ran == ["18"]`, checks `{rc0, ranExactly, lastLineOK, stdoutEmpty, noBadMarkers}` all true, and `stageSums` = the captureSums pin.
2. **Load and cross-pin:** `CAPM = load_exact("capture", "capture_r3")`. Require:
   - `CAPM.PINS["r12Sums"][1] == PINS["r12Sums"][1]`;
   - `{k: v[1] for k, v in CAPM.ACCEPTANCE.items()} == {"sums": PINS["acceptanceSums"][1], "module": PINS["acceptance"][1], "tests": PINS["acceptanceTests"][1]}`.
3. **The build receipt `b`:** as in D2.
4. **For each kind, `(pin, kind)` in `((inp["positiveCapture"], "positive"), (inp["fixturesCapture"], "fixtures"))`:**
   1. `raw = read_all(pin[0], 1 MiB)`; `sha(raw) == pin[1]`; `rec = json.loads(raw)`.
   2. `exp = CAPM.expected_identities(kind, b, inp["buildReceipt"][1])`; `exp["helperSha256"] == inp["helperSha256"]`.
   3. `CAPM.receipt_errors(rec, kind, exp) == []`.
   4. **Location:**
      - `rec["buildOutDir"] == inp["helperDir"]`;
      - `rec["buildReceipt"] == {"path": inp["buildReceipt"][0], "sha256": inp["buildReceipt"][1]}`;
      - `pin[0] == rec["runDir"] + "/receipt.json"`;
      - `rec["runDir"]` starts with `f"{helperDir}/fixture-captures/{kind}-"`;
      - `rec["workDir"] == rec["runDir"] + "/work"`;
      - `rec["vmBinding"]["majmin"] == "253:1"`.
   5. **Re-run the pinned parser.** A receipt alone is a claim, as capture's own docstring says. The capture bytes must be `read_all(rec["capture"]["path"], 1 MiB)`, with that path equal to `rec["runDir"] + "/capture.txt"` and the sha equal to `rec["capture"]["sha256"]`. Then require:
      - `A.check_fixture_capture(kind, cap, rec["capture"]["rc"], rec["capture"]["timedOut"], rec["capture"]["truncated"], rec["identitiesAfter"], exp)["outputValid"] is True`;
      - `CAPM.outputs_line_errors(kind, cap, rec["workDir"]) == []`.
   6. **Re-hash the evidence** (detects tampering after the capture):
      - `man = CAPM.evidence_manifest(rec["workDir"] + "/out")`, and `man == rec["evidence"]["manifest"]`;
      - `CAPM.evidence_errors(kind, man, *CAPM.expected_evidence_names(kind, A), btxt, helperDir, exp) == []`, where `btxt` = `binaries.sha256` read (≤ 4 KiB) for positive, `None` for fixtures.
5. **Distinct runs:** the two receipts must name different `runDir`s.

### 2.2 `extractionReceipt`
**New PINS:**
- `extractSums` = (`compact-header-extraction-stage/r2/SHA256SUMS`, `530757e8bd2bb775ec82fd299b55bb4fe5bbbb52a25d00761317749a38af06fa`);
- `extract` = (`…/r2/extract.py`, `7e1a39e4d5efff94ab2fdb24f2d8a4452b697df991304c8f22950d01d90b572a`);
- `extractUnitTests` and `extractE2eTests` = the ACTUAL `che-r2-unit` (16) / `che-r2-e2e` (8) receipts. **Not yet run: intentional pending.** Require their exact pass/ran/stageSums as above. The receipt formats must be read from extractor r2 `jobs/tests.sh` / `e2e-tests.sh` at implementation.

**Steps:**
1. `verify_sums`; `EX = load_exact("extract", "extract_r2")`.
2. `raw = read_all(inp["extraction"][0], 1 MiB)`; `sha(raw) == inp["extraction"][1]`; `rec = json.loads(raw)`.
3. **Location:** `run = os.path.dirname(inp["extraction"][0])`; `inp["extraction"][0] == run + "/EXTRACTION-RECEIPT.json"`; `run` matches `^/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-\d{8}T\d{6}Z-\d+$`; `EX.no_symlink_path(run)`; `os.stat(run).st_dev` is 253:1.
4. `sp = EX.state_pins(rec, run)`. It refuses anything but a CLEAN production extraction of exactly the 7-entry allowlist with `totalBytes` 362900885.
5. **Bind the inputs:** `inp["staticFilesDir"] == sp["staticFilesDir"]` and `inp["staticFiles"] == sp["staticFiles"]` (exact list: the 6 header files, order, size, sha256). Then `static_identities` (already in `exec_plan` and post-use) re-verifies the bytes on disk before and after the helper.
6. **Do not trust the CLI output** of `extract.py state-pins`. Call `state_pins` on the pinned bytes, as above.

### 2.3 Then
- Remove the two-key `refuse` loop **only** in the revision that adds 2.1 and 2.2. Make `verify_production_inputs` return normally only after both pass.
- Fill `PRODUCTION_INPUTS` as a literal from the ACTUAL receipts: helperDir/helperSha256/buildReceipt, the two capture pins, the extraction pin, `staticFilesDir`/`staticFiles` = `sp`, structural job/session, and `view` = the structural session's `receipt["view"]` bytes-equal.
- Add D1 to D5.
- **Tests to add (synthetic, in tmp dirs):**
  - **capture:** a stub `CAPM` with a receipt that passes but whose `capture.txt` sha differs → refuse; an evidence file altered after the capture → refuse; a wrong `runDir` prefix or `buildOutDir` → refuse; the two kinds sharing a `runDir` → refuse;
  - **extraction:** an extraction receipt whose 6 files reorder or differ by 1 byte from `inp` → refuse; a `run` symlink → refuse;
  - **view:** `--view-dir` ≠ `inp.view.dir` → gate refuses before `set_memory_high`; `receipt["view"]` ≠ pin → `exec_plan` refuses (rc 3, no child);
  - **build receipt:** `verified false` / `finalRc 1` / `mode preflight` → refuse.

## 3. Confirmed correct (checked in code)
- **Seam:**
  - `exec_plan` is called once inside `use()`, after `heldBeforeExec`, returning the argv and the report path;
  - `children.exec.argv` records the exact argv; `reportPath`/`reportSha256` and `report_raw` are taken from the same bytes;
  - a refusal inside `exec_plan` raises before any exec → r6 main: `refused` with `exec_info None` → **REFUSED 3**.
  - `StateSession.use` runs the provenance-after **only** when r6 `use()` returns normally. Otherwise the PROV record stays incomplete, so the final check fails (10).
- **The argv** is acceptance `expected_argv(acceptance_pins(inp, run_dir))`. No CLI element enters it; `runtime` refuses `--fixture-exec`/`--fixture-unmount-exe` and any kind other than production.
- **Routing (identical to r10):**
  - **gate:** the r10 sequence exactly (`fsize_ok`, `check_qualifications`, `M4.LANE_MIB/HIGH_MIB` on the private instance, `bind_scope`, `reservation`, `R7.check_view`, `set_memory_high` last, then the in-scope re-check), with our input verification placed BEFORE it;
  - **runtime:** the same scope checks (memory.max 4096 MiB, memory.high 3712 MiB, `ancestor_in_cgroup`), `C.CHILD_FSIZE = CHILD_LOG_CAP` (16 MiB), `make_memory_session` over the seam copy, then `C.classify` replaced.
  - **Resource floors** are r10's: 4096 lane, MemAvailable ≥ 16 GiB + lane + 256, root remaining + 40 GiB + 8 GiB native + 208 MiB output budget, the /vm floor, all 265 CONFIRMED.
- **The classify hook works** because r6 `main` calls the module-global `classify` at run time (`composite_session.py:543`). `holder["s"]` is the StateSession instance (MemorySession `__init__`).
- **Precedence** (`composite_session.py:534-543`, then `make_state_classify`):
  1. CLEANUP-INCOMPLETE 4;
  2. CANCELLED 5 (signal, soft stop: r10 `SoftStop(C.Stop)`, or the outer `timeout` TERM; cleanup runs with signals ignored);
  3. REFUSED 3 (no exec);
  4. INCONCLUSIVE 7 (an exception after the exec, e.g. a report > 32 MiB);
  5. acceptance `classify_state`: post-use/provenance → 8, lifecycle faults → 7, 3 with no report → 30, 4 with a valid failing report → 34, 5 with the full predicate → 35, otherwise 7. Dirty or unreadable OOM counters, a soft-stop string, or a missing memory field turn 34/35 into 7.
- **The native mapping:**
  - `memory_of` requires all of `memoryDirty`/`softStop`/`eventsBefore`/`eventsAfter`. `memoryDirty`/`eventsAfter` exist only after classify, so a run that never reached classify is malformed by construction, which is correct.
  - `interrupted` defaults to `"missing"` in the evidence.
- **Final:**
  - inputs unpinned or malformed → `final_state_status(rc, None…)` (35/0 → 10);
  - report bytes re-read with lstat (no symlink follow) and bound to the runtime's `reportSha256`/`reportPath`;
  - view, observed argv and provenance in the evidence;
  - an exception → 10 or the preserved non-35 code;
  - a KILL after `-k 600` gives no receipt → non-35 preserved (137) or 10.

## 4. Intentional blocks (NOT defects)
- **`PRODUCTION_INPUTS = None`:** `gate`/`runtime` refuse first. Only `gate-refused.json` is written.
- **The unconditional BLOCKED refusal** for `captureReceipts`/`extractionReceipt` in `verify_production_inputs`.
- **Not-yet-existing actual evidence:** the r12 build, `sfc-r3-tests` / `sfc-r3-positive` / `sfc-r3-fixtures`, `che-r2-unit` / `che-r2-e2e` and the production extraction, the structural cmv-r10 production CLEAN, `spv-r1-tests`, and all 265 CONFIRMED.

## 5. Observations / risks (decisions, not code defects)
- **O1: final precedence for non-35 codes.** `final_state_status` preserves 30/34/7/8 even when the job snapshots fail (peers changed, mount or process left). The job prints `MOUNT LEFT`, but the exit code does not reflect it.
  - Acceptance r3 is frozen, so the wrapper is the place for this.
  - **Recommended:** if `snapshotsOk/noMountLeft/noProcessLeft/peersUnchanged` are not all true and the code is not 35, exit 4 (CLEANUP-INCOMPLETE). The recorded acceptance code stays in `final.json`. This is root's decision.
- **O2: the soft-stop metric and file-backed memory.** The soft stop uses tree **VmRSS** (> 3840 MiB), which includes RssFile, i.e. mmap'd MDBX pages. A full hashed-state + Verifier scan may exceed it from page-cache mappings alone → CANCELLED 5.
  - **Measure first:** the structural production run's `chkRssFileKiB`/`chkRssAnonKiB` peaks show this before the state run is attempted.
  - Any change to the rule is an r10-level decision. It must not be relaxed in the state stage.
- **O3: the outer timeout** (`H*3600 + 1800`, then `-k 600`) is inherited from r10. Expose + `VALIDATOR_GRACE` + cleanup must fit in 1800 s + 600 s, or a TERM/KILL cuts the run (non-35, but a KILL can leave mounts).
  - The r10 structural run's step timestamps give the expose and cleanup durations.

## 6. Order (no claims)
1. `spv-r1-tests` (r1 stays frozen).
2. The actual evidence of §4.
3. A reviewed r2 with D1–D5 + §2.1/§2.2 and their tests, filling `PRODUCTION_INPUTS` from actual receipts.
4. Review O1–O3 with the structural run's measurements.
5. `state-prod`.

A 35 remains PARTIAL v2 self-consistency at the DB's own Finish header: not canonical, not recovery acceptance, not reset authority.
