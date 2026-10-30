# 1879: base-state-readonly-stage/r12 (fixture scripts confined to an explicit /vm work dir) + state-fixture-capture-stage/r2 (SOURCE ONLY)

**Scope:** root's review put capture r1 on HOLD. This revision implements the B1/B2 fix.

**What I did not do:**
- run, test, build, queue, mount, use the network, read data/original/backup/parts, or commit;
- edit any acceptance stage. The reviewer's concurrent `state-helper-qualification-stage/r2` exists and is untouched.

**Preserved and re-verified:** bsro r11 (`246ff06b…`), capture r1 (`178f4c3a…`) and acceptance r1 (`25ca8ece…`) still verify clean.

**No claim of readiness:** no compiled Rust or fixture run exists, and nothing here is RPC/state/canonical readiness.

## 1. Frozen stages
| stage | SHA256SUMS sha256 |
|---|---|
| `base-state-readonly-stage/r12` | **`2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea`** |
| `state-fixture-capture-stage/r2` | **`f07bd6da5f0c4be3ed092a6318fcd3ec10a2fd87767469a838e2853c25030836`** |

**r12 key files:**

| file | sha256 |
|---|---|
| `jobs/positive.sh` | `3ba41117…` |
| `jobs/fixtures.sh` | `4cf3d582…` |
| `jobs/bsro_gate.py` | `0641637a…` (labels only) |
| `jobs/ns.sh` | `b8b4560c…` (labels only) |

**Capture r2 files:**

| file | sha256 |
|---|---|
| `capture.py` | `17b7b069…` |
| `jobs/run.sh` | `71717660…` |
| `jobs/inner.sh` | `4af6f950…` |
| `jobs/tests.sh` | `ced5c357…` |
| `tests/test_capture.py` | `964e68d4…` |
| `README.md` | `e396d084…` |

## 2. r12 = r11 + two script changes (everything else labels only)
**What did not change:**
- `diff` after normalising r11→r12: ONLY `jobs/positive.sh` and `jobs/fixtures.sh` changed in substance.
- The Rust (`src/`, `Cargo.toml`) is byte-identical, and the report format stays `base-state-readonly/r11`.
- `bsro_gate.py` (incl. `run_capture`, the gates and `verify_binaries`), the build/ns/guard scripts and the test suites (10 + 6 + 16, ns 5) have r11→r12 stage labels and receipt formats only.

**The new script contract:**
- **Arguments:** exactly two; no default, no `${1:?}`, no fallback:
  - `positive.sh BUILD_OUT_DIR WORK_DIR`;
  - `fixtures.sh BUILD_OUT_DIR/base-state-readonly WORK_DIR`.
- **Validated before anything else runs** (before the SUMS check, `verify-binaries` or any write):
  - `BUILD_OUT_DIR` matches `^/vm/enclave-volumes/rpc-recovery-validation-build/run-<8d>T<6d>Z-<pid>/out$`;
  - `WORK_DIR` == `BUILD_OUT_DIR/fixture-captures/<[A-Za-z0-9_-]+>/work`, so no `.`, `..`, nesting or relative path;
  - `BUILD_OUT_DIR` and the run dir are their own real paths (`pwd -P`) on the same device;
  - `mkdir -m 0700 WORK` must create it, so WORK is NEW.
- **Every write goes under WORK:**
  - `T=WORK/trees`: the fixture trees and the helper JSON;
  - `O=WORK/out`: evidence (mk/helper/expected/result texts, `binaries.sha256`, and the negative per-case outputs that r11 deleted).

  There is no `/tmp`, no `$S/runs` and no root path. The `## outputs` line names `WORK/out`.
- **Scoped cleanup:**
  - `positive.sh` unmounts its own bind mounts under `T`, then removes `T` ONLY if `findmnt` shows no mount left under it; otherwise it keeps the tree and counts a failure.
  - `fixtures.sh` removes only `T`.
  - `WORK/out` is never removed.
  - A cleanup failure → rc 1.
- **The cases, expectations and checks are r11's,** byte for byte.

