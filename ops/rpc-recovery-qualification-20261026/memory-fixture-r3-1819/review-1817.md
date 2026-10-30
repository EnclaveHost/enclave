# 1817: narrow r1→r2 review of composite-memory-fixture-stage/r2 (fix report 1813). NO tests have run; nothing is PASS

**Scope:** reading only.
- **What I read:** the r1→r2 diff of `memory_fixture.py`, the run and test jobs and tests 8–11, against my review 1811 F1–F4 and root's unowned-receipt finding. MemoryHigh whole-scope and F5 are not re-reviewed, as requested.
- **Not done:** tests, probes, builds, mounts, scope changes or edits.
- **Queue order:** the pending KVM build/test window precedes any actual run.

| item | sha256 |
|---|---|
| r2 `SHA256SUMS` (7 entries, `sha256sum -c` OK; r1 `d888cfef…` also unchanged) | `5b17958b1ee146dcb6c4ff5f6279b0721d3d74b83f2145827e01a63eed738e82` |
| `memory_fixture.py` | `7c1235d047650a40715ec08767212c1aa02dea4a1fda3fe7e5d02dc5c880698e` |
| `tests/test_memory_fixture.py` (11 tests) | `a910528da640c6f901cb98edde899ff9f8f376ec9d7b1620f8b01fe61b8ab625` |
| `jobs/run-fixture.sh` | `6443945a2ef54c0ac26fbd320004f604f1e585763734363b38d4c8ebc9979d6a` |
| `jobs/tests.sh` (gate `Ran 11`) | `666c499e06aedc821b9d43226f5d9f92f74d9d8b4d04e0bfcfba3c0330d6bc8e` |
| `jobs/common.sh` (path change only) | `b273322f88ac1fdd30fe4990cb33edfee922494b49af302b69b4bfa779458f9e` |
| `walker.py` (= r1) | `bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113` |

## Concrete blocker (one)
**B1. `cmf-r2-tests` will deterministically FAIL its own gate on a ResourceWarning in test 9.**
- **The cause:** `tests/test_memory_fixture.py:186` is `snap = lambda: {n: open(os.path.join(run, n)).read() for n in sorted(os.listdir(run))}`. It opens files without closing them. It is called 3 times over 2 files, giving 6 unclosed file objects.
- **Why it fails:** `jobs/tests.sh` runs Python with `-W always::ResourceWarning`, and CPython's file finalizer then prints `ResourceWarning: unclosed file …` to stderr. The job's `noBadMarkers` check rejects any `ResourceWarning`, so `pass` is false even if all 11 tests succeed. `run-fixture.sh` requires a passing tests receipt, so the fixture run is blocked too.
- **Safety:** this is fail-closed; no safety impact.
- **Minimal fix (a new frozen r3, test file only):** read each file with `with open(...) as f: f.read()` inside a small helper. No runtime change is needed.

## Verified (no blocker)
**F1, the wrapper `timeout -s TERM -k 120 780`.**
- **Budget:** the controller's nominal budget is 660 s, and the walk ends by 660 − 150 s. The hard stop is now checked **before** each sample.
- **TERM at 780 s:** GNU `timeout` signals its own process group: the controller, plus any in-flight non-session child such as `systemctl` or `fusermount3`. Before cleanup, r6 `_on_signal` turns it into an ordered cancel. During cleanup it has no effect, because `drive()` sets `armed=False` FIRST and then SIG_IGN.
- **KILL at 900 s:** it reaches only the same group. qemu-nbd, nbdfuse and the walker have their own sessions, so they are not signalled; they end by PDEATHSIG when the controller dies.
- **Accurate wording:** the job receipt and README say exactly this (rc 124 → WRAPPER-TERM, 137 → controller killed, a possible dead mount or D-state process with no bound).
- **The worst main-lane hold is about 900 s + post-steps,** except for D-state. This is correctly stated and no longer claimed as "elapsed ≤ budget".

**Leftover processes recorded without a self false positive.**
- **The check:** `pgrep -u $(id -u) -a -f "$O" | grep -v -F pgrep` runs after `timeout` has returned.
- **No self-match:** pgrep excludes itself, the `grep -v pgrep` argv does not contain `$O`, and the job bash, the subshells and the queue/guard argv do not contain `$O` either. The receipt heredoc that does carry `$O` runs **afterwards**.
- **Diagnostic only;** nothing is signalled. PASS requires an empty result.

**F2, the reservation.** `root_remaining()` uses the **pinned 1773 runner's `part_state`**, loaded by exact bytes. Its top level re-verifies the r3 SUMS, and r2 also requires the core = `3159890b…`. Every root part not r3-validated committed counts in full.
- **Write bound:** `need` = remaining + floor + the 8 GiB reservation (untouched) + `FIXTURE_WRITE_BOUND` = 64 MiB image cap + 3 × 4 MiB + 16 MiB.
- **Log cap enforced:** the child logs are bounded by setting r6's module global `CHILD_FSIZE = 4 MiB` in `main` before any spawn. r6 `spawn` reads it at call time, and an overrun means SIGXFSZ, which fails closed.
- **Test 11** is a real r3 fixture (plan, copy, verify) with exact expectations: valid parts count 0; a missing file, a stale file and a never-copied part each count in full.

**No unowned writes.**
- `drive()` writes a receipt **only** if `s.owns_run` (its own O_EXCL `session.pid`);
- cleanup runs only for `s.owns_work`;
- the image is unlinked only after a complete cleanup and only if it is the same inode;
- `main` refuses to stdout before anything is claimed.
- **Test 9** proves an old run dir with a live `session.pid` and `receipt.json` is left byte-identical, for both a stub and the real `prepare` refusal. The B1 ResourceWarning aside, the test is meaningful.

**F4, the actual signal and soft-stop paths.**
- **Test 8** sends a **real SIGTERM** (`os.kill` of itself) inside `use()`. It asserts the rest of `use()` never ran, cleanup ran under **SIG_IGN**, the handlers were restored, and rc 5 with a CANCELLED `receipt.json` in the owned run dir.
- **Test 10** drives the **real `FixtureSession.use()`** with a `sleep` stand-in walker and a forced soft-stop threshold. The walker group is stopped first and reaped, then r6 cleanup completes, giving SOFT-STOP. It needs the job's own non-root cgroup (the queue scope), as the README notes.
- **The test count is 11,** matching `tests.sh` (`ran == ["11"]`).

## Verdict
**One concrete blocker (B1, a test-file defect).** Fix it in a new frozen revision. After that, the stage is **ready for the queued fixture tests** (512 main lane, then the 768 run) once the KVM window releases the main lane.

It is **not qualified** for any production lane, and nothing here is a PASS.
