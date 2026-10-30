# Independent SOURCE-ONLY review: `recovery-overlay-stage/r1` (1671), 2026-10-26 20:58–21:10Z

**Bytes:**
- `SHA256SUMS` sha256 **`a8243779228b7cce400f081721a16ebd701cc5a681c62cd0a39f0fb9bcd7430a`**; `sha256sum -c` OK for all 9 files (unchanged; I did not alter the stage).
- **Read fully:** `README.md`, `jobs/common.sh`, `jobs/root-plan-real.sh`, `jobs/root-expose-real.sh`, `jobs/tests.sh`, `overlay_session.py` (387 lines).
- **Grepped only:** `overlay_plan.py`, `fixture/make_fixture.py`, `tests/test_recovery_overlay.py` (I/O, subprocess and parent-path usage).
- **Local tool help only:** `nbdfuse --help`.

**Not done:** no tests, builds, mounts, USB or peer access, and no runtime commands.
- **Original (per HANDOFF):** `/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2`, on the peer's read-only NTFS mount.
- **Peer processes:** nbdfuse 2253790 and qemu-nbd 2253798. I did not touch them.

## Verdict
| run | verdict |
|---|---|
| **Fixture-only** (`jobs/tests.sh`) | **OK for root to run as written.** It touches only a new dir in this stage's `runs/`. It executes, but never modifies, the peer's pinned `fuse2fs`. It reads `/proc` and mountinfo for the peer snapshot. **No USB, original or peer resource.** The worst case is a stale FUSE mount inside `runs/` after an abnormal kill (B1), harmless to originals and peers. |
| **Offline real plan** (`root-plan-real.sh`) | **OK.** Local journal copy and sha-pinned JSON only, under `unshare -Urn`. Writes one plan dir. |
| **Real exposure** (`root-expose-real.sh`) | **NOT yet:** fix B1-B3 (small) and confirm B4 with the fixture first. There is **no write path to the original** (see "What holds"); the blockers are about leaked processes and mounts on the peer's file and about gate rigor. |

## What holds (verified in source)
- **The original is never opened for writing:**
  - `os.open(parent, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` (`overlay_session.py:132`), and `os.access(W_OK)` is refused (`:139`);
  - the job checks `findmnt … ro` and `[ ! -w ]` (`root-expose-real.sh`);
  - `qemu-img create -u` never opens the backing (`:163`);
  - every qemu open uses `backing.read-only=on`, plus `read-only=on` for qemu-nbd (`:82-84`, `:206`);
  - `qemu-nbd --read-only`, `nbdfuse -r`, and `fuse2fs -o ro,norecovery` give three independent read-only layers, so even an rw `fuse2fs` could not write: the nbd file is read-only.
  - **Partial-cluster COW** in `qemu-io` only **reads** the backing and writes the new overlay.
- **Identity:** dev/ino/size/mtime/ctime are recorded before and re-checked after (`:141`, `:335-343`); a mismatch gives rc 4. The fixture adds a full sha256.
- **Ownership:** only our own `Popen` handles are signalled (`:297-303`), and the leader is unreaped until waited, so its PID cannot be reused. `fusermount3 -u` runs only on our two mountpoints, and only if they are mounted (`:292-293`).
  - The job's `peer_snapshot` compares peer FUSE mounts and qemu-nbd/nbdfuse/fuse2fs PIDs before and after (`common.sh`).
- **Bounds:**
  - patch sources ≤ 4096 B, each sha-checked (`:125-130`);
  - plan ≤ 16 MiB;
  - `fuse2fs` sha read ≤ 16 MiB;
  - overlay ≤ 64 MiB (`:181`);
  - samples are planned (≤ 64);
  - the fixture full read is ≤ 256 MiB;
  - `fuse2fs` `cache_size=64M`;
  - receipts are written with O_EXCL 0600.
- **Refusals before exposure:** a work dir that is not new, < 1 GiB free, an unpinned `fuse2fs`, a writable parent, a parent with its own backing, a patch outside the filesystem.

## Blockers for the REAL exposure (with concrete fixes)
### B1. Abnormal termination leaks our children and mounts, which then hold the peer's original open
- **The children are spawned with `start_new_session=True`** (`:191`), so a signal to the job's process group never reaches them.
- **Python has no SIGTERM/SIGHUP handler.** When the job's outer `timeout -k 30 90000` sends TERM, or the queue's memory guard kills the tree, `main()`'s `finally` (`:369-382`) **does not run**.
- **The result:** `qemu-nbd` keeps the original qcow2 open (read-only), and the `nbdfuse`/`fuse2fs` mounts stay in `runs/`. These are **unowned processes on the peer's file**, so if the RAID chat needs to unmount or replace its read-only NTFS mount, it is blocked. No write, but it violates "preserve peer processes/resources".
- **Even a caught TERM** gets only 30 s before KILL, while `end_child` may wait up to 3 × (20 + 10 + 10) s.
- **Fixes:**
  - (a) `signal.signal(SIGTERM|SIGINT|SIGHUP, lambda *_: raise_stop())`, raising an exception class that `main` handles, so `finally` → `cleanup()` runs;
  - (b) `preexec_fn` setting **`PR_SET_PDEATHSIG` = SIGTERM** on all three children, so a SIGKILLed Python still ends them; libfuse unmounts on SIGTERM;
  - (c) cut the waits to ≤ 5 s each, or give the job `timeout -k 300`;
  - (d) a fixture test that SIGTERMs, and one that SIGKILLs, the session mid-hold, then asserts no child, no mount, and the parent unchanged.