## 3. Capture r2: the reviewed RO namespace, /vm-only writes, the existing lifecycle
**Flow:**
1. **`jobs/run.sh K BD`:** this stage's `sha256sum -c`, then the argument shape. Then **`capture.py precheck` OUTSIDE any namespace**, so every gate — incl. `no_live_sessions` and "no stage mount" — runs **before** `ns_harden`'s recursive bind could clone a live recovery FUSE mount. Then `unshare -Urnm bash jobs/inner.sh`.
2. **`jobs/inner.sh`:**
   - verifies this stage's SUMS, the r12 SUMS sha and `sha256sum -c`, and the `ns.sh` sha;
   - `source` of the **pinned r12 `ns.sh`**, then `ns_harden /home/steven /tmp` (the same call `build.sh` makes);
   - `exec env -i … capture.py run`.
3. **`capture.py run`:**
   - repeats all gates: pins/SUMS of this stage and r12 + the pinned acceptance; `qualified`; `live_completion`; `no_live_sessions`; the 512 lane + host floor; the root and /vm floors; `verify_binaries` with exactly one verified r12 build receipt;
   - checks `maps_inside` and no IPv4 route;
   - **`ns_checks(mountinfo, ro=[/home/steven, /tmp, r12, this stage], rw=[BUILD_OUT_DIR], RO_ROOTS)`** = private propagation + `read_only` + `ro_tree_ok`;
   - creates `BUILD_OUT_DIR/fixture-captures/` (0700, ours, same device) and the NEW `<kind>-<UTC>-<pid>/`;
   - spawns `timeout -s TERM -k 60 LIMIT bash <r12 script> <BD | BD/base-state-readonly> <run>/work` **through the pinned `run_capture`** (no new lifecycle) into `<run>/capture.txt`.
4. **After the run, every item below must hold:**
   - identities unchanged;
   - r12 and acceptance SUMS re-verified;
   - `verify_binaries`;
   - `ns_checks` still OK;
   - **no mount under the run dir;**
   - **`work/trees` gone and `work/out` kept;**
   - group not alive;
   - r12 `runs/` listing unchanged;
   - the parser check passing;
   - not truncated, abandoned or timed out (124/137), no sink error, rc 0.

   Then `receipt.json` (`bsro-fixture-capture-receipt/r2`, `write_new`).

**Exit codes:** 0 pass; 4 ran and failed (`pass:false` receipt); 3 refused before anything ran.

**Root-side writes:** none from a fixture run. The unit-test job (`jobs/tests.sh`) still writes its own small receipt under this stage's `runs/`, as every stage's unit tests do.

**Kept local and small:**
- the 512 MiB lane check (r12 `own_lane` is 4096-only);
- `timeout(1)` inside the owned group;
- the exactly-one build receipt rule;
- the cleanup/confinement fields;
- the receipt and its consumer check `receipt_errors`.

## 4. Parser binding: PENDING, fail closed
**What is pinned now:** `ACCEPTANCE = None`. `parser_binding()` is the **first statement** of `precheck`, `run` and `gates` (test 2 checks this by AST). Every invocation therefore returns rc 3 before touching anything, and `receipt_errors` can never pass.

**Why it cannot accept r12 yet:** acceptance r1 cannot accept r12 output. Its identity check requires the r11 SUMS and script shas, and its markers are `## bsro-r11-positive rc=0` / `## bsro-r11-fixtures rc=0`. I did not re-implement or bypass the parser.

