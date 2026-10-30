# a1-capture-binding-stage/r4 (PREPARED; source only; NOT run by Claude; NOT enabled)

`README.md`, `R2-CHANGES.md` and `R3-CHANGES.md` are copied unchanged from r3. Where they differ, this file supersedes them.

**Base:** r3, FROZEN.
- Root ran it: `logs/root-a1-capture-r3-0306.out`, rc 0, **45 tests PASS**.
- r3 `src/a1_capture.py` sha256 is `663038c89c9f3767eb441082700c0a08bc8aea7e48643b32c80bddff64c2a3ad`.
- r3 `SHA256SUMS` sha256 is `2b8d4ffe…6ac2`.
- r2, r3, and the reanchor stages r4/r5 are untouched.

## The defect (root's actual run, `logs/root-reanchor-r5-0305.out`: 19 ran, 17 PASS, 2 FAIL)

Both failing tests did the same thing. The recheck-capture verified a fresh initial capture and got this refusal:
`file_set: unexpected or missing files: ['code/__pycache__/l1_authority.cpython-314.pyc']`.

**Cause:**
- r2 and r3 load the bound copy `code/l1_authority.py` with `importlib`'s file loader (`spec_from_file_location` + `exec_module`). That loader writes `__pycache__/*.pyc` next to the file unless the **caller** has disabled bytecode.
- The reanchor harness runs `python3 -E -s` without `-B`, so the cache was written **inside the capture**. The strict `file_set` check then refused it, which is correct behaviour.
- r2's and r3's own runners used `python3 -I -B`, which hid the defect.

## Fix: three hunks in `src/a1_capture.py`, verified-bytes loader (`r3-to-r4-a1_capture.patch`)

- **New loader:** `load_module(path, name)` is replaced by `load_pinned(b, path, name, want)`.
  - It re-checks `sha256(b) == pins.l1_authority`; otherwise it refuses `l1_authority_pin`.
  - It compiles **the verified bytes** in memory (`compile(b, path, 'exec', dont_inherit=True)`) and executes them in a fresh `types.ModuleType`.
- **Module semantics kept:**
  - name `l1_authority_copy`, so it is not `__main__` and the launcher's run guard stays off;
  - `__file__`, and a `ModuleSpec` with `origin` set to the bound copy;
  - not registered in `sys.modules`, as before.
- **What changes:**
  - no file loader is used, so no `.pyc` is written anywhere;
  - the path is not re-read, so what executes is exactly the hashed bytes;
  - the caller's global state (`sys.dont_write_bytecode`, `sys.pycache_prefix`) is never read or changed.
- **The call site** keeps the bytes that were checked at the pin (`l1a, l1b_code = put(...), b`) and passes them.
- **Unchanged:**
  - every pin;
  - the runtime policy (python, libpython, node);
  - r3's limits and the record format `enclave-a1-capture/v2`;
  - the `file_set` strictness. Nothing is whitelisted; a planted `.pyc` still refuses.
- **Helios child:** the child (`python -I code/l1_authority.py run …`) runs the file as `__main__`, so it is never cached. That is unchanged.

## Tests: 45 + 7 = 52, ALL run by an ordinary caller (`python3 -I`, no `-B`)

The runner is `jobs/root-capture-tests.sh`.
- **The 45 tests:** r3's 45 are byte-identical. They now also run with bytecode writing **on**, in a private copy of the stage.
- **The 7 new tests:** `tests/test_import_safety.py`. Every test sets the caller to `sys.dont_write_bytecode=False` and `pycache_prefix=None`, and restores the caller's own state on cleanup.
  1. **Negative control:** under this caller, r2/r3's loader, verbatim, writes a `.pyc`. This proves the clean results below are not vacuous.
  2. **Initial capture:** no bytecode anywhere; the published file set equals the bound files plus records exactly; verify passes; the caller's flag is unchanged.
  3. **recheck-capture of a fresh initial:** this is the exact r5 failure path. Both captures are clean, and the consumer's verify binds the reviewed initial.
  4. **Plain recheck capture:** clean, and verifies.
  5. **Caller with bytecode disabled:** the caller's `True` stays `True`. The library changes neither direction.
  6. **Planted `.pyc`:** a trusted-looking `code/__pycache__/*.pyc` in a clean capture **still refuses with `file_set`**.
  7. **`load_pinned` semantics:**
     - name, `__file__` and origin are correct, and `load_config`/`status` exist;
     - nothing is registered and nothing is written next to the file;
     - bytes changed on disk after hashing are **not** executed;
     - unpinned bytes refuse with `l1_authority_pin`.
- **Runner guards:**
  - the copy must start with no caches and must hold `src/__pycache__` afterwards, which proves the caller really wrote bytecode;
  - the stage itself stays byte-identical and cache-free.

## Composition
- **Same hunks for r2:** the same three hunks applied to r2 are recorded in `capture-import-safety-stage/` (`r2-import-fix.patch`, identical +/- lines).
- **Pin:** r4's `src/a1_capture.py` sha256 is `db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20`.
- **Consumer:** that pin is consumed by `base-reanchor-recovery-stage/r6`.

Custody v2 stays REFUSED; lease consumers stay on HOLD. A1/capture remain HOLD (`A1_CAPTURE_REVIEWED = False` in the consumer). No mainnet proof is claimed.
