# Capture import-safety fix — result (PREPARED; source only; NOTHING run by Claude)

No tests, builds, queue, network, live changes or commits. r2, r3 (root PASS 45), reanchor r4 and r5 are frozen and verified unchanged
(their `SHA256SUMS`/`MANIFEST.sha256` all check).

## Evidence (root's actual logs)
- **`logs/root-reanchor-r5-0305.out`** (rc 1): 19 ran, 17 PASS, 2 FAIL.
  - Both failures are in `new_recheck → capture('recheck-capture')`, with the refusal `file_set: unexpected or missing files: ['code/__pycache__/l1_authority.cpython-314.pyc']`.
  - Failing tests: `test_capture_refusals_hold_replay_wrong_initial_tamper_pin_stale_ledger` and `test_newer_anchor_recovers_through_real_initial_and_recheck_captures`.
- **`logs/root-a1-capture-r3-0306.out`** (rc 0): r3 passes 45. Its `src/a1_capture.py` sha256 is `663038c89c9f3767eb441082700c0a08bc8aea7e48643b32c80bddff64c2a3ad`, which I confirmed.

## Root cause
- **The loader:** `capture()` loads the bound copy `stage/code/l1_authority.py` through `importlib`'s file loader (`load_module`: `spec_from_file_location` + `exec_module`). That loader writes `code/__pycache__/l1_authority.cpython-314.pyc` **inside the capture** whenever the caller has bytecode enabled.
- **Why it only surfaced in r5:** the reanchor harness is an ordinary caller (`python3 -E -s`). r2's and r3's own runners pass `-B`, which masked the defect.
- **Why verify refused:** the strict `file_set` check correctly refused the extra file when the recheck-capture verified its initial capture.

## Fix: minimal, no loader framework (3 hunks; `a1-capture-binding-stage/r4/r3-to-r4-a1_capture.patch`, 17 changed lines)
- **New loader:** `load_pinned(b, path, name, want)` replaces `load_module`.
  - It re-checks `sha256(b) == pins.l1_authority`; otherwise it refuses `l1_authority_pin`.
  - It runs `compile(b, path, 'exec', dont_inherit=True)` and executes the result into a fresh `types.ModuleType('l1_authority_copy')`, with `__file__` and `ModuleSpec(origin=path)` set and no `sys.modules` entry.
- **Call site:** it passes **the bytes that passed the pin check**, so the path is not re-read and no cache is written.
- **Caller state:** the caller's `sys.dont_write_bytecode` and `sys.pycache_prefix` are never read or changed.
- **Unchanged:** every pin, the runtime policy, r3's limits, the record format, and the `file_set` strictness. No cache is whitelisted.
- **Composition:** the fix is applied to **r4**, which is r3 plus these hunks. The same hunks against r2 are kept as a record in `capture-import-safety-stage/` (`r2-import-fix.patch`; the +/- lines are identical). That stage has no runner by design, because it lacks r3's limits.

## Regression (`tests/test_import_safety.py`, 7 tests; sha256 `32af2dfa…284e`)
Every test sets an ordinary caller (`dont_write_bytecode=False`, `pycache_prefix=None`) and restores the caller's state.
1. **Negative control:** r2/r3's loader, verbatim, writes a `.pyc` under this caller.
2. **Initial capture:** clean (no bytecode; the file set is exactly the bound files plus records), and verifies.
3. **recheck-capture of a fresh initial:** this is r5's exact failure path. Both captures are clean, and the consumer's verify binds the initial.
4. **Plain recheck:** clean, and verifies.
5. **Caller with bytecode disabled:** its flag is kept.
6. **Planted `.pyc`:** a planted `code/__pycache__/*.pyc` still refuses with `file_set`.
7. **`load_pinned` semantics:** correct name, file and origin; not registered; nothing written; bytes changed on disk after hashing are not executed; unpinned bytes refuse.

## Root runner (exact): `a1-capture-binding-stage/r4/jobs/root-capture-tests.sh` (sha256 `0f4971ce…272c`)
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r4
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```
- **Suites:**
  - `capture`: r3's 45 tests, byte-identical. Exactly 45.
  - `import-safety`: exactly 7.
- **How they run:** both use `python3 -I` with **no `-B`**, under `env -i`, in a private copy `$OUT/run` that is checked against `SHA256SUMS` first.
- **PASS requires:**
  - each suite shows `Ran n` with a final `OK`, no skip, and rc 0;
  - the copy holds `src/__pycache__` afterwards, which proves bytecode really was enabled;
  - the stage stays unchanged and cache-free;
  - the HOLD flags are False.

## Manifest
- **r4 contents:** `a1-capture-binding-stage/r4/SHA256SUMS` sha256 **`ca8e5b151545cc5acede89e90f5d1591a59b2d616c5210526699989ba84f3484`**, 27 files.
- **Changed vs r3:** only `src/a1_capture.py`, the runner, and the new files: `tests/test_import_safety.py`, `R4-CHANGES.md`, `r3-to-r4-a1_capture.patch`. All other r3 files are byte-identical, which I checked.
- **New pin:** r4 `src/a1_capture.py` sha256 **`db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20`**.
- **Record stage:** `capture-import-safety-stage/SHA256SUMS` sha256 `a184d200…e525`.

## Notes
- **Docstring:** line 2 of `src/a1_capture.py` still reads "r3". I left it as is to keep the hunks minimal; `R4-CHANGES.md` is authoritative.
- **Status:** NOT verified by running. PASS only if root's run passes. Custody v2 stays REFUSED; lease consumers stay on HOLD; A1 capture stays on HOLD. No mainnet proof is claimed.
