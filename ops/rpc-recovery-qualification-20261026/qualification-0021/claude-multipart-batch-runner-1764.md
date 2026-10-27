# Batched multipart preservation runner for parts 1..264 (1764). Source only; nothing run

**Not done by me:** no read of original data, no queue job, no test, build, commit or live command. multipart **r3 is unchanged** (SUMS `fcd8e097…`, verified).
- **Read (small metadata only):** the production dir `outputs/rpc-production-final-20261025/base-multipart-production-20261026` (manifest `f94807f7…`, copy request `ad14886f…`, verify request `1728b7b6…`, admission snapshots); root's canary and bulk jobs (`jobs/root-canary-copy-1758.py`, `-verify-1761.py`, `root-bulk-copy-1762.py`); `jobs/q-exit-status.sh`; `claude-test-queue.py`; the r3 wrapper and core.

## Files (new; not frozen in a stage, hashes for review)

| file | sha256 |
|---|---|
| `jobs/root-multipart-batches-1764.py` | `773d18dd8838806e1be4dd0a27f45247511bc9d315628e32b67cf8f86808d700` |
| `jobs/test_root_multipart_batches_1764.py` (**9 tests**) | `c19ca98a7af2c37f3c17aef3073111a184223fff0c39b55a58e71526e25f32be` |
| `jobs/root-multipart-batches-1764-tests.sh` | `eeef09ada3c69823d1ea03c2f65b656c081ab5b46d7f553d96bacf72ebea774b` |

## Design (smallest robust form)
- **`drive`** (the OUTER driver, run by root directly and **not in the queue**):
  - creates a NEW `--out` dir with `run.lock` (O_EXCL: run id, pid, start time, plan) and `batches.jsonl`;
  - for each batch of ≤ 8 parts from `--start` (default 1) to `--stop` (default 264; 33 batches 1-8 … 257-264) it runs **one queue child per mode**, sequentially: `bash jobs/q-exit-status.sh rmp-r3-bLLL-HHH-{copy,verify}-1764-<run> 1024 python3 -I -B jobs/root-multipart-batches-1764.py batch …`;
  - **any non-zero rc stops everything**; parts, records and receipts are preserved and nothing is resumed;
  - each queue child is started in its own session, so a terminal ^C reaches only the driver.
