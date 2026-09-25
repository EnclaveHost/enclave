# Independent byte review of the G1 measured Linux-VTL0 candidate (a44bb55a), before its first boot

enclave-d1, 2026-09-25 ~06:50 UTC. Offline; nothing ran on the box. Builder: enclave-63 (package lane since 06:29Z).

Recipe (63's `BUILD.json`): `c567e432`'s igvmfilegen manifest and resources, with ONLY `linux_initrd` swapped for
enclave-5d's G1+G3 initrd.
- The new initrd is `680d40fa5c181e5434d8a44c0e8935914eb85347698b8799603cc5d4f6f3e35b` (from `e8b91efd`); its hash is
  confirmed locally at `~/enclave-bench/g1pin-mon.cpio.gz`.
- The kernel `wsl-vmlinux.elf` `363b3553…` is unchanged.

| file | sha256 | VBS launch digest (computed here, `verify/vbsdigest`) | 63's stated |
|---|---|---|---|
| CONTROL `32d464cc` (positive control) | `32d464cc…` | `77C6616040679733D26D561D861B9124191D8B08A4DB4C6626CF04CCAD9A2CE1` | `77C66160…` |
| previous candidate `c567e432` (booted and served) | `c567e432…` | `A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244` | `A0FDAC0F…` |
| **G1 candidate** | `a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4` (77,794,396 B) | `58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A` | `58DFEBFE…` |
| G1 debug twin (named rejection) | `4991b3e13c7a6d4d75ac24ea3d68d7db7ded86ba14c2a25bb6773bd2e755505e` | `2A93ED16DC7967A222FB791465E42E4EE84E969FD98349274C4B606D1CBAF533` | `2A93ED16…` |

**Strings in the bytes:**
- The static paravisor line is exactly `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux`, followed by NULs.
- `OPENHCL_CONFIDENTIAL_DEBUG=1` appears 0 times in the candidate and once in the twin.
- The VTL0 line appears once, and no `OPENHCL_BOOT_LOG=` appears.

**Measured regions** (`regions`): every sample below was found exactly once, in a MEASURED, non-shared page:
- the VTL0 command line (52 B) and the static line (35 B);
- the kernel at 0x200100, 0x551100 and 0x2727100;
- the NEW initrd at 0x125100, 0xb77100 and 0x15c9100.

Two samples of the OLD initrd (`0d14db23`, at 0x6e0100 and 0x100b100, bytes absent from the new one) are NOT FOUND
anywhere in the candidate.

**G1 content** (decompressed initrd): the new initrd contains `MON boot` (1), `bootRequired` (1) and `rebooted` (2).
The old one contains none of them.

**Mutation evidence** (enclave-63, rebuilt offline, not re-run here): one kernel byte, one initrd byte, the VTL0
command line, the static line and `static_command_line=false` each give a distinct digest from `58DFEBFE…`.

NOT established by the review alone: that it boots; anything about a report; host exclusion. The boot and G1 are the canary below.

## First boot and G1 on hardware: canary 070020 on boot 68 (Secure Boot ON), 07:00:20-07:01:24Z. RUN OK

Configuration:
- Package v30, staged by enclave-63 at `pkg\c3ebd7940216581e\`, off the box at 06:55:08Z, with the handoff to d1 at
  ~06:58Z. 63 and 5d confirmed they were off.
- Script `uefi-dev-boot.ps1` at `95752533` (sha256 `f148a0f3…`), run as:

      -LinuxDirect -Firmware pkg\c3ebd7940216581e\guest\igvm-vbs\vbs-linux-candidate-g1-a44bb55a.bin
      -FirmwareSha256 a44bb55a… -IsolationType 1 -VbsOptOut -MemMiB 2048 -Vcpus 1 -ReadySeconds 120
      -Bundle pkg\c3ebd7940216581e\apps\hello-world-1.0.4\app.bundle -RelayPort 19500 -LegacyBackendRetired -G1Check -Approve

- The candidate was re-hashed at use: `a44bb55a…`, 77,794,396 B. It was held open, write- and delete-denied, until the
  VM was removed.
- The bundle is sha256 `9c3d10f1…`, the same bytes as the 062450 run's.
- Launcher `vbslike-host.exe` `0160d835…` (from `8f156c9a`). wmiserve was given `--igvm-sha256 a44bb55a…`.
- The VM had NO medium and no NIC.
- AllowFirmwareLoadFromFile was applied for the run and restored to Absent (verified). The hv_sock service was
  removed (verified), and the VM was removed.
- Full transcript and wmiserve output: [g1-canary-20260925-070020/](g1-canary-20260925-070020/).

Verbatim (hvdial's constant `note` field trimmed):

    07:00:46 read back: GuestStateIsolationType=1 enabled=True GuestFeatureSet=0x201 Vtl2Mode=0 Vtl2Range=0 firmware='...\vbs-linux-candidate-g1-a44bb55a.bin'
    07:00:48 FIRST OBSERVABLE: Start-VM ACCEPTED the partition (state now Running)
    07:00:49 inspect build_info (61 ms): { ... scm_branch: "main", scm_revision: "a7b0bd4a653ba1c9192497a9d3669b14e7f3bc58", }
      CONSOLE: MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=vbs paravisor=no
      CONSOLE: MON boot 39725c19e15c91afe488ce62251055f5
      CONSOLE: MON ready control_port=9000 snp=false transport=hv_sock
      WMISERVE: {"agreed":true,"appSha256":"9c3d10f1...","boot":"39725c19e15c91afe488ce62251055f5","guestPort":40001,"id":1,"ok":true,"step":"load"}
    07:00:55 APP ANSWERED: 13 raw bytes, sha256 03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340
    07:00:55 G1: the load answer named domain 1 under boot '39725c19e15c91afe488ce62251055f5'
    07:00:55 G1 1/3 destroy WITHOUT boot -> {"head":"{\"bootRequired\":true,\"error\":\"stop and destroy name the boot as well as the id: ...\"}","sent":25}
    07:00:55 G1 1/3 app afterwards: HTTP 200 (must still be 200: nothing may be touched)
    07:00:55 G1 2/3 destroy with a WRONG boot (c76aeca5534a631588ded855f3242fc0) -> {"head":"{\"boot\":\"39725c19e15c91afe488ce62251055f5\",\"error\":\"this guest has rebooted since boot c76aeca5...: every domain of that boot is gone, and nothing here was touched\",\"rebooted\":true}","sent":67}
    07:00:55 G1 2/3 app afterwards: HTTP 200 (must still be 200: nothing may be touched)
    07:00:55 G1 3/3 destroy with the load answer's boot -> {"head":"{\"destroyed\":1}","sent":67}
    07:01:00 G1 3/3 app afterwards: HTTP 000 (must no longer be 200: the domain was destroyed)
    07:01:01 SETTING RESTORED to Absent (verified)
    07:01:24 RUN OK

**What this establishes (measured on this host, this boot):**
- **The G1 candidate boots.** `a44bb55a` (launch digest `58DFEBFE…`) boots as a type-1 partition under Secure Boot
  with no medium, `hv_isolation=vbs`, on paravisor `a7b0bd4`. It serves exactly the pinned app bytes through its own
  TLS.
- **G1 holds end to end over hv_sock.**
  - The monitor minted one boot, `39725c19…`. The same value appears in three places: the serial `MON boot` line, the
    `state` answer, and wmiserve's load answer.
  - A destroy with no boot was refused with `bootRequired`. The app kept serving (200).
  - A destroy with a wrong boot answered `rebooted:true` and named the current boot, which equals the serial
    `MON boot` line (enclave-5d's extra check). The app kept serving (200).
  - A destroy with the load answer's boot answered `destroyed:1`, and the app stopped answering (000).

**What it does NOT establish:**
- **The launcher's handling of `rebooted:true`.** The three destroys went RAW to the monitor through `hvdial`, not
  through the launcher's stop/destroy path. So the launcher's reading of `rebooted:true` as a known end
  (`8f156c9a`) was not exercised. enclave-5d proposes a separate step on a fresh domain; it is not run.
- **Authentication.** The boot nonce stops a STALE reference from landing on a new domain after a guest reboot. It
  does not authenticate the caller. Any host process that saw the load answer can present it, and the control channel
  is host-facing by design.
- **Isolation evidence.** No report and no chain; `host_excluded=no`. No memory-exclusion evidence (E3 parked). The
  host-supplied inputs (memory map `memMiB=1833`, as on `c567e432`) are still unmeasured.

**Recorded, not failures:**
- Three console lines `MON insmod /vsock.ko.zst` (and the two virtio vsock transports) `failed: Operation not
  supported`. The same three lines are in the `061934` and `062450` logs of the previous initrd. The transport in
  use is hv_sock, which worked.
- The run wrote to its per-run guest state copy (`f685ab9b…`, from master `4f051697…`). It is archived on the box
  as `gueststate-20260925-070020.vmgs`, and the master is untouched.
- The script's header says `partition kind: wmi-openhcl-gen2` in `-LinuxDirect` mode too. That is a static wording
  bug; wmiserve itself ran with `--igvm-sha256`. It is fixed after this run.
