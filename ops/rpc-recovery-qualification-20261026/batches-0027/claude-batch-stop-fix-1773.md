# Batch runner 1773: durable stop intent, strict inventory, source pin, and review 1772's verified findings. Source only; nothing run

**Not done by me:** no run of any test, queue job, driver or wrapper, and no live-process inspection. The running copy 1..8 and verifier/watcher 1769 are untouched.
- **1764 is preserved unchanged** (runner `773d18dd…`, tests `c19ca98a…`, job `eeef09ad…`).
- **multipart r3 is unchanged** (SUMS `fcd8e097…`, verified).

## Files (new, read-only)
| file | sha256 |
|---|---|
| `jobs/root-multipart-batches-1773.py` | `5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a` |
| `jobs/test_root_multipart_batches_1773.py` (**14 tests**) | `81267f2bb72fc41622907f2eb9af4423b07c7848390e188fdb1caf178bdc5cb2` |
| `jobs/root-multipart-batches-1773-tests.sh` | `938ed9562be5a925a72093ac5ae04044d0cc97748d045fb5a82eb5ad3e7d0c28` |

## Corrections (root's review, plus 1772 B1/B2 and P3-1/P3-2, verified in code)
1. **A durable stop intent** (root and 1772 B1: a stop while the job was still queued was lost).
   - **Driver:** on SIGTERM/SIGINT, `on_signal` sets the flag **once** (a nested signal returns, so the flock is never re-entered). It then writes `OUT/STOP` (O_EXCL) under `OUT/stop.lock` (flock). The driver never starts a queue job once stop is set.
   - **Batch, check 1:** at its very start, right after the run-lock and runner-sha check and **before** any pin read, admission or `active.json`. STOP → rc 5, logged "stopped before admission".
   - **Batch, check 2:** after the pins, before admission.
   - **Batch, check 3:** `guarded_launch` does the last check (its own flag plus STOP) and the wrapper `Popen` **under the same `stop.lock`**. So a STOP recorded before that point can never start production. A STOP recorded after it is a stop of a running batch.
   - **Forwarding, both levels retried:** the driver retries `forward_to_batch` every second while the queue child runs (the batch may register much later). The batch also re-reads STOP in its wait loop and retries the pidfd-pinned forward to its own `orchestrate.py` until it lands or the wrapper exits.
   - **Signals are never sent** to a process group or to the queue, so the queue's `stop()` 1 s SIGKILL is never triggered by us.
   - **1772 window:** the batch's handler is installed **before** `active.json` is created, so a TERM there is not a default-action kill.
2. **Strict inventory** (root and 1772 B2):
   - a `part-NNNN.*` whose index is not in the manifest, or that sits in the **other** target's dir, is foreign. This applies in both `admit` and `post_check`;
   - `verify-`/`resume-` names must carry a run id.
3. **Source pin:**
   - `drive` hashes its own runner file (`--runner-sha256 H` may pin the expected value) and records the sha in `run.lock`;
   - every queued batch gets `--runner-sha256` and refuses unless `run.lock` and its own file still have that sha.
4. **1772 P3-1:** a post-check error after the wrapper ran is rc 4 (never 3, "admission refused"), and is logged.
5. **1772 P3-2:** the orchestrate match compares realpaths (the wrapper passes a `pwd -P` path).
6. **Test only:** `--queue-cmd` substitutes the queue for owned fixtures. Root never passes it.

## Tests (14 = 1764's 9, retargeted, + 5)
**1764's 9:** batch plan; fresh admission; confirmed fresh PASS; exact reservation; verify admission; post-copy; post-verify; signal target (+ a realpath alias); one view at a time.

**New:**
10. **Wrong-target and unknown names:** `part-0001.json` in vm, `part-0099.bin`, `part-0004.bin.partial` in root, and `part-0001.verify-garbage.json` are refused at admission. A wrong-target verify file appearing after the wrapper is refused at post-check (4).
11. **STOP ordering:**
    - `guarded_launch` launches without STOP;
    - it does not launch with its own flag or after `write_stop`;
    - `write_stop` blocks while another holder has `stop.lock` (≥ 0.4 s of a 0.6 s hold).
12. **The driver forward retries** with a real owned process (bash, then a sleeper whose argv names this runner and `batch`):
    - before `active.json` → False;
    - with a wrong registered pid → False;
    - with the right pid and start time → SIGTERM delivered, and the owned tree exits.
13. **Stop while queued (an actual owned delayed-queue fixture; no real queue or session):** `drive --stop 8 --queue-cmd FAKE`, where FAKE sleeps 3 s and then execs the real batch command. SIGTERM goes to the driver during the delay. Required:
    - rc 5 and `STOP` present;
    - **no `admission-*` and no `active.json`**;
    - the batch logged "stopped before admission (STOP present)";
    - exactly one queue job ran (no verify job, no next batch).
14. **A changed runner sha or a foreign run id** is refused (3) before anything is created. With correct pins and STOP present → 5, and still no `active.json`.

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rmp-batches-1773-tests 256 unshare -Urn bash jobs/root-multipart-batches-1773-tests.sh    # expect "## PASS (14)"
# ONLY after the current verify of parts 1..8 has completed successfully (no overlap), and after review + PASS:
python3 -I -B jobs/root-multipart-batches-1773.py drive --start 9 --runner-sha256 5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a \
  --out /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-multipart-production-20261026/batches-1773-run1
# graceful stop: kill -TERM <driver pid>   (never signal the queue or q-wrapper processes)
```
**Admission at `--start 9`** requires parts 0..8 committed and verified (PASS in confirmed sessions, identity unchanged). It therefore refuses until the verify of 1..8 is complete and clean.

## Stop limitations (explicit)
- **A stop during a running batch is a stop, not a pause** (1772 P3-3). orchestrate cancels at its next safe point; the r9 session cleans up; committed parts stay; one `.partial` plus checkpoint may remain.
  - **The runner cannot resume such a batch:** a fresh copy admission requires no files at or above L. Resuming needs explicit root action through the frozen wrapper (future work).
- **Before orchestrate exists** (wrapper guards running), the batch retries the forward every 0.5 s. If the wrapper refuses before starting orchestrate, it simply exits non-zero, and the driver stops.
- **A STOP during the post-check** has no effect on that batch (its work is complete). The driver starts nothing further.
- **If the driver is SIGKILLed, no STOP is written.** A batch already in the queue then runs to completion. No further batch starts, because nothing launches it.
- **If root signals the queue or q-wrapper processes directly,** the queue's own `stop()` TERMs every descendant and SIGKILLs them after 1 s, which can cut a session's cleanup. **Signal only the driver.**
- **A batch killed by SIGKILL leaves `active.json`;** the next batch refuses until root inspects it.

## Not done
- **Not executed:** none of the tests, the driver or the batch has been run.
- **No real-queue or real-session run** was performed: the fixtures are owned processes only.
- **Review 1772's** "final frozen hash must be re-reviewed" applies to the 1773 hashes above.
