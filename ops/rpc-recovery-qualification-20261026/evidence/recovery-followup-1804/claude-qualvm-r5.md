# Qualification VM r5: rpc-qualification-vm-stage/r5 (PREPARED by Claude; NOT run, 2026-10-26 17:52Z)

**Status:**
- Source only.
- **Checks I made:** `ast` parse of both Python files and `bash -n` of the job. **No tests were run**, and nothing was built, mapped, mounted or booted; no network, no live action.
- **r1-r4 are frozen,** and their sums verify. The r5 job re-checks all four.
- **Activation stays forbidden** until `/vm` available is ≥ 385,899,345,920 B and root/KVM capacity coordination is recorded. `prepare` and `controller` thresholds are **unchanged**.
- **The new `inventory` mode** needs **no** capacity, because it only reads metadata.

## Stage (frozen)
`rpc-qualification-vm-stage/r5/SHA256SUMS` = **`53a1853572ddbed96e2472aaee0ca73b26ea0bf44882a67d834684cd75f24100`** (mode 0444)

| file | sha256 |
|---|---|
| `qualvm.py` | `3e96e02a31dce8287da2980780c4dca0fdaabca7399d8c33e2faa786cd9cf3a0` |
| `test/test_qualvm.py` (28 tests) | `1f967ebbddee7b6ed6dd30ad97783606d413a88988af2f7f470703612d834af1` |
| `jobs/root-qualvm-r5-tests.sh` | `130672d041b65b8e90113ee0a879bcd646a256e77274859b72e9c110d8fe51e0` |
| `README.md` | `61afa0a5616fe2caa590295c84c7c194467d6e2637f4ebcb1d1a0fbb6cd3714e` |

