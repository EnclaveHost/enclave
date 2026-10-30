# rpc-qualification-vm-stage/r5 (PREPARED by Claude; nothing run). r4 (frozen) + review N1a/N1b + post-start floor recheck + read-only `inventory`

**N1a, every unit directory is resolved, then classified.**
- **How:** each path component is checked against a **successfully listed** parent; fast symlinks are followed, bounded at 8 hops (noble's `/lib → usr/lib` becomes an `alias`).
- **States:**
  - `absent`: a path component is missing from a good parent listing;
  - `listed`;
  - `alias`: the same real directory as one already listed;
  - **error**, which refuses: a listing without its own `.`/`..` entries or with a nonzero rc, an existing non-directory, an unreadable or slow symlink, a link loop, or the debugfs request budget (600) exhausted.
- **Never empty by mistake:** an error is never treated as empty.
- **Required:** `/etc/systemd/system` and `/usr/lib/systemd/system` must exist **and** list at least one entry. Optional directories may be absent, never erroneous.

**N1b, coverage.**
- **System units:** also `/usr/local/lib/systemd/system`, and every `*.wants`/`*.requires`/`*.upholds` dir of **every** listed system dir.
- **Unit names collected:** files, symlinks, drop-in `X.d` and `X.wants`/`X.requires` dirs all count as unit names.
- **User-manager units refuse,** because `systemd.mask=` on the kernel command line cannot mask them. That is any `enclave-*` name in:
  - `/etc|/usr/lib|/usr/local/lib/systemd/user`;
  - `/root/.config/systemd/user`;
  - `/home/*/.config/systemd/user` (≤ 64 homes; a non-literal home name is a problem);
  - their dependency dirs.
- **Linger refuses:** **any** entry in `/var/lib/systemd/linger`.
- **Masked set:** the reviewed `MASKS` ∪ every system `enclave-*` unit ∪ both data-mount units, as in r4. `prove` still requires the guest inventory to equal it.

**Post-start floor recheck.** After the VM unit starts, the floor unit is re-read. If it is not `active` with the recorded (ready-proven) InvocationID, the controller stops **our** VM invocation, tries to stop **our** floor (never a foreign one), records `postStartFloor`, and refuses.

**`inventory OUT`: read-only metadata, while production is off.**
- **Preconditions, the same checks as `prepare`:**
  - production pins and unit renders; production units loaded and stopped; qual units absent;
  - the OS disk not open;
  - OS disk identity `(size, mtime, ctime, ino)` equal before and after;
  - runs inside a queue lane with `memory.max` ≤ 512 MiB;
  - `OUT` must be a NEW absolute path.
- **What it reads:** the same `nbdfuse -r`/`qemu-nbd -r` mapping and read-only `debugfs -c` (`ls -p`, `stat`, `cat`) of partitions, the GRUB default entry (no dump) and the unit scan.
- **Not used:** **no** overlay, **no** kernel/initrd extraction, **no** capacity requirement. It writes one small `INVENTORY.json`.
- **Teardown is verified:** `fusermount3 -u` rc 0, nbdfuse exits 0 by itself (no kill), not mounted, dir removed, the OS disk no longer open. This also applies to `prepare` now, and a failed exposure is still torn down.
- **Output:** `INVENTORY.json` holds the scan, `maskSet`, `cmdlineBytes` (refused above 2047), teardown facts and `problems`.
- **Exit:** rc 0 only with no problems; otherwise rc 2, with the record written.

**Unchanged:**
- capacity thresholds for `prepare`/`controller` (NVMe ≥ pause threshold + 16 GiB = 385,899,345,920 B; host admission 27.75 GiB; 18 GiB proactive stop above the 16 GiB floor);
- the controller only in the 512 MiB main lane;
- floor-ready gate, console cap, `prove` rc 3, GRUB/kernel binding, read-only data disks, `restrict=on`;
- OS-overlay-only scope; Q3 not qualifiable here.

**Tests:** `test/test_qualvm.py` (28, source fixtures) and `jobs/root-qualvm-r5-tests.sh` (checks that r1-r4 are frozen).
