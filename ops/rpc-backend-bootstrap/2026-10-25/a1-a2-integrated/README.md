# A1 original-game recheck → A2 integration (PREPARED; NOT RUN; root review pending)

## Status (FROZEN prepared copy, 2026-10-25)

| Item | State |
|---|---|
| Source | Prepared and frozen in this stage only: an isolated copy of `a2-a4-execution` (frozen `a2a4.py` `85b4fc92…`), plus a new pinned JS gate. Files are made read-only (`chmod a-w`); `logs/` stays writable for root's runs. |
| Unit run 2208 (root) | **FAILED**, rc 1: `test_a2a4` had 1 failure and 1 error; the writer, manifest and node suites passed. Logs kept verbatim in `logs/failed-run-2208/` and `../../logs/root-a1-a2-integration-2208.*`. |
| Unit repair | **Two test-fixture defects; no code change.** `a2a4.py` and `a1gate/*` are unchanged, and the UID, symlink and provenance rules are unchanged. Only `test/test_a2a4.py` changed (see "Unit repair" below). |
| Repaired unit run | **PASSED** (shared queue, 256 MiB, foreground, `unshare -rn`, rc 0; `logs/tests.{out,rc,guard}`, `logs/run/`). Python 33 + 2 + 1 tests, each a bare `OK`; node 8/8 (`# fail 0`, `# skipped 0`, `# todo 0`). The inputs check ran against SHA256SUMS `3974052…`. |
| Mutants | **NOT RUN**; left to root after review (command below). |
| Root's live A1 recheck | **PASSED at 21:53** (root's run, `outputs/…/l1-a1-recheck-retry-2152`): exact source `f591f324…`, original N 52,866,960 kept while the latest anchor advanced to N 52,869,960 (`accepted: false`). The first live attempt (`l1-a1-recheck-after-2140`, timeout) is kept by root. |
| Live output vs this gate | **Static read only, not a test:** the key set, read set, pin set and `recheckOf` match `a1-gate.mjs`. `at` 21:53:07.913Z lies inside the run window [21:51:51.12, 21:53:07.94]. Recorded age 931 s ≤ 1800; `at` − header timestamp − age = 74 s ≤ 300. Pins equal the initial observations; the block 26,272,420 is newer than 26,271,848. **In production these files are user-owned, so `TRUSTED_UID = 0` refuses them until root installs them root-owned (risk 3).** |
| Frozen dirs | `a2-a4-execution/`, `a1-original-game/` and every publication are **read-only and unchanged** (`frozen-sources.sha256`). |
| Not done | No live run, SSH, compile, commit, queue reservation, or authority/administrator change. |

## Unit repair (after root run 2208): fixture only

1. **`FreshInitialTrust.test_a1_file_trust`: failure** (`plan` accepted where `untrusted_file` was expected).
   - **Cause:** the test set `A.TRUSTED_UID = 0` and assumed 0 is not the files' owner. Root runs under `unshare -rn`, a user namespace that maps the test user to uid 0, so the test files *are* owned by uid 0 and the check correctly trusted them.
   - **Fix:** use `os.getuid() + 1`, a uid that does not own the files, in this test and in the same case in `Recheck.test_initial_receipt_pin_and_file_trust`. The production `TRUSTED_UID = 0` and the `_read_trusted` rule are unchanged.
2. **`Recheck.test_initial_receipt_pin_and_file_trust`: error** (`cfg.json` missing).
   - **Cause:** the symlink case sets an instance attribute `self.write = lambda: None`. The following `self.setUp()` ends with `self.write()`, which was still the no-op, so the new temporary directory got no `cfg.json`.
   - **Fix:** `Case.setUp` first removes any instance-level `write` override (`self.__dict__.pop('write', None)`). The same pattern in `test_the_real_live_initial_receipt_passes_only_while_fresh` is now also safe.

No test was skipped, removed or marked as an expected failure; every assertion is unchanged.

## Problem

Frozen `gate_a1` accepts only a fresh INITIAL `A1-authenticated` receipt. That receipt names the ASR's **latest** anchor, so once the anchor advances past N (normal during a long A2–A4 rebuild), `a1_anchor_advanced` stops the bootstrap.