## Changes against r4 (only these)
**N1a: a missing directory is distinct from an error.**
- **How directories are resolved:** `resolve_dir` checks each path component against a **successfully listed** parent and follows fast symlinks (≤ 8 hops; noble's `/lib → usr/lib` gives `alias`).
- **What counts as absent:** a component missing from a good parent listing. Absence is never inferred from debugfs error text.
- **`list_dir` accepts a listing only if** rc is 0 **and** it contains its own `.` and `..` entries; otherwise it is an error, never "empty".
- **Also errors:** an existing non-directory, an unreadable or slow symlink, a link loop, or the 600-request debugfs budget being exhausted.
- **Required directories:** `/etc/systemd/system` and `/usr/lib/systemd/system` must resolve **and** list at least one entry.
- **Optional directories:** may be absent, never erroneous.

**N1b: coverage.**
- **System units:** adds `/usr/local/lib/systemd/system`, and every `*.wants`/`*.requires`/`*.upholds` dir of **every** listed system dir (r4 covered `/etc` only). Files, symlinks, `X.d`, `X.wants` and `X.requires` all count as unit names, and the union is masked as in r4.
- **User-manager `enclave-*` units are problems** (refused by `prepare`), because `systemd.mask=` cannot mask them. Locations:
  - `/etc|/usr/lib|/usr/local/lib/systemd/user`;
  - `/root/.config/systemd/user`;
  - `/home/*/.config/systemd/user` (≤ 64 homes; non-literal names are problems);
  - their dependency dirs.
- **Linger:** **any** entry in `/var/lib/systemd/linger` is a problem.
- **Unchanged:** `prove`'s guest inventory must equal the mask set.

**Post-start floor recheck (`cmd_controller`):**
- **When:** after the VM unit starts and its InvocationID is recorded, the floor unit is re-read.
- **If it is not `active` with the ready-proven InvocationID:**
  - `postStartFloor` is recorded;
  - **our** VM invocation is stopped;
  - our floor is stopped only if it is still ours (a foreign or new invocation is never stopped);
  - the controller refuses.
- **Also:** the controller now loads the inspector through the same sha256 pin as `prepare`.

**New `inventory OUT` (read-only metadata):**
- **Preconditions:**
  - a queue lane with `memory.max` ≤ 512 MiB (`max` refuses);
  - `OUT` must be a NEW absolute path;
  - production pins and unit renders;
  - production units loaded and stopped; qual units absent;
  - the OS disk not open.
- **Mapping:** the same `nbdfuse -r` + `qemu-nbd -r` mapping and read-only `debugfs -c` as `prepare`.
- **What it reads:** partitions, the GRUB default entry (parsed and bound; **no** kernel/initrd dump) and the unit scan.
- **Not used:** **no overlay, no extraction, no capacity policy**. The tests make any `avail_bytes`/`nvme_policy` call fail.
- **Teardown is verified**, through the shared `Exposure`, which `prepare` now uses as well:
  - `fusermount3 -u` rc 0;
  - nbdfuse exits 0 by itself, with no kill;
  - not mounted; dir removed;
  - the OS disk no longer open;
  - a failed exposure is still torn down.
- **Identity:** `(size, mtime, ctime, ino)` before and after.
- **Output:** one `INVENTORY.json` (mode `x`) with:
  - the scan (`system`, `user`, `linger`, a per-dir state);
  - `maskSet`, `cmdlineBytes`/`cmdlineMax`;
  - teardown facts and `problems`.
- **Exit:** **rc 0 only with no problems**; otherwise rc 2, with the record still written.

## Tests (28 source fixtures, none run by me)
r4's 18, minus its 2 inventory tests, plus 12 new:
- **Scan (6, a fake debugfs filesystem):**
  - the noble shape scans clean, and `alias`, `absent` and `listed` are distinct;
  - `/usr/local`, `/usr/lib` wants, `/etc` drop-in, `.target.wants` and `.requires` instance units are found and masked exactly once;
  - a required dir that is absent, empty or unreadable refuses, as does an unreadable parent;
  - an optional dir that is absent or empty is fine, but unreadable or not a directory refuses;
  - user units (`/etc`, a home dir's wants, `/root`) and a linger entry are problems; a non-enclave user unit and an empty linger dir are not;
  - non-literal unit and home names are problems; a symlink loop refuses; the debugfs budget is enforced, and only `debugfs -c` is called.
- **Exposure (2):**
  - a clean teardown;
  - each unclean fact (fusermount rc, hang then kill, nbdfuse exit 1, disk still open) gives not clean;
  - a failed exposure is still torn down.
- **Inventory (3):**
  - metadata only: no `qemu-img`/`systemd-run`/dump calls and no capacity use; only `INVENTORY.json` in a 0700 dir; refuses an existing `OUT`; `main` rc 0;
  - an unclean teardown, an identity change or a user unit gives rc 2 with the record written;
  - preconditions (outside a lane, a lane > 512 MiB, production running, qual VM present, disk open) refuse **before any mapping**.
- **Controller (1):** the floor is another invocation, or already gone, after the VM start. Our VM is stopped, a foreign floor is never stopped, and `postStartFloor` is recorded.

## Root commands (all in the 512 MiB main queue lane; nothing run by Claude)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
# 1. offline logic tests (no disk, no VM): PASS = "Ran 28 tests" + "OK", r1-r4 frozen
bash jobs/q-exit-status.sh qualvm-r5 512 bash rpc-qualification-vm-stage/r5/jobs/root-qualvm-r5-tests.sh
# 2. ALLOWED NOW while production is off: the actual read-only inventory (no capacity needed). OUT must not exist.
bash jobs/q-exit-status.sh qual-inventory 512 python3 -I rpc-qualification-vm-stage/r5/qualvm.py inventory /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/qual-inventory-<id>
# 3. FORBIDDEN until /vm avail >= 385,899,345,920 B and KVM coordination is recorded: prepare, controller, prove, stop, discard (as r4)
```

## What the inventory will and will not show
**It shows,** from the real disk:
- the actual `enclave-*` system inventory;
- user units and linger;
- the per-directory states;
- the exact masked cmdline length;
- clean teardown and unchanged identity.

**It cannot show**, so these remain live evidence for the later boot:
- that the masks reach the guest as `masked-runtime`;
- the `\x2d` handling;
- lsblk/QMP formats;
- that `systemd-run --user` works from the lane and the floor sees `INVOCATION_ID`;
- that SSH works with every `enclave-*` unit masked.

**Known limits** (each fails closed; recorded in `problems` or as a refusal):
- slow symlinks on the unit path;
- dependency-dir or home names outside `[A-Za-z0-9@:_.+-]`;
- more than 64 homes;
- more than 600 debugfs requests.
