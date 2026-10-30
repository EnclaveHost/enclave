# composite-mdbx-validation-stage/r5: fixture admission-guard correction (1792). FROZEN, NOT RUN, NOT PASS

**Status:** source only. All 12 r4 tests remain **NOT RUN**.
- **Executed by me:** `ast`, `bash -n` and sha256.
- **Not done by me:** tests, mounts, process inspection, original or live-part reads, or any copy.
- **Unchanged:** the driver and the queue.
- **Preserved (SUMS re-verified):** r1–r4.

## Diagnosis of root's cmv-r4-tests refusal (evidence only; the exact cause is NOT proven)
**From `logs/cmv-r4-tests.out` (rc 9):**
- three `NOT STARTED: test allocation held` retries;
- then `[queue] START … cap=512MiB … concurrentSmall=0MiB`;
- then `## REFUSED: a recovery/composite session process is live`.

So the job **held the exclusive main flock** when `guards` ran. Per `claude-test-queue.py`, every ≥ 512 MiB job holds that flock from admission until its scope exits.

**The r4 guard was** `pgrep -u $(id -u) -f 'orchestrate\.py|overlay_session\.py|composite_session\.py'`. It matches the names as **text anywhere in any command line** of this uid, and the refusal logged **no PID or argv**.

**What I checked (read-only source):** the batch driver `jobs/root-multipart-batches-1773.py` (`5c33f6e2…`) queues each batch as `bash jobs/q-exit-status.sh <name> 1024 python3 -I -B root-multipart-batches-1773.py batch --mode … --lo … --hi …`. That argv does **not** contain `orchestrate.py`. So the waiting 17..24 copy job's queue command line is **not** shown to be the match.

**Remaining candidates, none proven:**
- **(a) A text mention** in some process of this uid: a monitoring, review, editor or grep command naming one of these paths. pgrep would match it.
- **(b) A short-lived remainder of the just-finished 9..16 verify session** (its `orchestrate.py` or r9 `overlay_session.py`) still present one second after the queue released the lock.

Without a PID list from 00:57:45 neither can be confirmed. **r5 makes the next refusal self-explaining.**

## Change (minimal; runtime unchanged)
**Stage `composite-mdbx-validation-stage/r5/`, SHA256SUMS `b3a318d6864f23a991480f89fe2075c643799df1959bab46721b4d9a0e525b98`**

| file | sha256 | vs r4 |
|---|---|---|
| `composite_session.py` | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` | **identical** |
| `tests/test_composite_session.py` (12) | `7478ededf6830be7812c730b4d0724f1b2915c8ae2240b204debaa75e5aa65c6` | **identical** |
| `jobs/session_guard.py` | `f64c6115ab8ac871d1813d53d45d3b03369c330c45617763824a4bb3fef287ce` | new |
| `tests/test_session_guard.py` (4) | `6a66be0d0a2ff88d58dbff0d7d2b0c2ead3693a6ac12042901719304f273994b` | new |
| `jobs/common.sh` | `ce6652be…` | the pgrep line replaced by the guard; path r5 |
| `jobs/tests.sh` | `9e9f5932…` | two suites (4 + 12), r5 receipt |
| `jobs/root-composite-validate.sh` | `6a483283…` | still refuses unconditionally (r5 text) |
| `jobs/stop-session.sh` | `ba1568db…` | identical |
| `README.md` | `e1042634…` | |

**`jobs/session_guard.py`** (stdlib, read-only `/proc`) refuses (rc 1) only while a **real** session process is live: a process of this uid where:
- `argv[0]` is a Python interpreter;
- its script argument (the first non-option argument; `-c`/`-m`/`-` mean none; value options `-W`/`-X`/`-Q` skipped; `--` honoured) has the basename `orchestrate.py`, `overlay_session.py` or `composite_session.py`.

That is exactly how the r3 wrapper (`python3 -I -B …/orchestrate.py run`), r9 and this stage start them.

**Its own process and all its ancestors** (the job shell, memory guard and queue) are excluded.

**What it logs:**
- **each refusal:** `## guard LIVE session process: {"pid", "startTime" (/proc stat field 22), "argv" (first 8)}`;
- **text mentions:** `## guard INFO (text mention only, not refusing): {"pid", "startTime", "comm", "argv0" basename}`. Their arguments are never logged.

An internal error is rc 2, which `common.sh` treats as a refusal.

**Not loosened:**
- every real invocation that r4 caught is still caught;
- the stage-mount refusal (`/recovery-multipart-stage/`, `/recovery-overlay-stage/`, `/composite-mdbx-validation-stage/`) is unchanged;
- the peer snapshot is unchanged;
- the exclusive 512 MiB main lane is unchanged;
- an idle driver never blocks.

## Tests (expected: `test_session_guard` Ran 4 + `test_composite_session` Ran 12 → `## PASS (4+12)`)
1. **Classifier:** 6 real invocation shapes are sessions. 12 are not, including:
   - `bash -c 'pgrep -af orchestrate.py'`, `python3 -c …`, `-Ic`, `-m`, `grep`, `sed`;
   - the 1773 driver's own `batch` argv;
   - `orchestrate.py.bak`, stdin, options only, empty, and a non-Python argv[0].
2. **A real dummy `python3 -I -B <tmp>/orchestrate.py run` child:** rc 1, with its PID, int start time and argv logged. After it is killed: rc 0.
3. **A bash child whose arguments only mention the names:** rc 0, INFO with argv0 `bash`; the argument text (`SECRETLIKE…`) is never printed.
4. **Own-ancestor exclusion:** the guard run from a parent script named `composite_session.py` gives rc 0.

**Notes on the dummies:** they are our own children, ended and reaped in `tearDown`. The batch driver evaluates `busy_reasons` only inside its own queued `batch` job (`cmd_batch`, 1773.py:423), which cannot run while this job holds the main flock.

## Root invocation (main lane; as the owner, not under unshare)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r5-tests 512 bash composite-mdbx-validation-stage/r5/jobs/tests.sh     # expect "## PASS (4+12)"
```
- **If refused again,** `logs/cmv-r5-tests.out` names the exact PID, start time and argv of the live session, or shows INFO lines for text mentions.
- **Do not** stop the healthy copy/verify driver.
- **Production remains DISABLED.**

## Limits
- **The r4 refusal's actual cause is unproven** (candidates a/b above).
- **Admission is a point in time:** a session starting after it is still prevented by the queue's exclusive main flock and detected by the peer snapshot (FAIL), as before.
- **What the guard recognises:** only the documented Python invocation shapes. A session started through an unusual wrapper (e.g. an exec-ing shim with a different argv[0]) would not be recognised. Its stage mount is still refused, and its qemu-nbd/nbdfuse still fail the peer snapshot.
- **Unchanged composite limits:** these are the r3/r4 fixture assumptions (FUSE `-o ro`, without-lck open, cmdline binding, corrupt-meta rc, libfuse unmount behaviour), plus no production scale and no chain/state/RPC/SNP validation.
