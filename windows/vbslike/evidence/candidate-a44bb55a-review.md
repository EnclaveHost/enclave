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

NOT established: that it boots; anything about a report; host exclusion.