## Change: `a1Mode` (explicit in config; default `fresh-initial`, the frozen path)

### `original-game-recheck`

The gate accepts the separately reviewed recheck (`A1-original-game-recheck-passed`) only if **all** of these hold:

1. **Initial receipt pinned.** `a1InitialSha256` must equal the source constant `A1_INITIAL_SHA256` (`b9a90847…`, live-1958). Changing it is a source change, never config (`a1_initial_pin`).
2. **Exact bytes.** The initial file's sha256 is checked by the reviewed `loadInitialReceipt` (`initial_sha`, `not_initial_a1`, `bad_initial`). The recheck file's sha256 must equal `a1RecheckSha256`, which root writes after reviewing that exact `recheck.json` (`a1_recheck_sha`).
3. **Strict new fields** (`a1gate/a1-gate.mjs`, `checkRecheck`):
   - the verdict is exactly the recheck verdict (`not_recheck`);
   - the exact top-level key set (`bad_recheck`), and the exact `recheckOf` keys `{sha256, verdict, game, N, outputRoot, asr, l1{number,hash}}`, which must equal the pinned initial receipt (`recheck_binding`);
   - the top-level `game`/`N`/`outputRoot`/`asr`/`respectedGameType` must equal the **initial** values (`recheck_binding`), so a latest-N or descendant game is refused;
   - the label must equal runRecheck's exact label.
4. **Fresh finalized block.** The block number must be strictly greater than the initial one, and the hash must differ (`not_fresh`). The recorded age must be ≤ 1800 s (`finalized_stale`). In Python: receipt `at` age ≤ `a1MaxAgeSec`, and the recorded age must be consistent with `at` and the header timestamp (`a1_stale`/`a1_l1_stale`).
5. **Original-game eligibility and proof labels.** The `reads` map must be exactly runRecheck's read set: portalAsr, paused, respectedGameType, the 4 `isGame*` flags, status, rootClaim, l2SequenceNumber, gameType, gameAnchorStateRegistry and latestAnchor{Root,Game} as `helios-call`, and `account:<addr>` as `mpt-proof` for every pinned address. There may be no missing or extra keys, and each read must carry its exact class (`unproven_read`). The initial receipt must also carry the complete A1 read set.
6. **Pins compared.**
   - The address set and every slot set must equal the initial **observations**.
   - Every codeHash and slot value must be unchanged, with `comparison == "unchanged-from-initial-observation"` (`recheck_pins`).
   - Python additionally requires the mainnet portal/ASR code hashes, the ASR and the respected type (`a1_pins`).
   - These pins are observations, not approved versions.
7. **Latest anchor: observation only.**
   - `accepted === false` exactly, it must not be below N, and it must not name the original game with another root/N (`recheck_latest`).
   - It is recorded as `latestAnchorObservation` in the gate result and **never used**.
   - Python compares the gate's (initial) N/root/game with the planned config (`a1_anchor`). In this mode, `a1_anchor_advanced` cannot fire, because N is the initial N.
8. **Provenance** (`gate_recheck_run`, `a1_provenance`):
   - `recheck.json` and `run-result.json` must come from ONE `run-recheck.py` output dir;
   - `inputPins` must exactly equal `RECHECK_INPUT_PINS` (the 5 frozen recheck files);
   - `initialSha256` must be pinned;
   - `recheckExit` must be the integer 0 (not `false`), `processStopped` must be `true` and `productionActivated` must be `false`, with no `error` field;
   - the receipt `at` must fall within `[startedAt, finishedAt]`.
9. **Release bound to A2** (`bind_a1`, `a1_binding`):
   - `a2` saves its A1 gate result in `a2-authenticated.json`;
   - `release` must name the same `initialSha256`/N/root/game/ASR, at an L1 block not older than A2's;
   - so the bootstrap can never switch receipts or anchors between A2 and release.

**Never accepted:** a recheck as initial evidence (`not_initial_a1`, in both modes), an initial as a recheck (`not_recheck`), a CLI refusal output, a recheck of another initial receipt, the latest N or a descendant game.

### `fresh-initial` (frozen semantics, tightened)

