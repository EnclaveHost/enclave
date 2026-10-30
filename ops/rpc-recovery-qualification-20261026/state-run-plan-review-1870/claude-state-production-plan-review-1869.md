# 1869: correction of plan 1867 against root findings 1868 and the actual local code (SOURCE-ONLY; an implementation plan, NOT an implementation)

**What I read:**
- `composite-mdbx-validation-stage/r6/composite_session.py`: `classify`, `Session.prepare`/`expose`/`use`, `main`;
- `composite-mdbx-validation-stage/r10/memory_gate.py`: `memory_classify`, `runtime`, `JOB_CHECKS`, `evidence`;
- `composite-mdbx-validation-stage/r10/jobs/{final-status.sh, finish.sh, job-receipt.py, root-composite-validate.sh, tests.sh}`;
- `base-state-readonly-stage/r11/{src/main.rs` report, `jobs/positive.sh`, `jobs/fixtures.sh`, `jobs/guard-tests.sh`, `jobs/bsro_gate.py` `qualified`/`verify_binaries`};
- `jobs/root-base-deleted-metadata-1502.py` (`aaa7c476…`);
- `logs/cmv-r10-tests.{rc,out}`.

**Not done:** tests, builds, queue jobs, mounts, network, data/part/backup reads, source changes or commits. Frozen stages and the queued r10/r11 tests are untouched.

**What I do NOT claim:**
- that the validator or helper compiles;
- that any r11 positive (26) or fixtures (6) run exists. **None exists.**
- that any production structural or state run exists;
- that any acceptance prerequisite is met. Every unknown below is **unresolved**, and nothing here is goal-complete.

**Recorded evidence:** `logs/cmv-r10-tests.rc` = `0`, and `cmv-r10-tests.out` ends with `## cmv-r10-tests rc=0` and names its receipt `composite-mdbx-validation-stage/r10/runs/tests-20261027T053259Z-2813238/receipt.json`. This agrees with root's HANDOFF that the 16 tests passed. I did not open that receipt.

## 0. Corrections to 1867 (each is a concrete error in 1867)

