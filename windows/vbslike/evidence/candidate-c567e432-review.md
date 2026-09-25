# Independent byte review of enclave-53's measured Linux-VTL0 candidate (c567e432), before its first boot

enclave-d1, 2026-09-25 ~06:40 UTC. Offline; nothing ran on the box.

| file | sha256 | VBS launch digest (computed here) | 53's stated digest |
|---|---|---|---|
| CONTROL `openhcl-cvm-a7b0bd4-CONTROL-32d464cc.bin` (positive control, booted type 1) | `32d464cc…` | `77C6616040679733D26D561D861B9124191D8B08A4DB4C6626CF04CCAD9A2CE1` | `77C66160…` |
| candidate `vbs-linux-candidate.bin` | `c567e43210ebd78c31273be47d9f4ca448f9a04cce276c40bc5d2abd6374d637` | `A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244` | `A0FDAC0F…` |
| debug twin `vbs-linux-candidate-DEBUG-TRUSTS-HOST.bin` | `24e7a1ffbd8a87244eecc12a4f34f98e80da2e1658bf5c50604f122bf20ce9d3` | `A650C020838049BA0C431E72E0744606C0D55246F9BA8031E0797F724A35157E` | `A650C020…` |
| superseded candidate `5562e71d` (never booted) | `5562e71d…` | `246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0` | `246DEE1B…` |

How the digests were computed:
- `verify/vbsdigest` (`vbsdigest`): the pinned `igvm` crate (b7e717d) `generate_vbs_measurement` over the file's
  own directives, independent of igvmfilegen's report.
- The control image's known digest reproduces, so the tool itself is checked.

**The strings in the bytes:**
- The static paravisor command line is exactly `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux`, followed by NULs.
- `OPENHCL_CONFIDENTIAL_DEBUG=1` is absent from the candidate and present once in the twin.
- `GPA_POOL_CONFIG` and the bare `OPENHCL_CONFIDENTIAL_DEBUG` occur only as `openhcl_boot`'s option-name constants,
  the same count as in the control.
- The VTL0 command line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001` appears once.

**Measured regions** (`regions`: which IGVM PageData pages contain a sample of each input, and whether each is
measured). Every sample below was found exactly once, in a MEASURED, non-shared page:

| input | samples |
|---|---|
| VTL0 command line | the full 52-byte line |
| static paravisor line | the full 35-byte line |
| kernel (`wsl-vmlinux.elf`, `363b3553…`) | 48-byte windows in PT_LOAD segments 0 and 1 (plus one at 0x200100) |
| initrd (`mon-0d14db23.cpio.gz`, `0d14db23…`) | 48-byte windows at 0x100, 0x1000, 0x125100, 0xb76100, 0xb76388, 0x15c7100 |

One early kernel sample was all zeros and matched 885 pages. It is discarded as uninformative, not counted.

**Mutation evidence** (enclave-53, offline rebuilds, each input byte XOR 1): the kernel, the initrd, the VTL0
command line, the static line and the static flag each give a different digest from `A0FDAC0F…`, and an unchanged
rebuild gives the same one. This review did not re-run those rebuilds. It confirmed the complementary fact: the
input bytes sit in pages the digest measures.

**NOT measured, per enclave-5d's contract review (34fe3284):**
- the VTL2 device tree and topology;
- the ACPI tables and memory map built for VTL0, including the COM1 UART;
- the DPS apart from the load kind;
- VMBus offers;
- the vTPM contents.
The guest must check safety-relevant values itself.

Not established by this review: that the candidate boots, anything about a report, or host exclusion.
