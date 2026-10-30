# 1699: recovery-overlay-stage/r6 (FROZEN, NOT run), built from r5 for root 1697

**Status:** source frozen, NOT run.
- **Stage:** `recovery-overlay-stage/r6/`, **`SHA256SUMS` sha256 `4079a5c727efdfff65e327fa1b210734383283e40fe0c6fc41944241b84208b6`** (10 files, read-only).
- **Preserved:** r1 through r5 all re-verify.
- **Executed by me:** text edits, `ast.parse`, `bash -n`, `sha256sum`, reading root's r5 run logs.
- **Not done by me:** tests, builds, mounts, qemu, FUSE, USB, or reads of the original.

## Root 1697 (r5: 20 executed, 14 PASS, 6 FAIL; plus a peer-snapshot false failure)
1. **`qemu-nbd: socket path must be absolute`** (`r5/runs/tests-20261026T211630Z-2362059/work/03-run/work/qemu-nbd.out`). The relative `nbd.sock` of r5 is refused by qemu-nbd, so the same 6 exposure tests fail. Every receipt still shows `cleanupComplete`, `parentUnchanged` and `noMountsLeft`.
2. **`peersUnchanged: false`:** the only difference is PID 2360000, present before and gone after.
   - **The cause:** r5's `pgrep -f 'qemu-nbd|nbdfuse|fuse2fs'` matches **command-line text**, so any transient shell or CLI call mentioning those names counted as a "peer".

## r6 changes
**`overlay_session.py`** (r5 `99493044…` → r6 `11b51826…`):
- **The socket argument:** **`SOCK_ARG = "/proc/self/cwd/nbd.sock"`** (absolute, 23 bytes) is used by **both** children:
  - `qemu-nbd --socket=/proc/self/cwd/nbd.sock`;
  - `nbdfuse --unix /proc/self/cwd/nbd.sock`.

  Both are spawned with **`cwd=self.work`**, our private 0700 work dir.
- **How it resolves:** the kernel resolves `/proc/self/cwd` per process (the thread-group leader, so threads see the same cwd), giving the socket file `<work>/nbd.sock`.
- **Why the path stays short:**
  - qemu checks only that the string is absolute and that it fits in `sun_path`;
  - libnbd uses the string as the `sun_path`;
  - neither canonicalizes it (per their sources, as I recall them; root's run is the confirmation).
- **New check:** before `nbdfuse` connects, `self.sock` (the full path) must `lstat` as an **`S_ISSOCK` owned by this user**. Otherwise the run is refused.
- **Unchanged:**
  - `self.sock` is used for the readiness check and the cleanup unlink;
  - all image (`--image-opts`), mountpoint, pid-file and private `fuse2fs` paths are absolute;
  - no `/tmp`, no shared path;
  - bounds, process ownership and cancellation, `ST_RDONLY`/plan/GO bindings and every read-only layer are as in r2–r5.

**`jobs/common.sh` `peer_snapshot`:**
- `pgrep -u UID -x -a 'qemu-nbd|nbdfuse|fuse2fs'` uses **exact process names** (`comm`; all three names are under the 15-character limit).
- The command line is used **only** to exclude this stage's own `runs/` (`grep -v -F "$S/runs"`; our children's command lines always contain it, including the private `fuse2fs` copy).
- **Not ignored:** any other difference (a peer gone, new or restarted) still makes `peersUnchanged` false and fails the run. The mount half of the snapshot is unchanged.

**Other files:**
- **Test 8:** asserts `SOCK_ARG == "/proc/self/cwd/nbd.sock"`, its use by both children, and `cwd=self.work` exactly twice. The count is still 20.
- **README:** an r6 section.
- **Jobs:** only the `r5`→`r6` path and label substitution, plus the `peer_snapshot` change.
- **Byte-identical to r5:** `overlay_plan.py`, `fixture/make_fixture.py`, `fixture/make_jbd2_inputs.py`.

| file | sha256 |
|---|---|
| `overlay_session.py` | `11b51826…` |
| `tests/test_recovery_overlay.py` | `7df4d917…` |
| `jobs/common.sh` | `463e23fb…` |
| `jobs/tests.sh` | `af0e3167…` |
| `jobs/root-plan-real.sh` | `ec5da5b8…` |
| `jobs/root-expose-real.sh` | `98d06960…` |
| `README.md` | `852db8b9…` |
| `overlay_plan.py` | `78e573f6…` |
| `fixture/make_fixture.py` | `7cece25e…` |
| `fixture/make_jbd2_inputs.py` | `dd2390a1…` |

**Root:**
```
bash jobs/q-exit-status.sh rov-r6-tests 512 bash recovery-overlay-stage/r6/jobs/tests.sh
```
All 20 tests are mandatory: expect `## PASS (20)`, plus `peersUnchanged` and `noMountsLeft`.

## Candid limits
- **The fallback is not implemented.** If qemu-nbd or libnbd turns out to canonicalize `/proc/self/cwd/…` into the long real path, the 6 tests fail again with "too long", visibly and with cleanup complete. The next step would be a private 0700 `mkdtemp` under `/tmp` with its identity (dev, ino) captured and an identity-checked cleanup. I did not add it now, to avoid a second external path that might never be needed.
- **Behind the socket fix,** the 6 tests reach code that has never run:
  - `nbdfuse` in the foreground with `-P` and `-C 1`;
  - `fuse2fs` option order with `-f`;
  - read-back and write refusal;
  - the validator rc-6 and timeout paths;
  - the SIGTERM/SIGKILL hold tests (test 20 needs libfuse to unmount within 30 s after `PDEATHSIG`).

  Each fails closed with cleanup and a receipt.
- **The peer check is now precise but still strict:** a peer process that legitimately restarts during the about 1 minute run fails it by design (root must not ignore that).
- **Unchanged:**
  - the synthetic JBD2 inputs are not a journal;
  - the chronology covers only the surviving history;
  - the data blocks are not authenticated (a diagnostic view only);
  - the real exposure needs the 1659/1698 offline gate review, root's GO file, and explicit approval. No original exposure has occurred.