- The same root-owned single read is used.
- The exact bytes go through the reviewed `loadInitialReceipt`, using the sha of those bytes. This gives:
  - verdict `A1-authenticated`, and no `recheckOf`;
  - **every** label must be `helios-call`/`mpt-proof`;
  - an authenticated ASR candidate match.
- New checks:
  - the complete A1 read set must be present;
  - pins must exist for the ASR and the game;
  - the L1 timing must be consistent.
- `a1_anchor_advanced` is kept. Its message now points to the recheck mode.

## Trust model (documented, not bypassed)

`a2a4.py` has **no light client**: it cannot re-verify Helios.
- **A1 files are trusted root-produced records.** Every A1 evidence file (initial receipt, recheck receipt, run record) is a **trusted root-produced record**.
- **Single verified read.** Each file is read **once** from the open file descriptor (`_read_trusted`):
  - opened with `O_NOFOLLOW`;
  - it must be a regular file, owned by `TRUSTED_UID` (0), not group/other-writable, and ≤ 1 MiB;
  - there is no stat/read race and no path re-resolution.
- **Bound to pinned bytes and provenance.** The initial receipt is bound by sha (source pin plus config), the recheck receipt by root-reviewed sha, and the run record by provenance (same directory, input pins, time window).
- **Labels are records, not proofs.** `helios-call`/`mpt-proof` record how the root runner obtained a value. The gate checks that this record is complete, exact and consistent; it does not turn a label into a proof.
- **Gate module pinned.** The JS gate is pinned (`A1_GATE_PINS`). Its bytes are read once, hash-checked, and imported from a private copy in the 0700 workdir; the copy is removed after use.

**Tightened, existing root-owned handling:**
- **Frozen gaps found:**
  - frozen `gate_a1` did **not** check ownership of `a1Evidence` at all;
  - the download receipt and manifest were checked with `stat` and then re-read by path (a TOCTOU gap).
- **Fix:** all three now use `_read_trusted`, and the manifest sha is computed over exactly the bytes that are parsed.
- **Test adaptation:**
  - the frozen `untrusted_file` test (`TRUSTED_UID = 0`) would now trip on the A1 file first;
  - it is replaced by per-file group-writable cases (receipt, manifest);
  - the uid case moves to the A1 tests.

## Files

| File | sha256 | Origin |
|---|---|---|
| `a2a4.py` | `aaa661e0…6186` | frozen `85b4fc92…` + this change |
| `a1gate/a1-gate.mjs` | `06cc2961…414c` | **new** |
| `a1gate/a1-recheck.mjs` | `f591f324…d9d8` | a1-original-game, byte-identical |
| `a1gate/a1-anchor.mjs` | `ec92b70f…528d` | l1-anchor-a1 via a1-original-game, byte-identical |
| `test/test_a2a4.py` | `43cc5467…6b0c` (repaired; was `ae856620…8d90` in run 2208) | frozen `5a84ac20…` + adapted fixture + 13 new tests (33 total) |
| `test/a1-gate.test.mjs` | `2ddd8353…0f72` | **new**, 8 tests |
| `mutants.sh` | see `SHA256SUMS` | frozen `38b4d44d…` + 20 mutants |
| `taplog.py` | `db23b6f3…` | a1-original-game, byte-identical |
| `run-tests.sh`, `a2a4-config.recheck.example.json` | see `SHA256SUMS` | **new** |
| `selection.py`, `write_download_receipt.py`, `test/{fake_base.py,make_fixture.mjs,test_receipt_writer.py,test_pinned_manifest.py}` | unchanged copies | frozen |
| `test/deps.mjs`, `test/vendor/anchor-bootstrap.mjs`, `test/fixtures/*` | unchanged copies | a1-original-game |
| `frozen-a2.diff` | see `SHA256SUMS` | exact `diff -u` of the 4 changed frozen files |

## Tests (prepared)

### Python (`test/test_a2a4.py`)

- **Fixture:** the **REAL live initial receipt** (its structure: reads, pins, candidates). Only the output root (moved to the synthetic header-N fixture), `at` and the L1 timestamp are moved.
- **Frozen tests:** kept, with codes adapted where the stricter gate refuses earlier:
  - an "rpc" label now gives `a1_receipt: bad_initial`;
  - a foreign ASR is now *recorded as authenticated* and still refused by `a1_pins`;
  - a foreign game is now config vs. receipt.