- **`batch`** (the QUEUED job; fresh admission happens HERE, immediately before the wrapper):
  1. the r3 SUMS are re-verified before the core is imported; the manifest and request sha256 must be the pins; the driver's run lock must match; `active.json` is created O_EXCL (a leftover from an unclean stop refuses: inspect);
  2. **one view at a time:** refuses if any mount under `/recovery-multipart-stage/` or `/recovery-overlay-stage/` exists, or any `overlay_session.py` / `orchestrate.py` process runs (fixture runs included);
  3. **admission** (r3's own record rules per part; no saved hash alone):
     - **both targets:** every entry must be ours (marker, `part-NNNN.*`, `session-*.json`); anything else refuses. Target `st_dev` and findmnt UUID must be the manifest pins, and neither target on USB;
     - **every part < LO:** a valid commit record; the **current lstat == destIdentity** with nlink 1 and the exact length; a confirmed binding; AND a strictly valid **PASS measured after the commit in a CONFIRMED session** with a matching identity; no partial or checkpoint files;
     - **copy:** every part ≥ LO has **no file at all** (a fresh run; partial, stale or foreign state refuses; explicit resume is future work). **Verify:** parts LO..HI are exactly `.bin` + `.json`, committed in a confirmed session and not yet verified; parts > HI have no file;
     - **capacity, per target:** free ≥ (sum of the **exact manifest lengths of every not-committed part**) + the manifest floor (40 GiB) + 8 GiB on root. The admission is written O_EXCL to `admission-LLL-HHH-MODE.json`;
  4. the **unchanged** `recovery-multipart-stage/r3/jobs/root-preservation.sh REQ SHA MANIFEST SHA MODE LO-HI` runs as its own child (r9 guards, original mount `ro` and not writable, peer snapshot, mount check: all unchanged);
  5. **post-checks after wrapper rc 0** (rc 4 otherwise):
     - **copy:** every part LO..HI committed in **exactly one session absent at admission and CONFIRMED** in its target; parts > HI untouched; parts < LO still valid;
     - **verify:** every part LO..HI has a PASS in **exactly one NEW confirmed session that is not the copy session**; r3 `status` shows no stale, unconfirmed, invalid or failed part; parts < LO still valid.
- **Signals:**
  - **driver:** on SIGTERM/SIGINT it starts no new job and forwards SIGTERM **once** to the in-queue batch job. That job must be the pidfd-pinned descendant of the driver's own queue child with the exact cmdline and the pid/start time registered in `active.json`;
  - **batch job:** it forwards SIGTERM **once** to the pidfd-pinned `orchestrate.py run` descendant of its own wrapper child. orchestrate cancels at a safe point, the r9 session cleans up, and the wrapper finishes its peer and mount checks;
  - **never signalled:** no process group, and no peer job.
  - **Caveat:** the queue's own `stop()` (if root signals the queue process itself) TERMs every descendant and SIGKILLs after 1 s, which would cut a session's cleanup. **Do not signal the queue or q-wrapper processes; signal the driver.**

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rmp-batches-1764-tests 256 unshare -Urn bash jobs/root-multipart-batches-1764-tests.sh    # expect "## PASS (9)"
# after review + PASS, the driver runs OUTSIDE the queue (it only spawns one queue child at a time, 1024 MiB each):
python3 -I -B jobs/root-multipart-batches-1764.py drive --out /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-multipart-production-20261026/batches-1764-run1 [--start 1] [--stop N]
# graceful stop: kill -TERM <driver pid>
```
**Outputs:**
- `--out/batches.jsonl`, `run.lock`, and `admission-*.json`;
- per queue job: `logs/rmp-r3-bLLL-HHH-MODE-1764-<run>.{out,rc,guard}`;
- per session: `recovery-multipart-stage/r3/runs/prod-MODE-*`.

## Tests (9; `jobs/test_root_multipart_batches_1764.py`; synthetic target dirs in the r3 record schema; no session, queue or original)
1. The batch plan: 33 batches covering 1..264 in ≤ 8; bounded stops; invalid ranges refused.
2. A fresh copy admission accepts a verified part 0; it refuses a `.partial`, a later part's file, a foreign file, and a stale part 0 (utime after its PASS).
3. Previous parts need a CONFIRMED fresh PASS: no verify, an unconfirmed verify session, or a FAIL record all refuse.
4. The reservation is exact: the remaining logical bytes (root 2 parts, vm 3 parts) + floor + 8 GiB on root. Free == needed is admitted; one byte short refuses, per target.
5. Verify admission: the batch must be committed, confirmed and unverified; an existing verify record, an UNCONFIRMED copy session, or a missing commit all refuse.
6. Post-copy: one NEW confirmed session passes; an old session, two sessions, or a part written outside the batch fail (rc 4).
7. Post-verify: a NEW confirmed session that is not the copy session passes (r3 status clean, 3 verified); the copy session itself or an old session fails.
8. The signal target is only our own pidfd-pinned orchestrate descendant: a same-cmdline non-descendant is not chosen, and ambiguity (two candidates) is refused.
9. One view at a time: stage mounts and `overlay_session`/`orchestrate` processes are detected; peer `base-files` fuse mounts are ignored.

## Not done / limits
- **Not executed** by me.
- **Tests:** the unit fixtures do not run a wrapper or session; the real E2E path is r3's (already PASSed by root) plus root's part 0 canary.
- **Admission does not re-hash part bytes.** Previous parts rely on their verify PASS (a fresh source + destination re-read at verify time) plus the current inode identity. A full re-hash of up to 1.1 TB per batch was not added.
- **Unclean stops:** a crashed or killed batch leaves `active.json` and/or partial files. The next run then refuses until root inspects; there is no automatic resume.
