# RPC VM NVMe migration: finalize from root's copy receipts (root notes v3, 2026-10-25)

**Scope:** phase 1 moves only the `os` and `l1` disks to the T710 NVMe (`/vm`, ext4 on cryptvm). Base stays on the HDD.
The user's 2026-10-25 override authorizes NVMe chain storage and removes the former 250 GB NVMe cap. **300 GB free is
operator policy, not a user cap.**

The copy itself was done by root with the frozen helper `../nvme-copy/executed/nvme_copy.py` (sha `e48a7cb8…`), byte for
byte, verified by re-reading the copy. This directory only ingests those receipts and STAGES a v2 install. It installs
nothing, starts nothing, and never copies a disk.

## Files

| File | sha256 | Purpose |
| --- | --- | --- |
| `migrate_nvme.py` | see `SHA256SUMS` | adapter: `plan` / `copy` (not used for this rollout) / `finalize` / `finalize-receipts` |
| `../provision_vm.py` | `8b1ece11…` | launcher v1 + v2. v1 renders are byte-identical |
| `plan-final-20261025T165151Z.json` | `c1b3d9e6…` | retained plan. It pins launcher `4f458aa1…` and v1 manifest `ecbe7b65…`; the source stats match the receipts |
| `fixtures/v1-installed/` | `ecbe7b65…` / `abe7744c…` | golden copy of the installed v1 manifest and unit at copy time |
| `ROOT-FINALIZE-COMMAND.txt` | see `SHA256SUMS` | the exact command for root, run after `copy-l1.receipt.json` has status ok |
| `test_*.py`, `logs/` | | tests and compact logs with the exact cases that ran |

The fixtures were inspected field by field before publishing. They contain paths, hashes, serials, guest UUIDs, MAC, the
SSH **public** key and its fingerprint. They contain no private key, JWT or secret config.

## finalize-receipts checks

**Receipt (pure):**
- format `enclave-nvme-copy-receipt/v1`, pinned helper sha, `status == ok`;
- source path/dev/ino/size equal the plan's, and `sourceBefore == sourceAfter`;
- the copied source's dev/ino/size/mtime equal the plan's recorded stats;
- target dir/name and `final` equal the plan's destination;
- the VM unit inactive/failed with MainPID 0 before the lock, after the lock and after the copy;
- reserve ≥ 300 GB;
- `copySha256` is 64 lowercase hex digits and equals `sourceSha256`;
- `bytes` equals the planned size, `finalInode` is present, and allocation is ≤ the planned bound;
- one receipt for every planned disk.

**Host, at finalize time:**
- VM and guard units stopped;
- the source's lstat equals the receipt's `sourceAfter` on dev, ino, size, mtime, ctime, nlink and mode;
- the target is a private, single-link regular file of uid 1000 on `/vm`, with the receipt's inode and size;
- the target's mtime and ctime are ≤ `finished` + 1 s. The receipt has 1 s precision, so this is a bound, not
  exact-mtime equality;
- read-only `qemu-img info` (no `-U`, so a held image is refused) and `qemu-img check` (never `-r`).

**Why there is no 495 GB re-hash.** The helper's `link()` sets ctime before `finished`. A later write moves mtime and
ctime, a substitute file is a new inode, and an unprivileged user cannot set ctime. That catches uid-1000 accidents and
substitution, but **not** root rewriting the file and resetting time. If the timestamps cannot vouch, finalize refuses,
unless `--rehash-if-stale` is given and a full re-hash matches.

**Launcher re-pin.**
- `--launcher P --accept-launcher-sha S` is needed whenever the launcher differs from the plan pin, **including at the same
  path**.
- Staged `files.launcher` is always the accepted sha, and the staged launcher copy is re-hashed against it.
- **Fixed defect (root review, 17:04):** a same-path re-pin used to keep the plan sha and was refused at staging. Root's
  regression `test_same_path_launcher_repin` now passes.

