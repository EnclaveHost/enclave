# rpc-qualification-vm-stage/r3 (PREPARED by Claude; nothing run). r2 (frozen) + independent review B1-B7: one owned controller

- **`controller OUT`:** the ONLY way the VM starts. It runs in root's 512 MiB main queue lane for the whole qualification and refuses any other `memory.max`.
  - **Admission:** MemAvailable ≥ 27.75 GiB (16 floor + 10 VM + 0.5 lane + 0.25 + 1 margin), and NVMe avail ≥ the production guard's pause threshold + 16 GiB overlay maximum.
  - **Also requires:** production units loaded and stopped, qual units absent, and the OS disk not open.
  - **Records** its PID + `/proc` start token.
  - **Starts** the 64 MiB floor unit, then the 10 GiB VM unit (`BindsTo=`/`After=` the floor unit), and records both InvocationIDs.
  - **Ends** on SIGTERM (`stop OUT`), lifetime, or VM exit: ACPI powerdown, then 180 s grace, then a stop of its OWN VM invocation only, then its own floor unit. Then a receipt.
- **`floor`:** every 1 s it trips on MemAvailable unreadable or below 18 GiB, controller death, overlay allocated above 16 GiB, or NVMe below the pause threshold. It EXITS 4, and systemd stops the bound VM (SIGTERM, 30 s, then SIGKILL). The overlay is disposable; the originals are read-only.
- **`prepare`:**
  - the GRUB `search --fs-uuid` must equal the partition the files are read from;
  - `root=` must name exactly one real partition;
  - kernel and initrd must be regular files; bzImage `HdrS`; initrd ≥ 1 MiB.
- **`prove`:** rc 3 on any failure. It never uses SSH unless OUR units are active.
  - **Host:** `BindsTo`/`MemoryMax`/swap; QMP `ro` for L1/Base.
  - **Guest:** an exact `/proc/cmdline`; `uname -r`; MemTotal; every `enclave-*` unit file `masked-runtime` and every `enclave-*` unit inactive (empty allowlist); both mount units masked; per-mountpoint `findmnt` empty; L1/Base disks `RO=1` with no mountpoint (by serial).
- **`stop OUT`** (SIGTERM to the recorded controller) and **`discard OUT`** (a receipt, refused while anything of ours is alive).
- **Tests:** `test/test_qualvm.py` (13, source fixtures) and `jobs/root-qualvm-r3-tests.sh`.
- **Scope:** OS-overlay qualification only. It cannot qualify Q3 (the original masked retention unit) and is not a chain backend.
