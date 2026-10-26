# 1741: recovery-sequential-probe-stage/r2 (FROZEN, NOT run): root review 1740 addressed; r1 preserved unexecuted

**Status:** source frozen, NOT run.
- **Stage:** `recovery-sequential-probe-stage/r2/`, **`SHA256SUMS` sha256 `615e421754620142c5e662dd10030f0e2305cd32d019d699c382d01e13c91f1b`** (6 files, read-only).
- **Preserved:** r1 (`9e2201f2…`) re-verifies and stays unexecuted.
- **Not done by me:** tests, builds, live actions, or any read of the original.
- **Executed by me:** reading the review, the r1 stage and the qualified MDBX r4 wrapper; text edits; `ast.parse`; `bash -n`; `sha256sum`.

| file | sha256 (prefix) |
|---|---|
| `seqprobe.py` | `184bde05…` |
| `tests/test_seqprobe.py` (7 tests) | `696f2b62…` |
| `jobs/common.sh` | `ae65936d…` |
| `jobs/tests.sh` | `e7dbf811…` |
| `jobs/root-real.sh` | `b78e384f…` |
| `README.md` | `782dc2fc…` |

## Review 1740, item by item
**1. The lifecycle: r1's `run_bounded` is DELETED, and the exact qualified code is reused.**
- **The source:** `seqprobe.lifecycle()` loads **`mdbx-recovery-validator-stage/r4/src/mdbx_check.py` (sha256 `f0d27e40…`)** from the exact bytes it hashed. It compiles and executes them into a private module, with no re-open between the check and the use.
  - `jobs/common.sh` also pins the MDBX r4 stage SUMS (`82394b02…`) and that file's sha.
- **Every read** is `M.bounded_run(argv, 45, cap=64 KiB)`. Its behaviour:
  - the child runs in its own group;
  - **`waitid(WNOWAIT)`**, so the leader stays unreaped while the group may be signalled;
  - SIGKILL of the group on the deadline, on output beyond the cap, when stdout is held 2 s after exit, or on a deferred cancel;
  - **always before the single bounded reap**;
  - **no group is ever signalled after the reap.** r2 has no `killpg`, `communicate` or `group_alive` of its own.
- **Parent cancellation:** `main` installs the module's own `_on_signal` for SIGTERM/SIGHUP/SIGINT, exactly as `mdbx_check.main` does.
  - **During a read**, the signal is deferred: `bounded_run` kills and reaps its group, **then** raises `Cancelled`. `run_ranges` attaches the rows so far, and `real` still writes `result.json` (inside `signals_deferred`, so a started report is completed). The exit is **128+N**.
  - **Between reads,** `Cancelled` is raised at once (no child is owned).
- **Bounds unchanged:** 4 × 64 MiB, ≤ 256 MiB, concurrency 1, ≤ 240 s.
  - **The worst case per read** is 45 + 2 (`EOF_GRACE`) + 5 (`KILL_GRACE`) = 52 s, so 4 × 52 = 208 s.
  - A read whose worst case does not fit the remaining budget is **skipped, never started**.
  - The job adds `timeout -k 10 300`.

**2. Statistics:** the argv is now `read -C OFF LEN`.
- **`parse_stats` accepts only** a 5-field `bytes,ops,time,bytes/sec,ops/sec` line (qemu-io `print_report` with Cflag) whose **bytes equal the requested length exactly** and with ops ≥ 1. Anything else gives `stats None`, so the sample is incomplete.
- **The format is asserted on a real tiny read** (test 3) with the real argv. If the local qemu-io prints something else, that test fails, which is visible; nothing is assumed.

**3. Known pattern, at exact offsets** (fixture only; the real run never passes a pattern or assumes content):
- **The fixture qcow2** is 4 MiB of `0xab` followed by 4 MiB of `0x5c`.
- **`-P` with the right pattern per region** at offsets 0 and 4 MiB: **both complete**.
- **`-P 0xab` for both:** the second is **incomplete**, with "Pattern verification failed" captured.
- **The fixture's sha is unchanged,** and the output tail is under 1 KiB (statistics only, no `-v`).

**4. Concurrent load:** every result carries `concurrentLoad`. The rates are measured under whatever else reads the same USB array; root 1740 saw the peer L1 comparison reading it. They are **not isolated-disk throughput and not an ETA**.
- `/proc/loadavg` is recorded before and after.
- The probe does not interfere with the peer, and it still **refuses** if any process names `base-origin.qcow2`.
- Root re-checks the processes at measurement time.

**5. Explicit result status:**
- **`summary`:** `requested`, `completeCount`, `requestedBytes`, `measuredBytes`, and `status` (`complete` only if **every** sample completed; otherwise `INCONCLUSIVE (incomplete samples)`).
- **rc:**

  | rc | meaning |
  |---|---|
  | 0 | all 4 complete |
  | **5** | INCONCLUSIVE (counts in the result) |
  | 3 | refused, nothing read |
  | 4 | identity change, an escaped holder, or a failure after reads began: **STOP** |
  | 128+N | cancelled |

- **No inference** of whole-DB validation or a copy ETA.

## Tests (7; root runs them)
| test | from | covers |
|---|---|---|
| 1 | r1 | deterministic selection, wholly inside **written** extents, 1 MiB aligned, ≥ 1 GiB apart |
| 2 | r1 | refusals: unwritten/short only, overlap, malformed, crowded, more than 256 MiB |
| 3 | new | the real `read -C` stats parsed with bytes == requested; the known-pattern positive at both offsets; the wrong-pattern negative (`completeCount` 1); fixture unchanged; no data in the output |
| 4 | new | **qualified lifecycle bounds:** `sleep` timeout → `timedOut`; `sleep & exit` → `heldOpen` (stdout held by an orphan; group killed); `yes` → `cut` at 64 KiB. Each incomplete, not `escaped`, under 20 s, with no `sleep 301/302` left. A budget that cannot fit a worst case → every sample **skipped, never started**; more than 256 MiB refused |
| 5 | r1 | a process naming the original is seen; a writable file is refused |
| 6 | new | **parent SIGTERM during an in-flight read** (driver subprocess, handlers as in `main`): exit **143**, `cancelled 15`, and the owned `sleep 3141` is **gone** (killed and reaped before exit) |
| 7 | new | `summarize` gives exact counts; any incomplete or skipped sample makes the run INCONCLUSIVE; empty is INCONCLUSIVE; all complete is `complete` |

## Root commands
**Fixtures first** (512 lane; never touches the original):
```
bash jobs/q-exit-status.sh seqprobe-r2-tests 512 bash recovery-sequential-probe-stage/r2/jobs/tests.sh
```
Expect `## PASS (7)`.

**Then the bounded real timing.** It refuses unless `logs/seqprobe-r2-tests.rc` = 0, and also if anything names the original:
```
bash jobs/q-exit-status.sh seqprobe-r2-real 512 bash recovery-sequential-probe-stage/r2/jobs/root-real.sh
```
Read `result.json` `summary` first; any `INCONCLUSIVE` (rc 5) means the rates are not usable as a measurement.

## Limits (unchanged in meaning)
- **Page cache is not controlled.** A cached range times as cached.
- **The rates include** qemu-io's start and image open, and they are taken **under concurrent load**.
- **Four 64 MiB samples** are not a whole-DB, copy or validation ETA, and not an isolated-disk or FUSE/HDD attribution (see the 1738 corrections).
- **Original write, download and VM boot stay paused.** This is read-only timing only.