### B2. The validator (`--exec`) process group can outlive the session undetected
- **The cause:** `subprocess.run(…, timeout, start_new_session=True)` (`:277`) kills **only the leader** on timeout. Any helper processes keep `RECOVERY_TARGET` open, so `fusermount3 -u` fails with EBUSY.
- **Why it goes undetected:** the leftover scan (`:323-333`) matches **cmdlines containing the work dir**. A validator only has the path in its **environment**, so it is not detected.
- **Effect:** the mount stays busy or stale, rc 4, and an unowned process keeps reading the original.
- **Fixes:**
  - run the validator with `Popen` in its own session and `PR_SET_PDEATHSIG`;
  - after it exits or times out, `killpg(pgid, TERM)` then `KILL` while the leader is still unreaped (`waitid(WNOWAIT)`);
  - extend the leftover scan to `/proc/*/{cwd,root,fd/*}` readlinks under `self.work`.
  - **Test:** a validator that forks a sleeper holding the target, then times out; assert the sleeper is gone and cleanup is complete.

### B3. The transient-reuse gate is only "a non-empty regular file"
- **The cause:** `root-expose-real.sh` accepts **any** non-empty file as the 1659 gate receipt and only records its sha.
- **Fix:** take `GATE_SHA256` as an argument, and require the receipt JSON to say pass and to bind **this plan's** `plan.json` sha256 and the journal sha `d95d81fc…`.
- **Also:** take the expected `plan.json` sha256 printed by `rov-r1-plan`. The plan dir is owner-writable under `runs/`, and the session only recomputes and records the sha (`:121`).

### B4. Confirm with the fixture: `nbdfuse` connections vs `qemu-nbd --shared=1`
- **The concern:** `qemu-nbd --read-only --shared=1` (`:206`) allows one client. `nbdfuse` accepts `-C N` (local `--help`) and may open several connections when the server advertises multi-conn, as read-only qemu exports typically do (not verified locally). Extra connections would never be served, and the `nbdfuse` mount wait would time out (`:212`).
- **This fails closed.** It is also not "exactly the peer's pattern": per HANDOFF the peer chain is `nbdfuse -r … [ qemu-nbd -r … ]` in command mode.
- **Fix:** pass `-C 1` to `nbdfuse` explicitly, and correct the README wording. The fixture run will show it either way.

## Non-blocking findings
- **N1. `fuse2fs` is sha-checked, then executed from the peer's path** (`common.sh`, `:117`, `:218`); the binary could be swapped in between. **Fix:** copy it with a bounded read into the private run dir, verify the sha of the copy, and execute the copy.
- **N2. `exec.out` is unbounded** (`:275`). **Fix:** `RLIMIT_FSIZE` (e.g. 64 MiB) in the validator's `preexec_fn`, or a bounded pipe reader.
- **N3. Hold mode:** a human shell `cd`'d into the mount makes the unmount EBUSY, giving rc 4 and a stale mount, with the overlay kept. **Fix:** document "inspect only through the validator/STOP; never cd into the mount", or unmount lazily (`fusermount3 -uz`) **only** after the children are reaped, recorded as such.
- **N4. `run()` buffers** qemu-img/qemu-io stdout and stderr unbounded. They are small in practice; capping them is optional.
- **N5. `rc` after an exception in `checks()`:** `rc = 3 if not patchesReadBack else 1` relies on dict truthiness. That is correct but subtle: a failed read-back still exists as a dict, so rc is 1. Fine.

## Approval distinction
- **Fixture-only** (`rov-r1-tests`): root may run it now. It is independent of the original, the USB and the peers. The expected PASS is 8 tests (`jobs/tests.sh` receipt, including `peersUnchanged`).
- **Offline real plan** (`rov-r1-plan`): root may run it now; it is local-only.
- **Real exposure** (`rov-r1-expose`) needs all of:
  - B1-B3 fixed in a NEW stage (r2) plus its fixture PASS, including the signal-death tests;
  - B4 confirmed;
  - the 1659 gate passed with a bound receipt;
  - root's explicit go.

  It opens the **original** read-only through new processes while the peer is active, so it is a separate approval from the fixture run. USB writes and the download stay paused; nothing here needs them.