| 1867 | wrong because (code) | corrected in |
|---|---|---|
| §1 "lifecycle reuse as-is, except the validator argv" | `Session.use` (`composite_session.py:334-373`) hard-codes the argv **and** the report path `mdbx-report.json` (`:337`), and reads and hashes only that file (`:362-368`) | §2.1 |
| §2A(c) "set the r6 exec slot internally" | `a.fixture_exec` is the fixture path; `prepare` refuses it for production (`:211`) and the r10 `runtime` refuses it (`memory_gate.py:460-462`). Setting it internally bypasses the production/fixture separation | §2.1 (rejected) |
| §2A(b) "new args `--helper-dir`/`--static-files`" (implicitly passed to r6) | r6 `main` parses `rest` with its own `argparse` (`:475-482`), so unknown args are a parse error. The state args must be **runtime-own** (before `--`) | §2.2 |
| §2A(d) "`final-status.sh` keeps a nonzero rc; 35 usable" | `final-status.sh:14` preserves ANY nonzero rc **even if the evidence fails**, so 35 would survive missing snapshots, leftover mounts or processes. `job-receipt.py:65-66` and `evidence` (`memory_gate.py:574-584`) accept only rc 0 + `CLEAN` | §2.4 |
| §2A(d) report checks (format/v2/no-full/ABSENT/frontier) | incomplete: no root equality, trie, cached-walk, checkpoint, plain-count or provenance invariants | §2.3 |
| §2 pins "passed positive 26/26 and fixtures 6/6 receipts" | **no such receipts are produced.** `positive.sh` writes per-case text, `binaries.sha256` and a stdout summary (`:26,157`); `fixtures.sh` writes stdout only and deletes its per-case outputs (`:31-32`) | §3 |
| §5 step 8 "optionally first: the r10 structural `mdbx_chk` run" | the structural check is **REQUIRED** for recovery acceptance and must reach final 0 CLEAN before any original reset (root 1868 #5). The cmv-r10 tests already passed (above); §5 step 5's "not verified" was wrong | §5 |
| §3 "debugfs as in 1502" | 1502 runs `nbdfuse -r raw [ qemu-nbd -r -f qcow2 … ]` and `debugfs … raw` at offset 0. Its cleanup (`:27-30`) unmounts and then `proc.kill()`s **only nbdfuse**: no owned group, no reap of `qemu-nbd`, no held/identity checks. The compact image's filesystem offset is unknown | §4 |

## 1. Can tiny changes in a copied composite revision reuse the lifecycle without duplication bugs?
**Yes for the state exec, with one seam and four targeted replacements.** No new framework is needed, but the duplication risks are concrete and must be tested.

**Known duplication hazards in a copy of r10:**
- **Absolute self-paths:** `finish.sh:8`, `final-status.sh:9` and `root-composite-validate.sh:24` hard-code `R10=…/r10`. A copy that keeps any of them runs r10's `final-status.sh` (which preserves 35 regardless of evidence) or r10's `evidence` (format r10, rc 0 only). **That is exactly 1868 #1.**
- **The runtime pin:** `runtime` loads r6 by pin (`load_exact("r6Runtime", …)`, `memory_gate.py:466`). A changed session file needs a new pin, not r6's.
- **The format strings** in `job-receipt.py:68` and `evidence:579` must change together.
- **The peer-snapshot exclusion in `collect-evidence.sh`** (r6 `runs`, via `EVID_S6`) must match the run dir the new session actually uses. Otherwise our own mount looks like a peer change, which is a false failure (fail-closed, but it blocks a valid run).

**Header extraction is NOT a tiny change.** Its "view" is the compact qcow2, not the 265-part VMDK. `prepare` (`load_view`/`recheck`), `expose` (`onlyMdbxDat`, `logicalSize`) and `held` (`check-held` on the 265 inodes) all differ (§4).

## 2. The state runner: a new composite revision (r11) with minimal deltas

### 2.1 One seam in a new revision of `composite_session.py` (r6 stays frozen)
**The change:** factor `Session.use` (`:334-373`) into `use()` plus `exec_plan(self) -> (argv, limit, report_path)`.
- **The default `exec_plan`** returns exactly r6's values: `fixture_exec`, or the pinned `mdbx_check.py` argv with `<run_dir>/mdbx-report.json`.
- **`use()`** reads, hashes and parses `report_path` instead of the literal (`:337,362-368`), and records `receipt["reportPath"]`.
- **Nothing else changes.** `OUTPUT_NAMES` (`:66`) gains `"state-report.json"`, so a reused run dir is refused by `prepare` (`:204-206`).

**The state subclass** (in `state_gate.py`) overrides **only** `exec_plan`:
- it refuses unless `a.expect_kind == "production"` and `a.fixture_exec is None`;
- it returns `[<helper-dir>/base-state-readonly, "--db", self.db, "--static-files", <SF>, "--rocksdb", <run_dir>/rocksdb-absent, "--out", <run_dir>/state-report.json, "--plain-hashed"]`;
- every element is computed from the gate-verified pins (§2.2). There is **no CLI or command override.**
- **Immediately before** it returns, it:
  - re-hashes the helper binary (== build receipt);
  - checks `rocksdb-absent` is absent (`lstat` ENOENT) and `state-report.json` does not exist;
  - records the SF files' `(dev, ino, size, mtime, ctime, sha256)`.
- **After `use()`**, a post-step repeats the helper hash, the SF identities and the `rocksdb-absent` absence check. It stores them in `receipt["stateProvenance"]`, and **any mismatch forces `post_ok = False`**, which `main` turns into VOID 8.

**Rejected alternatives:**
- setting `a.fixture_exec` (1868 #2);
- overriding `use()` by copying its 40 lines: the lifecycle would be duplicated, and a future fix to one copy would silently diverge.

### 2.2 `state_gate.py` = r10 `memory_gate.py` with these function deltas only
- **`gate` (`:279-324`):**
  - new required args `--helper-dir` and `--static-files`, plus the existing view/run args;
  - new qualification checks:
    - r11 bsro SUMS `246ff06b…`;
    - `bsro_gate.qualified()`-style passing guard and ns receipts;
    - a `verify_binaries(helper_dir)`-equivalent check against a verified build receipt;
    - the §3 fixture receipts;
    - the §4 extraction receipt;
  - these args are forwarded into the runtime's own args **before `--`** (`argv2`, `:317`).
- **`runtime` (`:454-480`):**
  - parses `--helper-dir`/`--static-files` from its own args and re-verifies the pins;
  - keeps the production-only refusal (`:460-462`);
  - loads the **new** session pin;
  - installs `make_memory_session` over the state subclass, and `C.classify = memory_classify(state_classify, …)`.
- **`state_classify`** (replaces r6 `classify`, `:125-147`; same signature, because r6 `main:532` calls it that way):
  1. `not post_ok` → VOID 8.
  2. exec timed out / leftovers / escaped / group not empty / orphans → INCONCLUSIVE 7. These are the same conditions as r6 `:129-131`, re-stated, so each needs a regression test.
  3. A missing report, or a report that fails `state_report_ok` (§2.3), → INCONCLUSIVE 7.
  4. Helper rc 3 → STATE-REFUSED 30; helper rc 4 with a report → STATE-FAILED 34; helper rc 5 with a valid report → STATE-PARTIAL-V2 35.
  5. Anything else, including rc 0, 1, 101 or a signal → INCONCLUSIVE 7.
- **`memory_classify` (`:436-451`):** the downgrade set becomes `{"STATE-PARTIAL-V2", "STATE-FAILED"}` (from `{"CLEAN","PROBLEMS"}`). Dirty or unreadable OOM counters → 7.
- **Lifecycle precedence is unchanged:** in r6 `main` (`:520-531`), CLEANUP-INCOMPLETE 4, then CANCELLED 5 (including the soft stop), then REFUSED 3 / INCONCLUSIVE 7 are decided **before** classify. So timeout, cancel, cleanup and post-use failures always override any report.
- **`JOB_CHECKS`/`evidence` (`:571-584`)** become `STATE_JOB_CHECKS`/`state_evidence`:
  - format `state-production-job-receipt/r1`;
  - `rc == 35`, `jrc == 0`, `r["rc"] == 35`, `outcome == "STATE-PARTIAL-V2"`;
  - all checks true (§2.4).

### 2.3 `state_report_ok(report)`: a pure function, also re-run by the job receipt
**Shape and the pinned helper's constants:**
- The exact top-level key set of r11 `main.rs:260-285`. Missing or extra keys, or a wrong JSON type for any checked field, fail.
- `format == "base-state-readonly/r11"`.
- `storageSettingsPresent is True` and `storageSettings == {"storage_v2": true}`.
- `trieKeyAdapter == "PackedKeyAdapter"`.
- `rocksdbOpened is False` and `rocksdbCurrentPresent is False`.
- `rocksdbClassification` starts with `"ABSENT:"`. PRESENT is impossible here because the runner never supplies a RocksDB dir.
- `historyIndexCheckpoints == {"TransactionLookup":0,"IndexAccountHistory":0,"IndexStorageHistory":0}`.
- `unwindMarkerPresent is False`; `finishFrontier == "none"`; `finishUnitCheckpoint` ∈ {`"none"`, `"Finish(partial_state_trie: None)"`}.
- `merkleExecuteProgressBytes` ∈ {null, 0}.
- `historyIndices`, `historyIntegrity`, `acceptance` and `exitMeaning` equal the r11 constant strings.

**Identity and the 5 checkpoints:**
- `finish` is an int;
- `checkpointsCoherent is True`;
- `checkpoints[s] == finish` for Execution, AccountHashing, StorageHashing, MerkleExecute and Finish, **re-checked here, not trusted from the flag**;
- `tipHeader.number == finish`;
- `tipHeader.hash`, `stateRoot` and `parentHash` match `^0x[0-9a-f]{64}$`;
- `withdrawalsRoot` is null or matches the same pattern.

**Roots:**
- `stateRoot.computed == stateRoot.fromHashedOnly == tipHeader.stateRoot`;
- `matchesHeader is True`;
- `cachedWalkEqualsFromHashedOnly is True` and `cachedWalk == computed`.

**Trie cache:** `trieCache.status == "PASS"`, with `accountInconsistencies == 0` and `storageInconsistencies == 0`. The key set is exact per `main.rs:123`.

**Plain tables:** `plainVsHashed.status == "NOT_APPLICABLE_V2"` and `plainAccountsEntries == plainStorageEntries == 0`.

**No full claim:** `fullStateIntegrity is False`. The report must say PARTIAL, never full.

**Not checked by the report, by design:** the canonical status of the header.

### 2.4 Final evidence gating (1868 #1): copies of `job-receipt.py`, `final-status.sh` and `finish.sh`, with self-paths
**`state-job-receipt.py`:** the same `status_ok`/snapshot logic (`job-receipt.py:21-46`). Its `checks` are:
- `rc35`, and `partial` (`outcome == "STATE-PARTIAL-V2"`);
- `cleanupComplete`, `snapshotsOk`, `peersUnchanged`, `noMountLeft`, `noProcessLeft`;
- `memoryClean`: `memory.memoryDirty is False` **and** no `softStop`;
- `reportBound`:
  - `receipt.reportPath == <O>/session/state-report.json`;
  - that path is the `--out` element of `receipt.children.exec.argv`;
  - `sha256(file) == receipt.reportSha256`;
  - the file is a regular non-symlink of at most 32 MiB;
- `reportInvariants`: `state_report_ok` of that file, re-run, imported from `state_gate.py` by pinned sha;
- `provenanceBound`:
  - the helper sha before and after == the build receipt's sha;
  - the SF identities and shas before == after == the extraction receipt;
  - `rocksdb-absent` absent before and after;
  - the r11 SUMS and fixture receipts recorded by sha.

**`state-final-status.sh`:**

| runtime rc | evidence | final |
|---|---|---|
| 35 | passes | 35 |
| 35 | fails | 10 + `FINAL-EVIDENCE-FAILED` |
| 0 | any | 10 (never valid for state) |
| any other nonzero (3, 4, 5, 7, 8, 30, 34, 124, 137) | any | preserved |
| non-numeric | any | 10 |

**All wrappers must agree.** The job script, the README and the `q-exit-status` consumers treat **only 35** as the usable outcome. It means "self-consistent PARTIAL v2 state at Finish", never canonical or full.

## 3. Compiled fixture receipts (1868 #4): an authenticated receipt without touching frozen r11
**The wrapper:** `jobs/bsro-fixture-qualify.sh` in the new composite revision. Root runs it as `unshare -Urnm bash … positive|fixtures OUTDIR`, because `positive.sh` needs the namespace and mounts. It:
1. checks `sha256sum -c` of the r11 SUMS before **and** after the run;
2. runs `bsro_gate.py verify-binaries OUTDIR` itself (rc 0);
3. runs the unchanged r11 `positive.sh OUTDIR` (or `fixtures.sh OUTDIR/base-state-readonly`) as a child with `timeout`, capturing stdout+stderr with a 1 MiB bound;
4. writes `receipt.json` (format `bsro-fixture-receipt/r1`) to its own new `runs/` dir.

**The receipt records:**
- the child rc, and `timedOut`;
- the r11 SUMS sha, and the script's sha as listed in the r11 SUMS;
- the build receipt path and sha;
- the `binaries.sha256` written by `positive.sh` (`:26`), compared to the build receipt's `guard.binaries[*].sha256`;
- for **positive**: exactly 26 lines `case <label>: PASS`, whose label set equals the 26 labels pinned in the wrapper (copied from `positive.sh:128-154`); zero lines containing `FAIL`; the final `## runs=26 failed=0` and `## bsro-r11-positive rc=0`;
- for **fixtures**: exactly 6 `case <name> rc=… PASS` lines with the pinned names; `## fixtures failed=0`;
- `pass` true only if all of the above hold and the rc is 0.

**The state `gate` accepts only those receipts,** bound to this composite revision's SUMS and to the same binary shas. No root-created summary or queue `.rc` file substitutes for them.

## 4. Header extraction (1868 #6): an owned, bound lifecycle; a separate reviewed piece, NOT tiny
**Input binding:**
- **The compact qcow2:** a pinned path; `(dev, ino, size, mtime, ctime)` recorded before and after; opened read-only only via `qemu-nbd --read-only -f qcow2`.
- **The saved sha `a3b00e5f…` is provenance, not a fresh verification.** A fresh full sha256 (≈120.9 GB read) needs its own authorization and resource gate. Without it, the extraction receipt must say `compactHashFreshlyVerified: false`, and acceptance treats that as **unresolved**.

**Lifecycle:** a session subclass in the new revision reuses r6's `spawn`/`bind_child`/`end_child`/`cleanup`/`reap_adopted` and owned groups. It overrides only:
- **`prepare`:** the pinned qcow2 identity instead of `load_view`;
- **`expose`:** the qcow2 `--image-opts`; it checks that the FUSE dir holds only the raw file, is ST_RDONLY, has the qcow2 virtual size from saved provenance, and refuses `O_WRONLY`;
- **`held`:** `qemu-nbd` holds exactly the qcow2 inode, `O_RDONLY`, before and after;
- **`exec_plan`:** the pinned `debugfs` (sha), **no `-w`**, `-f <our cmd file>`. The file contains `stat <path>` and `dump <path> <dest>` for exactly the 6 header files.

**Output:** a NEW 0700 dest dir on /vm, under `RLIMIT_FSIZE` ≥ 318,751,407 B and < 512 MiB. The /vm floor is checked first.

**The extraction receipt binds:**
- each file's size == the reconciled inventory size;
- each file's sha256;
- debugfs's `stat` inode, size and mtime per path, compared to the inventory where it records them;
- the qcow2 identity before == after;
- the dest dir identity and the file modes after `chmod 0444` / `0555`.

**Do not reuse 1502's process handling** (`:17-30`).

**The filesystem offset (unresolved):**
- 1502's offset-0 use applied to the original, not the compact image.
- The extraction must refuse unless either saved provenance states the compact image's ext4 offset, or a bounded, gated check passes: `debugfs -R stats` over the mapped raw device, which reads the superblock only, with its UUID and block count matching saved provenance.
- **Neither has been read in this task.**

## 5. Order: every step needs root's actual PASS; none is claimed here
1. All 265 parts CONFIRMED-verified.
2. r11 guard tests (10 + 6 + 16) and ns tests (5) PASS (queued; not claimed).
3. The r11 build plus a verified build receipt.
4. The §3 wrapper receipts: positive 26/26 and fixtures 6/6 (they do not exist yet).
5. **REQUIRED: the cmv-r10 production structural run with final 0 CLEAN.** Its 16 tests are recorded as passed; the production run is not claimed. It must succeed before any original reset; running it **before** the state run is recommended.
6. The new composite revision (§2), with its review and tests PASS.
7. The §4 extraction, with its review, tests and receipt.
8. The state run: final 35, or anything else is not usable.
9. The G8 items from 1867 §6 (unchanged; still needs the missing M ≥ Finish anchor input).

## 6. Focused regressions for the new revision (synthetic and test-only; no production data)
1. **Lifecycle identity:** `ast.dump` of every function and class in the new `composite_session.py` equals r6's, except `Session.use` and `Session.exec_plan`. `OUTPUT_NAMES` is r6's plus `"state-report.json"`.
2. **The default `exec_plan`** returns r6's exact argv, limit and `mdbx-report.json`. The r6 test suite passes unchanged against the new file.
3. **The state subclass** refuses `fixture_exec`, a fixture kind, a helper sha mismatch, an existing `rocksdb-absent`, and an existing `state-report.json`. No CLI path can change any argv element.
4. **Runtime and gate refusals:**
   - `runtime` rejects `--fixture-exec` and passes no unknown args into r6 `main`;
   - `gate` refuses each missing or mismatched pin: SUMS, guard/ns, build, positive, fixtures, extraction.
5. **`state_report_ok`** is checked against a golden valid report, plus one mutation per invariant in §2.3: each key missing or extra, a wrong type, each root or checkpoint mismatch, nonzero inconsistencies, a PRESENT classification, a non-zero index, a frontier, a progress row, `fullStateIntegrity` true, and a bad hash format.
6. **`state_classify` table:** post_ok false → 8; each exec-leftover flag → 7; rc 3 → 30; rc 4 → 34; rc 5 valid → 35; rc 5 invalid → 7; rc 0/1/101/−9 → 7; a missing or unparseable report → 7. Through `memory_classify`, dirty counters turn 35 or 34 into 7.
7. **`main` precedence:** cleanup-incomplete → 4, a soft stop → 5, and refused → 3/7, each with a valid 35-shaped report present.
8. **Post-exec provenance:** the helper hash changes, an SF file's ctime or sha changes, or `rocksdb-absent` appears → `post_ok` false → 8.
9. **Final evidence** (the test-16 pattern, with the real `finish.sh` copy): runtime 35 plus each injected evidence fault gives final 10 and the mark. The faults are:
   - a bad status file or an after-collection failure;
   - a leftover mount or process;
   - memory dirty;
   - a report sha mismatch, a report path not equal to the `--out` argv, or invariants failing on re-check.

   Healthy evidence gives 35. Runtime 0 gives 10. Runtime 30/34/7 is preserved.
10. **Self-path audit:** every absolute stage path in the new revision's files is either the revision itself or a pinned frozen dependency (r6 view stage, r4 fixture, bsro r11). There are no `…/r10/` references, and the `collect-evidence` exclusion matches the new run-dir root.
11. **The §3 wrapper,** fed synthetic captured outputs: 25 PASS lines, a duplicate label, an extra FAIL line, `failed=1`, a binaries mismatch, a SUMS change, or a timeout each give `pass:false`. The exact 26/6 output gives `pass:true`.
12. **§4 extraction** (fixture qcow2 only): a size or sha mismatch, a missing file, a write attempt, a held-inode mismatch, an image identity change, or a non-owned leftover each refuse. The `debugfs` argv never contains `-w`.

## 7. Unresolved (not filled)
- **Build and fixture status:**
  - whether r11 (and the new revision) compile;
  - whether positive 26/26 and fixtures 6/6 pass. Their receipts do not exist.
- **Production status:** the cmv-r10 production structural run and its final 0 are not observed.
- **Real DB values:** the Finish, Metadata, index checkpoints and progress rows are unread.
- **Header-only static files:** whether `StaticFileProvider::read_only` accepts a dir holding only the two header segments that start at 52.5M. No fixture covers this; a failure is a refusal (30).
- **The compact image:** its ext4 offset and its fresh hash (§4).
- **Memory:** VmRSS includes file-backed mmap pages. A full hashed-state + Verifier scan may hit the 3840 MiB tree-RSS soft stop (CANCELLED 5); the r4 figures measured only `mdbx_chk`. This is unmeasured.
- **Runtime duration and `MAX_HOURS`.**
- **The key set of `trieCache`:** this report states it as exact per `main.rs:123`; the implementer must copy it from source.