- **New `FreshInitialTrust`:**
  - the exact live bytes pass at 19:59 and are stale at 20:30;
  - file trust: uid, group-writable, symlink, missing, oversize;
  - a recheck, or `recheckOf`, as initial evidence is refused;
  - no ASR match;
  - L1 timing;
  - config keys;
  - gate-module pins, including a tampered `a1-recheck.mjs`.
- **New `Recheck`:**
  - **Pass** after the latest anchor advanced, with N unchanged and the latest anchor `accepted: false`.
  - **Production pins** with the exact live initial bytes and the unmodified `A1_INITIAL_SHA256`.
  - **Full a2→a3→a4→release flow**, which reaches `bytecode_receipt`, so the gate and binding passed. Then `a1_binding` for an older L1 block, and for switching to another fresh initial receipt.
  - **37 receipt rebinding cases** (latest N or descendant game as N, `recheckOf` fields, verdicts, latest-anchor observation, freshness, pins, read labels, shape).
  - **Pin and file trust:** initial pin, initial sha, recheck sha, ownership of each file, symlink.
  - **11 run-record provenance cases**, plus another directory and another file name.
  - **Freshness, planned anchor, mainnet code-hash pin.**

### Node (`test/a1-gate.test.mjs`)

**Producer → consumer:**
- The **REAL `runRecheck`** (byte-identical) runs over the frozen test's mocked Helios world and the **real** upstream proof.
- Its output must be accepted as is, with the exact key set, label and read set, so any **shape drift** between producer and consumer fails.
- **Advanced anchor:** observation only.
- **Not interchangeable:** recheck vs. initial vs. CLI refusal vs. non-UTF-8.
- **Rebinding:** a recheck of another initial receipt is refused, plus 20 rebinding mutations of the real producer output.
- **Real live receipt:** accepted as fresh-initial input.

### Strictness of the harnesses (prepared)

- **`run-tests.sh`:**
  - refuses an existing `logs/run`;
  - verifies `SHA256SUMS` first;
  - runs **every** suite with stdin `/dev/null` and a timeout.
- **It exits 0 only if:**
  - each Python suite has rc 0 and a final bare `OK` (`OK (skipped=…)` or any `FAILED (…)` fails);
  - the node TAP log is clean per `taplog.py baseline`.
