# rpc-qualification-vm-stage/r2 (PREPARED by Claude; nothing run). r1 (frozen) + literal GRUB parser fix + no outbound network

**Root cause of root 1473's FAIL:** `re.findall` with one group returns strings, so r1's `li[0][0]` returned the initrd path's first character (`/`).

**r2 parser:** takes the DEFAULT entry literally or refuses. It requires:
- exactly one `linux` and one `initrd` line, each with one literal absolute path, no `..` and no variables;
- literal args (only Ubuntu's `$vt_handoff` is dropped), with exactly one `root=`;
- `set default` only `"0"` or the stock `"${next_entry}"` branch, with grubenv `next_entry`/`saved_entry` empty;
- a first top-level entry that is a menuentry (not a submenu).

**Network:** always `restrict=on` with the SSH forward only. r1's `--network apt` mode is removed. Packages come in over SSH and are verified offline (`logs/claude-small-qualification-vm-r2.md`).

**Scope labels:** `plan`/`prove` state that everything runs in the OS OVERLAY: data disks are read-only and their mounts masked. That qualifies this OS/systemd/kernel/binaries, NOT the production disk's installation. `prove` also fails if any data mount exists.

**Tests:** `test/test_qualvm.py`, 6 tests:
- an Ubuntu-shaped accepted GRUB fixture (labelled, not the real grub.cfg);
- 17 adversarial GRUB fixtures;
- grubenv refusals;
- the exact argv diff (always `restrict=on`);
- unit caps and launch refusals;
- changed kernel / auto data mount.

**Job:** `jobs/root-qualvm-r2-tests.sh` (256 MiB, not under `unshare -U`, checks that r1 is still frozen).