## 5. Exact minimal follow-up (root / reviewer; then one capture revision)
**(a) An acceptance revision (the reviewer's line; its P1–P4 stay as reviewed) whose `check_fixture_capture`:**
- pins r12 SUMS `2911943d…`, `positive.sh` `3ba41117…` and `fixtures.sh` `4cf3d582…`;
- expects the markers `## bsro-r12-positive rc=0` and `## bsro-r12-fixtures rc=0`;
- keeps `## runs=26 failed=0`, `## fixtures failed=0` and the 26 labels / 6 cases in order;
- keeps `## outputs /abs`. **Recommended:** the caller verifies that the path equals `<run>/work/out`;
- is accompanied by its own actual test receipt.

**(b) `state-fixture-capture-stage/r3` = r2 with:**
- `ACCEPTANCE = {"sums": (<acc dir>/SHA256SUMS, sha), "module": (<acc dir>/acceptance.py, sha), "tests": (<its passing test receipt>, sha)}`;
- if the new API adds anything, the matching call;
- optionally, the `## outputs == <run>/work/out` check;
- its tests updated (test 2 inverts; test 8's single pending error disappears).

Nothing else changes.

**(c) The live order after that:**
1. r12 guard (10 + 6 + 16) and ns (5) actual PASS;
2. the r12 preflight/build on 4096 after all 265 are CONFIRMED (**the Rust has never been compiled**);
3. `sfc-r3-tests`;
4. `sfc-r3-positive` and `sfc-r3-fixtures` on 512, giving the first real fixture receipts;
5. then the state runner / extraction / structural / G8 / acceptance as planned.

## 6. Prepared tests (NOT run): capture r2, 14 tests (`sfc-r2-tests`, 256 lane)
1. **Pins:** re-hashed against r12; the gate source has `BASE`, `RO_ROOTS` and the reused functions.
2. **The parser is pending:** `run`/`precheck` refuse first; `main` → 3; AST check that `parser_binding` is the first statement; `receipt_errors` never passes.
3. **`parse_sums` is strict.**
4. **Lane / IPv4 route / `mounts_under`,** incl. "a prefix is not a parent".
5. **`run_paths`** satisfy the r12 WORK rule; bad bd/kind/pid refused.
6. **The exactly-one verified r12 build receipt** and the expected identities (r12 script pins).
7. **`decide`** with every cleanup/confinement field and capture fault.
8. **`receipt_errors`:** while pending, exactly the parser error; every other mutation adds errors.
9. **Confinement by AST:** spawn/write/`mkdir`/`ns_checks`/`maps_inside` happen only in `run`; `exec` only in `load_pinned`; no subprocess/shutil/tempfile; no `"/tmp/` literal.
10. **`run.sh`/`inner.sh`:** `precheck` before `unshare`; the `ns.sh` sha check → `source` → `ns_harden /home/steven /tmp` → `exec … capture.py run`; the pins equal `capture.py`'s; no other mount.
11. **r12 scripts, statically:** the first code line after `set`/`export` is `[ $# = 2 ] ||`. There is no `/tmp`, `$S/runs`, `${1:-}`, `${1:?}`, `mktemp` or `TMPDIR`. Every redirect target starts with `$O/` or `$T/`; every `mkdir` targets `$WORK`/`$T`/`$O`; every `rm -rf` is `rm -rf -- "$T"`.
12. **Cleanup scoped:** unmount, then the `findmnt` check before `rm`; `$O`/`$WORK` never removed; the negative outputs kept.
13. **The no-fallback proof, executed:** both r12 scripts run with 10 + 6 bad argument sets (none/one/three args; `/tmp` BD or WORK; a WORK in a temp dir; `..`; nested; relative; mk_fixture instead of the helper; a valid shape with a nonexistent `/vm` BD). Each must exit **9**, and the temp dir must stay **unchanged**.
14. **The `ns.sh` reuse** is the reviewed recursive-RO hardening that `build.sh` calls.

**r12 itself:** its existing suites (guard 10 + 6 + 16, ns 5) are unchanged apart from labels and must PASS for r12's own receipts. There is no new r12 test file, so `GUARD_SUITES` is unchanged.

## 7. Limits (stated, not filled)
- **Hardened namespace (unverified inside it):** `mount --bind` + `remount,bind,ro` on `/vm` work dirs inside the hardened user namespace, `findmnt`, and the scripts' `python3 -I -B` / `stat` / `timeout` there. These are expected to work (the mounts are created in this namespace, so they are not locked), but only the live run verifies it.
- **Build-dir accounting:** the build out dir gains `fixture-captures/` after accounting, so `accounting.json` alloc bytes predate it (informational; `authenticate`/`verify_binaries` check only the binaries and accounting).
- **Receipt trust:** receipts are honest-capture evidence, not proof against a malicious same-user writer. Consumers re-run the pinned parser on the sha-bound `capture.txt`.
- **A residual window:** a stage mount appearing between `precheck` and `ns_harden` would be cloned, then detected by `run`'s `no_live_sessions` (refusal) and released when the namespace exits. This is the same residual window as the r11 ns-tests.