- **Logs:** per-suite logs go to `logs/run/`.
- **`mutants.sh` (revised after root run 2215; harness-only change):**
  - **2215 failure:** the node baseline could not resolve `@noble/hashes`, because `mutants.sh` did not export `ANCHOR_DEPS_ROOT` as `run-tests.sh` does. The Python baseline (33 + 2 + 1) had passed; no mutant ran. Logs are kept: `../../logs/root-a1-a2-mutants-2215.*` and `logs/mutants/20261025T221414Z/`.
  - **Fix:** the script exports the same `ANCHOR_DEPS_ROOT` default and brings `lo` up, like `run-tests.sh`. Each run uses a new `logs/mutants/<UTC>-<pid>/` and refuses to reuse one.
  - **Inputs:** `SHA256SUMS` must verify, and its own sha is logged.
  - **Preflight, no tests:** the 33 names must equal `EXPECTED` and be unique. Every anchor must match its pristine file exactly once and differ from its replacement. Every Python mutant must name at least 1 test.
  - **Baseline, ONCE:**
    - `test_a2a4` via `mutrun.py all-pass`: 33 tests, all passing, 0 errors/skips, and every mapped test ID among them;
    - writer and manifest suites: rc 0 and a bare `OK`;
    - node: clean per `taplog.py`, with exactly 8 tests.
  - **25 Python mutants:** each runs **only its mapped test(s)** (`mutrun.py kill`). It counts as killed only if every mapped test loaded, ran once and **failed through assertions** (including failing subTests). Any error (fixture, import or non-assertion exception), skip, expected failure, unexpected success, missing test or timeout is **not** a kill.
  - **8 JS mutants:** the full node suite (8 tests) runs on a mutated copy of `a1-gate.mjs`, judged by `taplog.py killed` (same test count, every failure an `ERR_ASSERTION`).
  - **Exit:** 0 only if all 33 are killed.
  - **Mapping** (25 mutants → 20 distinct tests; each traced to the specific case in that test which the guard decides):

    | Mutant | Test(s) |
    |---|---|
    | merkle-from-n | Gates.test_plan_ok_lists_chunked_unwind_to_exactly_n_and_full_merkle_from_zero |
    | no-empty-read-check | Steps.test_a2_authenticates_the_real_header_and_refuses_forgery_or_missing |
    | no-open-gaps | Steps.test_bytecode_step_binds_this_db_and_release_still_refuses_while_the_gap_is_open |
    | no-a1-age | Gates.test_stale_or_foreign_a1_is_refused, FreshInitialTrust.test_the_real_live_initial_receipt_passes_only_while_fresh |
    | no-journal-guard | Gates.test_an_interrupted_mutation_blocks_every_later_step |
    | no-blake3-list-check | Gates.test_download_receipt_binds_manifest_unit_marker_and_datadir |
    | no-checkpoints-flag | Steps.test_a4_full_rebuild_matches_and_a_mismatch_refuses |
    | no-final-profile-check, no-exact-selection | Gates.test_selection_is_exactly_the_pinned_manifest_and_final_profile |
    | db-before-units | Gates.test_units_and_openers_are_checked_before_any_db_access |
    | no-v2-enforcement | Gates.test_units_and_openers_are_checked_before_any_db_access (its a2 `v1_layout` case). **Not** `test_prerequisites_fail_closed`: `plan` has a second v2 check, so that test cannot detect this mutant. |
    | no-orphan-reap, no-post-exit-size | Gates.test_post_exit_size_orphans_and_mutation_stdout |
    | no-recheck-sha, no-initial-pin | Recheck.test_initial_receipt_pin_and_file_trust |
    | no-run-record, no-run-window, exit-bool-accepted, no-same-run-dir | Recheck.test_run_record_provenance |
    | no-trusted-owner, follow-symlink | FreshInitialTrust.test_a1_file_trust, Recheck.test_initial_receipt_pin_and_file_trust |
    | no-release-binding | Recheck.test_full_flow_binds_release_to_the_a2_receipt |
    | accept-advanced-fresh | Gates.test_an_advanced_anchor_refuses_release_with_the_documented_code, Recheck.test_the_original_game_passes_after_the_latest_anchor_advanced_and_n_never_moves |
    | no-l1-consistency | FreshInitialTrust.test_l1_timing_is_bounded_and_consistent, Recheck.test_freshness_planned_anchor_and_mainnet_pins |
    | no-gate-pin | FreshInitialTrust.test_gate_and_recheck_pins_match_the_files |

    The mapping is a reasoned prediction, **not yet observed**. A wrong entry yields `survived` or `invalid` and a nonzero exit; it is never counted as a kill.

### Root commands (later; foreground; shared queue; no background jobs)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/a1-a2-integration
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/tests.guard -- unshare -rn sh run-tests.sh > logs/tests.out 2>&1; echo $? > logs/tests.rc
# only if tests.rc == 0 and tests.out ends "RUN-TESTS rc=0":
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/mutants.guard -- unshare -rn bash mutants.sh > logs/mutants.out 2>&1; echo $? > logs/mutants.rc
```

- **Accept tests** only with `RUN-TESTS rc=0` (expected: Python 33 + writer + manifest suites `OK`; node 8 tests, `# fail 0`).
- **Accept mutants** only with `MUTANTS rc=0` (33/33 killed).
- **rc 98** (queue not started) is not a result.

### Input manifest

| Input | sha256 |
|---|---|
| Stage files | `SHA256SUMS` (checked by both harnesses) |
| Frozen sources copied | `frozen-sources.sha256` |
| Initial A1 receipt (`live-1958/a1-evidence.json`) | `b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c` (= `A1_INITIAL_SHA256`) |
| Live recheck `l1-a1-recheck-retry-2152/recheck.json` (candidate `a1RecheckSha256` once root installs it) | `3a996d96a5cddc32ed8a29695c36199180f746bb5923517b7df6572cf0f8d959` |
| Live `run-result.json` | `f5c680d28cbdca49d656691cda07e0b65a4af92f3cfc16596ddf96ae28e1d24c` |
| Live `recheck-config.json` | `d768160700882c805b0ce370e1a716fa7a0f73a7db08c9c01691a931e70c38da` |

