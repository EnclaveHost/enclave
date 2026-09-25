# Independent byte review of the next production candidate b7ba7731 (digest 56FBB27F), before its first boot

enclave-d1, 2026-09-25 09:03Z (clock read). Offline; nothing ran on the box. Builder: enclave-63.
- The recipe is a44bb55a's manifest and resources with ONLY `linux_initrd` swapped for enclave-5d's `1539d5b2…`.
- 63 reproduced that initrd byte-exact from `c192380c`.

| file | sha256 | VBS launch digest (mine, `verify/vbsdigest`) | 63's stated |
|---|---|---|---|
| **candidate** | `b7ba7731240ec902…` (77,794,396 B) | `56FBB27F363A7FEDC83FD56CB4FF39C5411140300BB8F8496C35893A061077E1` | `56FBB27F…` |
| debug twin (refused by digest) | `95de03cc46769023…` | `8E9D6ACBDAAD01F79AAB4EC6FA964068DA992C40B32D110025570C46BD682F9A` | `8E9D6ACB…` |

**Strings.** The candidate has the static line `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux` once and the VTL0 line
`console=ttyS0 rdinit=/init loglevel=3 report_host=9001` once. It has `OPENHCL_CONFIDENTIAL_DEBUG=1` 0 times and
`OPENHCL_BOOT_LOG=` 0 times. The twin carries the debug flag once. The manifest says `vbs.enable_debug: false` and
`static_command_line: true`.

**The initrd, member by member against production `680d40fa`.** Both have 24 members. The ONLY difference is
`plat/domprobe`: mode 0755, 862,368 to 862,400 B, sha256 `0d12e950…` to `2c260049…`.
- The source change (`e8b91efd` to `c192380c`, `isolation/m3/domprobe.c`) is `try_open`. It calls
  `open(O_RDONLY|O_CLOEXEC|O_NONBLOCK|O_NOCTTY)` on `/dev/tpm0` and `/dev/tpmrm0` and closes at once: no read, no ioctl,
  no TPM command.
- This is the negative control d1 asked for: a domain cannot reach the vTPM, and ENOENT is expected. It is NOT a report
  capture in any form.
- The other source changes in that range (the g4panic probe module, test-m3.sh) do not reach this initrd.

**Measured regions** (`regions`, 64-byte samples). The two compressed initrds first differ at byte 2,340,103.

| sample | candidate `b7ba7731` | production `a44bb55a` |
|---|---|---|
| shared prefix (2 samples) | MEASURED, not shared (gpa 0x4725000, 0x471d000) | the SAME GPAs, MEASURED |
| after the divergence (3 samples, through the end) | each once, MEASURED, not shared | NOT FOUND |

**Verdict.** The bytes match 63's statement. The candidate differs from `a44bb55a` only by the rebuilt `domprobe` inside
the measured initrd. It is fit to package as eligible:false and booted "no: build-only" until its own canary.

**Not established.** That it boots; the domprobe negative control on hardware (it needs a PROBE-mode domain on this
image); anything about isolation.
