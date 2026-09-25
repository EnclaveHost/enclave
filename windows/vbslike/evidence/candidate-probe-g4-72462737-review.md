# Independent byte review of the G4 PROBE candidate (72462737), before any boot

enclave-d1, 2026-09-25 07:52Z (clock read). Offline; nothing ran on the box. Builder: enclave-63 (BUILD.json
07:50:24Z).
- The recipe is a44bb55a's manifest and resources, with ONLY `linux_initrd` swapped for enclave-5d's G4 probe initrd
  `e3b68c92…`.
- That initrd is the production `680d40fa…` plus `/probe.ko` (`g4panic.ko` `8b7f5ace…`, source `e852997e`), which
  panics 120 s after load.

**This image is a PROBE. It must never serve an app, never be eligible, and its digest is refused by exact value.**

| file | sha256 | VBS launch digest (mine, `verify/vbsdigest`) | 63's stated |
|---|---|---|---|
| G1 candidate (production) | `a44bb55a…` | `58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A` | `58DFEBFE…` |
| **G4 PROBE** | `724627378d81b51f0c56d7b22120162c11025961c678d2f2952ce7bb87a2bc1b` (77,835,676 B) | `CF339BC5C89E5F160482553CFE61A2CD694B38EE7583A55B6B722DBA13271B0F` | `CF339BC5…` |

**Strings in the probe:**
- The static line `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux` appears once.
- The VTL0 line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001` appears once.
- `OPENHCL_CONFIDENTIAL_DEBUG=1` and `OPENHCL_BOOT_LOG=` appear 0 times.
- It is non-debug. Its identity document says `debug_build=false`, so only the digest identifies it as the probe.

**The initrd:**
- `e3b68c92` (24,085,897 B) begins with the ENTIRE `680d40fa` (24,046,962 B), byte-for-byte.
- The 38,935 appended bytes are one gzip member. It holds a single newc cpio entry, `probe.ko` (mode 0644,
  120,368 B), sha256 `8b7f5ace27752e9d…`, which equals 63's stated g4panic.ko.

**Measured regions** (`regions`, 64-byte samples):

| sample | probe `72462737` | production `a44bb55a` |
|---|---|---|
| appended tail at initrd offsets 0x16EF100, 0x16F3100, 0x16F7100 | each once, MEASURED, not shared (gpa 0x5cef000 / 0x5cf3000 / 0x5cf7000) | NOT FOUND |
| base initrd at 0x125100, 0xb77100, 0x15c9100 | each once, MEASURED, not shared | at the SAME GPAs, MEASURED |

**What loads `/probe.ko` in production code** (source, `e8b91efd` `isolation/m3/dominit.c:153-165`):
- It is a hook that opens `/probe.ko` from the initramfs root after the command-line guards and before `/monitor`.
  Without the file it does nothing.
- Nothing is mounted over `/` before it. On this linux-direct path no boot stub can add files.
- So the file can come only from the measured initrd, and any image carrying it has a different launch digest. The
  same hook serves the parked memory probe (memmarker), which is NOT part of this review and stays parked.

**Verdict:** the bytes match 63's statement. The probe differs from `a44bb55a` only by the appended, measured
`/probe.ko`. It is fit to be packaged as `probe.firmware`, with class probe, eligible false, and `CF339BC5…` in the
refused set.
- NOT established: that it boots, or what Hyper-V does with the guest's panic restart request on type 1 (the G4 run's
  question). Nothing about isolation.