**Immutable guest config.** Refused if changed:
- name, uid, mac, instanceId, SSH public key and fingerprint, baseImage, ports, RAM/CPU block;
- every disk's serial, guest UUID, label, mount, bytes, role and format;
- the seed render and the guest disk config.

## Launcher changes since the plan pin (`4f458aa1…` → `8b1ece11…`)

| # | Change |
| --- | --- |
| 1 | Wording: 300 GB is operator policy, the 250 GB cap is historical |
| 2 | `validate_v2`: dir-inside-mount check correct for `/` |
| 3 | Guard unit: `TimeoutAbortSec=10` and `TimeoutStopSec=30`; a hung guard stops the VM in about 30 s (measured) |
| 4 | Missing backing dir: clean REFUSED (exit 2) |
| 5 | `Qmp.close` closes both the makefile and the socket |
| 6 | `cmd_powerdown`'s wait loop uses raw `recv` with bounded timeouts, never a makefile read after a timeout |

Change 6 fixes the 16:36 `OSError: cannot read from timed out object` ExecStop failure. Its regressions are a fake
timeout→events→EOF case and a real QEMU clean exit; both pass.

## Tests that ran (no skips; queue at 512 MiB, 16 GiB floor; `logs/`)

**Published layout, 2026-10-25T17:18:43Z.**
- `test_nvme_migration.py` 17/17: v1 argv and unit parity against the golden fixture, guard policy and loop,
  `validate_v2`, the plan/copy/finalize mechanics, and install/rollback.
- `test_receipts.py` 19/19:
  - receipts come from the real pinned helper run on disposable qcow2 images;
  - a positive staging case;
  - negatives: wrong helper, unequal hash, non-hex hash (three forms), wrong target, wrong inode, failed status, unit
    active in the receipt, source differing from the plan, missing L1, VM or guard active now, source touched after the
    copy, stale target mutation (also with `--rehash-if-stale`), metadata-only change (needs rehash, which then
    passes), same-name substitute, target held by QEMU;
  - launcher re-pin: different path, and same path.

**Stage layout, same launcher `8b1ece11…`, not repeated.** Since these runs, only the path resolution changed.
- `test_real_qemu.py` 5/5 (powerdown regressions, guard on the real second monitor, floor watch, discard).
- `test_systemd_lifecycle.py` 2/2, in a disposable nested `systemd --user`:
  - real guard, fake `-machine none` VM child;
  - READY before the VM starts, watchdog held, clean double stop on QEMU exit;
  - guard SIGKILL or hang → VM stopped;
  - fail-closed pause, PartOf stop, startup refusal → VM never starts;
  - an unrelated unit stayed up throughout;
  - `verify` passes with no guard running.

**Paths for running the tests.** They use `PROVISION_VM_LAUNCHER`, `NVME_COPY_HELPER` and `TEST_TMP` when set. Otherwise
they fall back to `../provision_vm.py` and `../nvme-copy/executed/nvme_copy.py`.

## Rollout and rollback

**Rollout.**
1. Run `ROOT-FINALIZE-COMMAND.txt`, then review `staged-final/`.
2. With the VM stopped, run `staged-final/install.sh`. It checks the old shas, backs up to `backup-<planid>/`, installs,
   daemon-reloads and runs `verify`. `verify` does not need the guard.
3. `systemctl --user start enclave-rpc-production-vm` pulls the guard unit.

**Rollback (`rollback.sh`) is not an exact-state rollback.** It points the VM back at the HDD `os` and `l1` images. Those
were stopped cleanly after root's 16:42 recovery and are now stale. The Base disk on the HDD keeps advancing either way.
- The old OS disk loses any change made after the migration; re-apply them.
- The old L1 recovers forward by resyncing.
- Base waits on L1 RPC until L1 catches up.
- Never attach both copies to one guest: they share serials and ext4 UUIDs.
- Prefer rolling forward.
