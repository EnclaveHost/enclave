# 1810: composite-memory-fixture-stage/r1, a bounded SYNTHETIC memory mechanism fixture (FROZEN, NOT RUN, NOT PASS)

**Scope:**
- **What I executed:** text writing; `ast` parse; `bash -n`; `sha256sum` of the pinned tools, helpers and the new stage; reading root 1809 (`e500ef6f…`), the r6 runtime and r3 core function names, and `/proc/self/cgroup` (format only).
- **Not done:** tests, builds, mounts, probes, scope changes, queue jobs, or live part/original reads. No frozen stage, shared queue, recovery driver or production asset was modified.

## LIMITS (root 1809; also at the top of the stage README and in every receipt)
1. **`MemoryHigh` is a reclaim/throttle threshold, not a ceiling.** It can be exceeded.
2. **The OOM victim (scope `memory.max` = 768 MiB) is not guaranteed** to be the walker. Cleanup never assumes a victim.
3. **The controller's soft stop samples every 0.25 s and races the outer guard** (tree VmRSS every 250 ms, then all-at-once TERM, then KILL after 2 s) and other host allocations. The margin reduces the risk; it is **not a guarantee** of ordered cleanup.
4. **Page-table growth is the measured quantity.** No expected value is asserted.
5. **The data is synthetic** (a zero-filled sparse raw image), not MDBX. A MEASURED result says nothing about production database integrity, canonical state or RPC readiness, and does not qualify the production lane.

## Stage `composite-memory-fixture-stage/r1/`: `SHA256SUMS` sha256 **`d888cfef12360c0f00c74170a984a7257504071b150d4f170cbbdc72cf1d15f5`** (7 entries, read-only)
| file | sha256 | role |
|---|---|---|
| `memory_fixture.py` | `c0eb2e97fd10681a235a59e5927fe6301c88331f6ee588ea4dce7409b186a724` | the controller (subclasses the qualified r6 Session) |
| `walker.py` | `bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113` | the measured child (pinned inside the controller too) |
| `tests/test_memory_fixture.py` | `1a2af19e0ba6c781a89b683feb8479423da4fce75f7a0f3075b5c145e507b2a7` | 7 tiny unit/negative tests |
| `jobs/common.sh` | `201cf419…` | stage + r6 pins; reuses the **qualified r6 guards** |
| `jobs/tests.sh` | `519ab99b…` | unit tests (512 main lane), gate `Ran 7` |
| `jobs/run-fixture.sh` | `05c88e7a…` | the fixture (768 main lane), peers before/after, job receipt |
| `README.md` | `cb155fe2…` | |

**Pins checked by the controller before use:**

| item | sha256 | note |
|---|---|---|
| r6 runtime | `407aa7e9…` | its own pins for qemu-nbd `b0f16ff7…`, nbdfuse `51c1a1fd…`, fusermount3 `c3d04bdf…` and r9 `overlay_session.py` `65d45ab7…` are re-hashed |
| r3 core | `3159890b…` | |
| production manifest | `f94807f7…` | read only for the reservation arithmetic |
| `/usr/bin/systemctl` | `6e727451…` | |
| `/usr/bin/python3` | `375532f8…` | python 3.14 |
| `walker.py` | `bb01105d…` | executed as a private, re-hashed copy |

## Reuse, not a new framework
**The qualified r6 `composite_session.py`** is compiled from its exact pinned bytes, and `FixtureSession` subclasses its `Session`. The following are r6's unchanged code:
- owned run-dir and work-dir claims, under signal deferral;
- `spawn` (own group, the r9 `limits`: RLIMIT_FSIZE 64 MiB, no core, PDEATHSIG);
- `bind_child` (pidfd + start time + exact cmdline + exe inode), `wait_for`;
- `end_child`/`unmount` (with recorded errors), the lazy detach of OUR dead mount only, `reap_adopted`, `holders`;
- the ordered **`cleanup()`**: walker group, then adopted, then fusermount3 of our mount, then nbdfuse, then qemu-nbd, then pidfds/logs, then socket, then holders/mounts/children;
- `deferred()`, `_on_signal`, `Stop`, the subreaper.

