# rpc-qualification-vm-stage/r4 (PREPARED by Claude; nothing run). r3 (frozen) + review N1-N3. Temporary qualification only, never a chain backend

**N1, masks derived from the disk:**
- `prepare` takes a read-only debugfs inventory of every `enclave-*` unit name on `cloudimg-rootfs`. It covers unit files and symlinks in `/etc/systemd/system`, `/usr/lib/systemd/system` and `/lib/systemd/system`; the link names in every `/etc/systemd/system/*.wants|*.requires`; and drop-in dirs (`enclave-x.service.d` maps to `enclave-x.service`).
- The inventory is recorded in `PREPARED.json`.
- The kernel command line masks the UNION of that inventory, the reviewed `MASKS` and both data-mount units, and is refused above 2047 bytes (COMMAND_LINE_SIZE).
- `prove` requires the guest's `enclave-*`+mount inventory to EQUAL that set.

**N2, floor ready before the VM:** after its first CLEAN check, the floor unit writes `floor-ready.json` with its systemd `INVOCATION_ID`, PID and start token. It refuses without an `INVOCATION_ID`. The controller deletes stale receipts, starts the floor, and waits ≤ 15 s. It requires the receipt invocation == the floor unit's active InvocationID, with a live PID and token. Otherwise it stops its own floor and refuses; **no VM is started**.

**N3, console cap:** `console.log` is capped at 256 MiB on its own, and overlay + console allocated must be ≤ 16 GiB (`OVERLAY_MAX`). The floor trips on either.

**Unchanged from r3:**
- the 512 MiB main-lane controller with start token; the floor `BindsTo` lifetime;
- 27.75 GiB admission, and the 18 GiB proactive stop above the 16 GiB floor;
- the NVMe production-guard pause threshold + 16 GiB admission and continuous trip;
- own-InvocationID stops only;
- `prove` rc 3; GRUB/kernel binding; read-only data disks; `restrict=on`; scope labels (OS overlay only, Q3 not qualifiable).

**Tests:** `test/test_qualvm.py` (18, source fixtures) and `jobs/root-qualvm-r4-tests.sh` (256 MiB; checks that r1-r3 are frozen).