**Note:** that live recheck is already older than the maximum `a1MaxAgeSec` (3600 s), so any later `a2`/`release` needs a **new** recheck run, review and pin (risk 4). It proves the shape and the original-game retention, not freshness for a future gate.

## Exact change to frozen A2 (for root to apply after review; NOT applied)

1. `patch -d finality-stage/a2-a4-execution -p1 < frozen-a2.diff` (this changes `a2a4.py`, `mutants.sh`, `a2a4-config.example.json` and `test/test_a2a4.py`).
2. Copy these new files, byte-identical, into `a2-a4-execution/`:
   - `a1gate/` (3 files);
   - `taplog.py`;
   - `run-tests.sh`;
   - `a2a4-config.recheck.example.json`;
   - `test/a1-gate.test.mjs`;
   - `test/deps.mjs`;
   - `test/vendor/`;
   - `test/fixtures/`.
3. Re-run that dir's suites and mutants.

## Remaining risks / unresolved trust and API issues (reported, not bypassed)

1. **The recheck receipt is not hash-bound by its producer.** `run-recheck.py` (frozen) records `inputPins` but **not** `sha256(recheck.json)`. The binding here is: same output dir, `at` within the run window, and root-reviewed `a1RecheckSha256`.
   - Proposed for a1-original-game (not applied): add `r['recheckSha256'] = sha256(OUT/'recheck.json')` after the node run; then the gate requires equality.
   - Separately, `inputPins` hashes the files before node loads them (a small TOCTOU); they are root-owned files.
2. **No Helios provenance in the run record.** The run record does not bind:
   - the Helios binary, its checkpoint, or the `l1_authority` config sha;
   - `heliosStatus` is recorded but its shape is not pinned here, so it is unchecked.

   Proposed: record the launcher config sha and the binary sha in `run-result.json`.
3. **Host → guest transfer.** A1 runs on the host and writes into `outputs/…`, owned by the user (not uid 0). `a2a4.py` runs in the RPC guest with `TRUSTED_UID = 0`.
   - Root must install the reviewed run dir into the guest root-owned (for example `install -o root -g root -m 0644`), keeping the `recheck.json`/`run-result.json` names together.
   - The sha pins (`a1InitialSha256`, `a1RecheckSha256`) carry the integrity of those two files across the transfer; the run record is only root-owned.
   - Host/guest clock skew affects the `a1MaxAgeSec` and window checks. These checks use the receipt's own `at` and the guest clock.
4. **Operational window.**
   - Each `a2` and each `release` needs a recheck ≤ `a1MaxAgeSec` (max 3600 s) old at use, so root must run, review, pin, transfer and run within that window.
   - a3/a4 do not re-gate A1 (frozen design), so an eligibility loss between A2 and release is caught at release, after the in-place mutation.
5. **The config is the pin anchor but is not ownership-checked.** `load_config` runs outside the refusal handler in `main`. Proposed: a root-owned config check, with `main`'s error path adjusted.
6. **`anchorModule`/`depsRoot` (used by A2 `authenticate`) are not hash-pinned** in frozen `a2a4.py`. This is out of this change's scope; proposed: pin like `A1_GATE_PINS`.
7. **The initial receipt pins are taken as the address set.**
   - If a future initial receipt pins more than portal/ASR/game, `runRecheck` proves only those 3, and this gate refuses (`recheck_pins`). That is conservative and documented.
   - The recheck does not record `pinSlots` or its `maxFinalizedAgeSec`; the gate re-derives the slot set from the initial receipt and applies its own 1800 s age bound.
8. **Untested code.** Every test and mutant here is unexecuted. Root's first run may expose fixture or logic defects; targeted repairs follow root's results.
9. **The frozen suite state is unknown here.** The copied `a2a4.py` `85b4fc92…` is newer than root's failing `root-unit-2132` (rc 1, 4 failures, against an older message). Whether the frozen baseline passes now is root's pending result. These tests inherit it.