**From the pinned r9 helpers** (via r6's own loader): `stop_group` (signals only an unreaped leader's group), `exited_nowait`, `group_members`, `mounted`, `all_pids`, `proc_fields`.

**From the r3 core:** `load_manifest` (with production pins), `open_dir`, `exists_in`, `rec_name`, `majmin`, `findmnt_uuid`, `is_usb`, `free_bytes`.

**The new code is small:** the pure checks, the scope setter, the meters, and `prepare`/`expose`/`use`.

## Safety design, item by item
- **Lane and exclusivity:**
  - the shared queue's **768 MiB main lane only**. The run job is `bash jobs/q-exit-status.sh cmf-r1-run 768 …`; the tests run in 512;
  - its single exclusive main flock keeps it apart from 1024 MiB preservation batches;
  - no queue change, and the recovery driver is not stopped.
- **Setup refusals:**
  - the qualified r6 `guards`: pinned stages, `/dev/fuse`, `session_guard.py` refusing a **live** orchestrate/overlay_session/composite_session (with PID and argv), and recovery/overlay/composite stage mounts;
  - plus our own stage mount;
  - plus the latest **passing cmf-r1-tests** receipt for these SUMS.
- **Exact scope and PID binding (refuse on any failure; never the manager or parent):**
  - `/proc/self/cgroup` is exactly one entry: this user's manager, then `…/run-*.scope`;
  - `memory.max` = 805306368 exactly;
  - `--tree-root-pid` (the job bash, which the guard watches) is our **ancestor** and is in the **same cgroup**;
  - `systemctl --user show -p ControlGroup` of the unit **equals** our cgroup **before** any change, and `memory.high` was `max`;
  - `set-property --runtime UNIT MemoryHigh=512M`;
  - then own `memory.high` = 536870912, `memory.max` unchanged, the **parent cgroup's `memory.high` unchanged**, `systemctl show MemoryHigh` = 536870912, and we are still listed in the scope's `cgroup.procs`.
  - A mismatch refuses **before** `set-property` is called (test 3).
- **Disk:**
  - the run dir is a new empty 0700 direct child of the stage `runs/`, on the **pinned root target filesystem** (majmin 253:0 = the manifest's, findmnt UUID = the manifest's, not USB);
  - free space ≥ Σ(root parts without a commit record) + the 40 GiB manifest floor + **8 GiB root reservation** + 64 + 16 MiB;
  - the image is an 8 GiB **sparse** file (`ftruncate`), **≤ 64 MiB allocated** before and after (a refusal otherwise), removed only after a complete cleanup and only if it is the same inode;
  - no write to `/vm`, USB, any part or the original.
