# rpc-qualification-vm-stage/r1 (PREPARED by Claude; nothing run). Temporary 8 GiB qualification boot of the SAME RPC guest OS

**Purpose:** tiny-fixture guest qualification only (guest-state-install review Q1-Q3). It is not a chain backend; see `logs/claude-small-qualification-vm-plan.md`.

**Design:** `qualvm.py` derives the argv from the pinned production launcher's own `qemu_argv`. Only these differ, and the tests check exactly that:
- `-name`;
- memory: 8 GiB, prealloc;
- the console/QMP paths;
- the OS disk becomes a NEW qcow2 overlay (production `os.qcow2` is only its read-only backing);
- the L1/Base disks are read-only;
- no guard monitor;
- the SSH forward only, plus `restrict=on` (or `--network apt` for the signed b3sum download);
- `-kernel`/`-initrd`/`-append`: the OS disk's own default GRUB entry (read-only extraction) plus `systemd.mask=` for every chain unit and both data mounts. These are runtime masks only, so no OS-disk change.

**Runs as** a transient user unit `enclave-rpc-qual-vm.service` (`MemoryMax=10 GiB`, `MemorySwapMax=0`). Launch refuses unless the production VM and guard are inactive and host MemAvailable ≥ 26 GiB.

**Commands:** `prepare OUT`, `plan OUT`, `launch OUT`, `prove OUT`, `stop`, `discard OUT`.

**Tests:** `test/test_qualvm.py` (4) and `jobs/root-qualvm-r1-tests.sh`.
