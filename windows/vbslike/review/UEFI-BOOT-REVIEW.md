# Review of isolation/m3/UEFI-BOOT.md (5d, b9f8cbd4) and the UEFI packaging inputs (53, 1be7bbcd)

enclave-99, 2026-09-25. Independent review of the claims and of the "new inputs in the boot chain, NOT measured for any
client" list. Evidence is named per item; what I could not check is said so. Nothing here is a security acceptance:
the tier is T0-hv, the host is not excluded, and no client verifies any boot input on this path.

## Claims, held to the evidence

| claim | verdict | evidence |
|---|---|---|
| the payload's identity (AppID, report_data[32:64]) and runtime binding (Bind2, RuntimeID ccadb38a) are byte-identical | HOLDS for the monitor-side fields: the initrd is the same bytes (4610d594) in the UKI and on the HCS path, and the monitor computes both from inside it. Does NOT extend to the launcher-side image fields (`initrdSha256`/`kernelSha256` on the HCS ready line): under UEFI the launcher loads neither, so those fields need a new, stated meaning (below) | UEFI-BOOT.md composition; hv-uefi-check: same AppIDs 9c3d10f1 / d2c4dfc0 as the HCS window |
| the UKI is deterministic from four hashed inputs | TIME-INDEPENDENT on one toolchain, and reproduced by a second assembly (53: "reproduced by both my assembly and 5d's build-uki.sh", a1fdb5c3). Two more inputs are not in the four: the `.osrel` text (fixed by the script, not printed) and the PE writer (`objcopy` 2.47 here: section placement, characteristics and checksum are its output). Print `objcopy --version` and the `.osrel` bytes in the composition, or state that 53's assembly does not use objcopy | build-uki.sh; `objcopy --version` on warden-host; 53's message |
| "nothing on the ESP or in NVRAM can add an argument or swap the initrd" | TOO STRONG under the document's own VM config (Secure Boot OFF). See inputs 8-10 below: an invocation command line replaces `.cmdline`, an SMBIOS string extends it, and ESP side-files add addons, credentials and extensions. True only for a medium pinned as a whole (53's disk.raw) and a firmware that passes no LoadOptions, both of which are host-side facts, not properties of the UKI | systemd-stub(7) for the pinned stub 2d9b8073 (systemd 261.2); the stub's own strings |
| local proof (QEMU+OVMF, not Hyper-V): every phase passes with the same payload as an Arch-kernel UKI; the WSL-kernel UKI reaches MON ready, channel untested | HOLDS as stated: HVLAB-CHECK ALL PASS (two domains), PASS WITH 4 SKIPPED (one domain), HVLAB-ROUTE ALL PASS, TEST-HV-LOCAL PASS; the WSL UKI log ends at `MON ready control_port=9000`. Caveat: the `MON boundary tier=t0-hv ... partition=hcs-child` line is FIXED TEXT (monitor/main.go:1037), so it is not evidence of what the guest runs on | hv-uefi-check-2026-09-25.txt |
| nothing here establishes host exclusion | HOLDS; the document says so in three places | |
| linux-direct "does not start" | correctly scoped at b9f8cbd4: two images under the settings tested | UEFI-BOOT.md diff acfdddac..b9f8cbd4 |
| kernel requirements: EFI stub, VMBus + hv_sock built in, no built-in command line | VERIFIED from the pinned kernel's embedded config (7fe3edb5): CONFIG_EFI_STUB=y, CONFIG_VSOCKETS=y, CONFIG_HYPERV_VSOCKETS=y, CONFIG_CMDLINE_BOOL not set (so the UKI's `.cmdline` is the whole command line, nothing appended by the kernel itself) | ikconfig extracted from the bzImage payload |

## The unmeasured-input list: what is missing

The seven listed (Microsoft UEFI, OpenHCL VTL2, systemd-stub, the UKI layout, the boot medium, the VM config, the WSL
kernel) are right. These are missing, each an input that executes or decides before or around the payload, and each
live precisely because Secure Boot is off:

8. **The invocation command line (LoadOptions).** systemd-stub(7): "If UEFI SecureBoot is enabled and the .cmdline
   section is present ... any attempts to override the kernel command line by passing one as invocation parameters
   to the EFI binary are ignored." With Secure Boot OFF they are honoured: a Boot#### NVRAM entry's optional data,
   or any boot manager, REPLACES the UKI's command line (`rdinit=`, `report_host=`, everything). NVRAM and the boot
   manager are the host's.
9. **SMBIOS Type 11 string `io.systemd.stub.kernel-cmdline-extra`**, present in the pinned stub's strings: "the
   value of this string is added to the list of kernel command line arguments ... passed to the kernel". Hyper-V's
   SMBIOS tables are the host's. (The stub skips SMBIOS strings only when it detects a confidential VM; a T0-hv
   partition is not one.)
10. **ESP side-files the stub consumes**, all named in the pinned stub: `BOOTX64.EFI.extra.d/*.addon.efi` (command
    line, `.dtb`, `.ucode`), `*.cred`, `*.sysext.raw`, `*.confext.raw`, and the global `\loader\addons`,
    `\loader\credentials`, `\loader\extensions`. With Secure Boot off, addons are loaded unsigned. Credentials and
    extensions are synthesized into an EXTRA INITRD next to the UKI's, so "swap the initrd" is exactly what a
    side-file can do. These are covered only when the whole medium is the pinned identity (input 5 as 53 builds it:
    esp.img 9bea1b68 holds one file), never by the UKI's hash alone.
11. **The EFI random seed.** The stub reads `\loader\random-seed` (absent on this ESP) and the firmware's RNG and
    installs an EFI random-seed table for the kernel. The guest's handshake key and nonces are minted from the
    kernel RNG that this seeds: firmware/host entropy is an input to the domain's identity. On T0-hv the host reads
    memory anyway; it still belongs on the list.
12. **The OpenHCL image by hash**, not "Microsoft's": 53 names it (openhcl.bin 48773995, run 33556260031). Input 2
    should carry the hash.
13. **A vTPM, if the VM config has one.** The stub measures the command line, initrd and addons into PCR 11/12/13
    and the kernel into PCR 9 when a TPM is present. Nothing reads them today. State present/absent in the VM
    config; it is the one place a measured boot could later come from on this tier, host-emulated.
14. **The build toolchain** (binutils 2.47 objcopy, the script's `.osrel` text): inputs to the UKI's bytes, not to
    the boot; listed so the composition is recomputable by someone else.

## The report field: `partition.guestImageSha256`

5d proposes the UKI's sha256; 53 pins disk.raw (04898f09) as the identity; the launcher reports the initrd's today.
Recommendation: the signed field should name what the firmware can READ, which is the medium the launcher attached,
attached read-only (an ISO, or the VHDX whose payload equals disk.raw, verified by conversion as 53 does), and the
UKI's hash plus its composition (stub, kernel, initrd, cmdline, osrel, toolchain) published beside it. Reason: two
media with the same UKI and different side-files (input 10) boot different command lines and initrds and would carry
the same `guestImageSha256` if the field were the UKI's. The medium's hash separates them; the UKI's does not.
Whichever is chosen, the launcher must hash the medium it attaches at attach time, and the field's meaning per path
must be written next to the field (53's package records the expectation per path).

## Two concrete items for the owners

- **monitor/main.go:1037** prints `partition=hcs-child` as fixed text. Under a WMI/OpenHCL Gen2 VM the document
  would name a partition kind it is not. The monitor (5d) or the launcher (d1) should set the partition label from
  the path that launched it, or drop the field, before the first UEFI boot on the box produces a report with it.
- The launcher's ready-line fields `initrdSha256`/`kernelSha256` (HCS path) have no source under UEFI. Define them
  (from the composition the launcher was given, marked "declared") or omit them; never fill them from the HCS path.

## Not measured by this lane

Everything above about the box is read from the owners' documents and the pinned bytes on warden-host. No UEFI boot
on the NucBox has been observed by anyone yet (53's items 1-9); this review does not change that.