- **Memory floor:** admission needs MemAvailable ≥ 16 GiB + 768 + 256 MiB. A soft stop happens at MemAvailable < 16 GiB + 512 MiB or tree VmRSS > 640 MiB (versus the guard's 768). Both stops are ordered: walker first, then r6 cleanup.
- **Bounds:**
  - the controller's total budget is 900 s; the walker gets the budget minus a 120 s cleanup reserve, and the controller has a hard stop at walker limit + 10 s;
  - the job adds `timeout -s TERM 1200` (**TERM only**, which the controller handles as an ordered cancel). Nothing in the stage ever SIGKILLs a non-owned process or signals the queue.
- **Exposure:**
  - `qemu-nbd --read-only --shared=1 --image-opts driver=raw,read-only=on,file.driver=file,file.filename=<image>`; it holds the image O_RDONLY (checked through fdinfo);
  - then `nbdfuse -r -C 1 -o ro … work/db/disk.raw`;
  - checks: ST_RDONLY, only `disk.raw`, size exactly 8 GiB, O_WRONLY refused.
- **The workload:** `walker.py` mmaps the file `PROT_READ`/`MAP_SHARED` with **MADV_RANDOM** (as libmdbx does for a DB larger than RAM) and touches **one byte of every 4 KiB page**, in order. That is 2,097,152 faults through FUSE, NBD and raw. It never reads the file into RAM.
- **Telemetry** (bounded receipt):
  - before and after: `memory.events` and `memory.stat` (`anon`, `file`, `file_mapped`, `pagetables`, `sec_pagetables`, `kernel`, `shmem`, `slab`, `(in)active_file`) and `current`/`high`/`max`;
  - every 0.25 s, peaks: tree VmRSS (the guard's metric), cgroup current, pagetables, walker VmRSS/RssFile/VmPTE, minimum MemAvailable;
  - every 2 s, ≤ 460 samples including the walker's Pss (`smaps_rollup`), which separates duplicated shared RSS;
  - the kernel release.
- **Outcome:**
  - **MEASURED** requires all of: walker rc 0, `scannedBytes` = 8,589,934,592, `nonzeroPages` 0, no group leftovers or escapees, **≥ 1 new `memory.events high`** (otherwise INCONCLUSIVE: the mechanism was not exercised), and a complete cleanup;
  - the run job's PASS additionally requires peers' FUSE mounts and qemu-nbd/nbdfuse/fuse2fs processes identical before and after, and no mount under the run dir.

## Tests (7; `jobs/tests.sh`, 512 main lane; no FUSE, mount, qemu or scope change)
1. **Scope parsing:** only this user's transient `run-*.scope` is accepted. A Chromium app scope, another user, the system slice, a child cgroup, multiple lines and empty input are all refused.
2. **Decisions:** the lane is exactly 768; the full remaining recovery reservation (the boundary is exact); the soft-stop thresholds.
3. **The setter**, against a fake cgroup tree and a fake systemctl:
   - success is verified;
   - **a scope mismatch and an "already set" both refuse without calling `set-property`**;
   - a setter failure, a value not applied, and a parent changed all refuse.
4. **Sparse cap:** an 8 GiB sparse file passes; an allocated file over the cap refuses.
5. **The walker** on tiny files: all zero gives rc 0 with exact counts; a nonzero page gives rc 1; a size mismatch gives rc 2.
6. **Ordered cancellation through the real r6 cleanup:** an owned `sleep 300` (the walker's place) is stopped first, then r6 `cleanup()`. Required: returncode set, cleanup complete, nothing alive or left, no mount.
7. **Outcomes never overclaim:** no high event gives INCONCLUSIVE; a short scan or a killed walker gives FAILED; a soft stop, a timeout, a late refusal, a cancel and an incomplete cleanup each map correctly.

**Not unit-tested** (the fixture run is the evidence): the real `systemctl set-property` on the queue scope, FUSE page-cache charging, reclaim and page-table behaviour, and the soft stop under real pressure. A real-pressure soft stop needs memory pressure, which the tiny lane cannot safely provoke on purpose.

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmf-r1-tests 512 bash composite-memory-fixture-stage/r1/jobs/tests.sh      # expect "## PASS (7)"
bash jobs/q-exit-status.sh cmf-r1-run 768 bash composite-memory-fixture-stage/r1/jobs/run-fixture.sh  # expect "## PASS (fixture MEASURED)"
```
**Where to read:**
- the controller receipt: `runs/fixture-<id>/receipt.json` (peaks, samples, scope before/after, reservation, walker result);
- the job receipt: `runs/job-<id>/receipt.json`.

## Unproven until root's run (each would be a visible refusal or failure, never a silent pass)
- **(a) `set-property` on the queue's scope:** `systemctl --user set-property --runtime` on a transient scope created by `systemd-run --user --scope` from the queue. It needs the user bus at `/run/user/<uid>` and permission on our own scope.
- **(b)** `nbdfuse MOUNTPOINT/FILENAME` with `disk.raw`.
- **(c) Charging:** FUSE page cache charged to our scope (the walker faults it).
- **(d) Speed:** 2,097,152 single-page FUSE round trips inside the walker budget (about 780 s); otherwise TIMEOUT.
- **(e) Soft-stop risk:** a soft stop at 640 MiB is possible if MemoryHigh overshoots under fast faulting. That is a recorded SOFT-STOP, not a pass.
- **(f) What is measured, not asserted:** whether the 512 MiB high actually keeps mapped RSS below the guard, and how large page tables become.

**What a MEASURED result would and would not establish:** it measures the reclaim and page-table mechanism at 8 GiB on this kernel. It is evidence for, but not a qualification of, any production lane or setting.
