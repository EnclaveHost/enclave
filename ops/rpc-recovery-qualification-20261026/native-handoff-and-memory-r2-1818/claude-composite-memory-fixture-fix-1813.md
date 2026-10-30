# 1813: composite-memory-fixture-stage/r2: narrow fixes for review 1811 F1–F4 (+ F5/F6 text, root's unowned-refusal finding). FROZEN, NOT RUN, NOT PASS

**Scope:**
- **What I executed:** text edits in a NEW r2 (copied from r1's sources); `ast` parse; `bash -n`; `cmp`; `sha256sum`; reading review 1811 (`cde48d06…`) and the 1773 runner's `part_state`.
- **Not done:** tests, builds, probes, mounts, scope changes or queue jobs. **r1 (`d888cfef…`) is unchanged** (`sha256sum -c` OK) and was never run.
- **Waiting:** no actual tests until the KVM jobs release the main lane.

## Frozen r2: `composite-memory-fixture-stage/r2/SHA256SUMS` = **`5b17958b1ee146dcb6c4ff5f6279b0721d3d74b83f2145827e01a63eed738e82`** (7 entries, read-only)
| file | sha256 |
|---|---|
| `memory_fixture.py` | `7c1235d047650a40715ec08767212c1aa02dea4a1fda3fe7e5d02dc5c880698e` |
| `walker.py` (byte-identical to r1) | `bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113` |
| `tests/test_memory_fixture.py` (11 tests) | `a910528da640c6f901cb98edde899ff9f8f376ec9d7b1620f8b01fe61b8ab625` |
| `jobs/run-fixture.sh` | `6443945a2ef54c0ac26fbd320004f604f1e585763734363b38d4c8ebc9979d6a` |
| `jobs/tests.sh` (gate: exactly `Ran 11 tests`) | `666c499e06aedc821b9d43226f5d9f92f74d9d8b4d04e0bfcfba3c0330d6bc8e` |
| `jobs/common.sh` | `b273322f88ac1fdd30fe4990cb33edfee922494b49af302b69b4bfa779458f9e` |
| `README.md` (LIMITS first) | `a319434266839fdc937e89b25c8e7b79949f8a75cc92af5f3b0e00bfaa768fe8` |

**New pin:** `jobs/root-multipart-batches-1773.py` `5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a`. It is loaded from its exact bytes; its own top level re-verifies the frozen r3 stage SUMS before importing the core, and r2 additionally requires that core = `3159890b…`.

**Other pins unchanged:** r6 `407aa7e9…` (and through it qemu-nbd, nbdfuse, fusermount3, r9), the manifest `f94807f7…`, systemctl, python3, the walker.

## F1: bounded time and the wrapper (as root required)
- **The wrapper:** `jobs/run-fixture.sh` now runs `timeout -s TERM -k 120 780 python3 … memory_fixture.py`.
  - **TERM at 780 s** is r6's `_on_signal`, i.e. an ordered cancel. It is ignored if cleanup has already begun: in `drive()`, `armed=False` is set **first**, then SIG_IGN.
  - **KILL at 900 s** reaches the stuck **owned controller** (and `timeout`'s own group) only.
- **Nominal budget:** the controller budget was reduced from 900 to **660 s**, and the walk now ends by 660 − 150 s (cleanup reserve). The hard stop is checked **before** each sample.
- **True worst case** (README, the receipt `wrapper` field, the job header): about **900 s plus a few seconds of post-steps**.
  - After a KILL, the ordered cleanup is skipped. qemu-nbd and nbdfuse end by **PDEATHSIG only**, and a **dead FUSE mount** may remain.
  - **A D-state process has no bound;** a SIGKILL may not end it.
  - The queue's guard SIGKILL-sweeps the job's remaining descendants when the job exits, and the main-lane flock is released then.
- **The job receipt records:**
  - `controllerKilled` (rc 137): outcome "CLEANUP-INCOMPLETE (controller killed by the wrapper …)";
  - `wrapperTerm` (rc 124);
  - `mountsLeft`;
  - a new **`processesLeft`** (`pgrep -a -f RUN_DIR`, diagnostic only; nothing is signalled).

  PASS also requires no process left.
- **No claim is made** of an absolute D-state bound or of guaranteed normal cleanup.

## F2: the full remaining reservation and the fixture's own writes
- **`root_remaining(R, d, msha, "root")`:** every root part for which the **pinned 1773 runner's `part_state`** is not `committed` counts with its **full** manifest length. That means:
  - a valid record;
  - the current identity == destIdentity, nlink 1;
  - a confirmed binding or a confirmed fresh PASS.

  So a record whose file is missing, short, stale or replaced now counts. This is the same rule the 1773 runner admits with.
- **`need`** = remaining + 40 GiB manifest floor + **8 GiB native-build reservation (untouched)** + **`FIXTURE_WRITE_BOUND` = 64 MiB image cap + 3 × 4 MiB child logs + 16 MiB metadata = 92 MiB**.
- **The child logs:** every child's RLIMIT_FSIZE (= its log) is lowered from 64 to 4 MiB by setting r6's module-level `CHILD_FSIZE` before any spawn. r6's own `spawn` reads it at call time; no r6 code is changed. A child exceeding it gets SIGXFSZ, which fails closed (FAILED).
- **Test 11** builds real r3 fixture records through the pinned r3 CLI (plan, copy 0–2, verify 0–2):
  - valid parts count 0 and the never-copied part 3 counts;
  - then a **missing** file (part 0) and a **stale** file (part 2, `utime`) each count in full, while the valid part 1 does not.

## F3: whole-scope MemoryHigh
The README LIMITS, the module docstring, the receipt's `limits`, and `scope.appliesTo` now say the following:
- MemoryHigh applies to the **whole transient queue scope**: node memory-guard, job bash, controller, qemu-nbd, nbdfuse and walker, plus their charged page cache and page tables;
- above 512 MiB, all of them may be throttled, which can delay the outer guard and slow the servers (priority inversion, possibly TIMEOUT);
- a MEASURED result describes **whole-scope throttling, not walker-only reclaim**.

The receipt's `notClaimed` adds "walker-only reclaim". There is no code change, because a walker-only sub-cgroup would need delegation.

## F4: the real cancellation / soft-stop paths are now tested (tiny, no mount)
- **`drive(a, C, build, t0)`** is the single path, extracted from `main` with the same logic: handlers, then prepare/expose/use, then `finally` (armed off, SIG_IGN, pending signal, r6 cleanup of an owned work dir, image removal), then outcome, then the receipt. `main` only loads the pins and modules, and refuses to stdout before anything is claimed.
- **Test 8:** a **real SIGTERM** (`os.kill` of itself) inside `use()` reaches r6 `_on_signal`, which raises Stop. The test checks:
  - the remaining code in `use()` never runs;
  - `cleanup()` runs **with SIGTERM = SIG_IGN**;
  - the handlers are restored afterwards;
  - rc 5 and a `receipt.json` with CANCELLED in the owned run dir.
- **Test 10:** the real `FixtureSession.use()` with a stand-in walker (`sleep 300`, no mount or mapping) and the soft threshold forced to trip at the first sample. The walker group is stopped first and reaped, `softStop` is recorded, then the r6 cleanup completes, then the outcome is SOFT-STOP. It reads only this test job's own cgroup files.

## Root finding: a refusal in an UNOWNED run dir writes nothing there
`drive()` writes a receipt **only if this controller claimed the run dir** (`owns_run`, from its own O_EXCL `session.pid`). Otherwise the summary goes to stdout only. r1 wrote `receipt-refused-<ns>.json` into a foreign run dir.

**Test 9:** an old run dir with live `session.pid` and `receipt.json` is refused both by a stub and by the **real** `prepare` (not under runs/). The listing and contents are byte-identical afterwards, and `receiptFile` is null.

## F5: corrected inference (review 1811)
The review treated 512 MiB as the walker's own allowance and then added the other processes. That double-counts. **MemoryHigh is a target for the scope's charged total:** the walker, the servers, node, bash and the controller, including unmapped cache and page tables.

**A SOFT-STOP is still possible, because:**
- MemoryHigh is not a ceiling;
- tree VmRSS (the guard's metric and our soft-stop input) counts shared pages once per process, and pages charged to **other** cgroups (e.g. shared libraries first faulted elsewhere), while it excludes unmapped cache and page tables. So it is not a function of `memory.current`;
- the sampling race.

The README states that **SOFT-STOP (rc 6) is a realistic, honest outcome and MEASURED is not the expected default.**

## F6 / F7
- **F6:** no `smaps_rollup`/Pss sampling at all (it is not needed for the goal). Samples are capped at 340 (every 2 s over the shorter budget).
- **F7:** unchanged. The walker checks its own limit every 256 MiB, and the controller's hard stop (checked before each sample) covers a stalled fault.

## Tests (11; `bash jobs/q-exit-status.sh cmf-r2-tests 512 bash composite-memory-fixture-stage/r2/jobs/tests.sh`, expect `## PASS (11)`)
1–7 are r1's, with test 2 now checking the fixture write bound in `need`, plus 8–11 above. Requirements and caveats:
- **Read-only:** none touches a mount, the user manager or a scope; tests 10 and 11 only read this job's own cgroup and tiny tmp files.
- **Python processes:** tests 8–10 load the pinned r6 and r9; test 11 loads the 1773 runner, which re-verifies the r3 SUMS, and runs the pinned r3 CLI in fixture mode on tmp files.
- **Test 10 depends on the queue's cgroup:** it needs the job's own non-root cgroup (the queue scope) to read memory files.

## Root commands (main lane only, after the KVM jobs release it; never stop the recovery driver)
```
bash jobs/q-exit-status.sh cmf-r2-tests 512 bash composite-memory-fixture-stage/r2/jobs/tests.sh      # expect "## PASS (11)"
bash jobs/q-exit-status.sh cmf-r2-run 768 bash composite-memory-fixture-stage/r2/jobs/run-fixture.sh  # MEASURED, or an honest SOFT-STOP / TIMEOUT
```

## Still unproven until an actual run (each a refusal or recorded failure, never a silent pass)
- (a) `systemctl --user set-property --runtime` on the queue's scope;
- (b) `nbdfuse MOUNTPOINT/FILENAME`;
- (c) FUSE page cache charged to our scope;
- (d) single-page FUSE fault speed within the now-shorter walker budget (about 480–500 s), else TIMEOUT;
- (e) whole-scope throttling side effects (F3);
- (f) the actual page-table and RSS figures.

**A MEASURED result would describe this mechanism at 8 GiB on this kernel only.** It is not a production-lane qualification and says nothing about MDBX integrity, canonical state or RPC readiness.
