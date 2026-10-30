# EFI review: full-smoke-r1 arm A, "Failed to load initrd: 0x8000000000000009"

Date: 2026-10-27. **Source and record reading only.** I started no process, VM, GPU, network or signing,
and edited nothing in production. Each claim below is tagged:
**[read]** I read the file or line cited. **[root]** root supplied the fact; I did not re-read it.
**[upstream]** it comes from upstream source that is not on this host; treat it as a reference to check.
**[inference]** it is my reasoning and is not proven.

## 1. What failed

- `full-smoke-r1/serial-0-A.log:1-2` **[read]**: `EFI stub: ERROR: Failed to load initrd: 0x8000000000000009`, then
  `efi_stub_entry() failed!`. The UEFI status is the error bit plus 9, which is **EFI_OUT_OF_RESOURCES**. The Linux
  EFI stub ran, so the firmware had already loaded and started the kernel image. The failure happened while the stub was
  getting the initrd, before any kernel code, init, front or model code ran.
- `serial-0-A.log:3-9` **[read]**: BdsDxe then fell through to Boot0002, the embedded AmdSev GRUB. It failed on
  `sevsecret` and printed "Failed to mount root securely". That is the expected fallback, already documented
  (`isolation/m1/domain.env:25-29`, `isolation/m2/build-verifying-firmware.sh:59-67`). **It is a symptom, not a second
  fault.**
- `full-smoke-r1/receipt.json` **[read]**: the outcome is `stopped:owned_identity_changed:guest`. The fixture request
  exited -9 after 13.5 s. The guest unit's `memory.current` rose to about 2.49e9 B and stayed flat until the unit went
  away (lines 189-251). That plateau fits a guest that never touched RAM above the low window. This is weak
  corroboration only, because the cgroup charge from guest_memfd and from QEMU's own initrd buffer was not separated.
  Cleanup was `clean`.
- Image identities are in `full-images-build-r1/BUILD.json:10-24` **[read]**. Sizes are not recorded there. ~724 MiB
  gzip comes from root.

## 2. The machine and firmware are identical to production

- Bench argv (`full-bench-prep/fullbench.py:306-323`) **[read]**: `q35`, `sev-snp-guest,...,kernel-hashes=on`,
  `memory-backend-memfd,size=57344M,share=true`, `-bios firmware.fd -kernel kernel -initrd A.cpio.gz`, 16 vCPUs.
- Production (`isolation/m2/run-domain.sh:47-49,160-161`) **[read]** uses the same machine, SEV object, memory backend,
  `-bios/-kernel/-initrd` and the same `APPEND` (`release.json` cmdline `console=ttyS0 rdinit=/init loglevel=3`).
  Production differs only by `-S -qmp` for vCPU pinning (`run-domain.sh:146-149`), which has no effect on guest memory
  layout, and by guest RAM size (live guestd 73728 MiB).
- The production template includes `mmproj-F16.gguf`, 927,607,488 B (`release-5cab66e4/release.json`) **[read]**.
  Production packs it with the same `gzip -n -9` newc (`isolation/m4/pack-initrd.sh:26`) **[read]**. So production's
  27B initrd is the same size class as arm A's.
- The firmware is the AmdSevX64 build of **edk2-stable202608**. RELEASE sha256 142589cc... is recorded at
  `isolation/m2/build-verifying-firmware.sh:12,70-77` **[read]**. The source tree is at
  `/home/steven/.cache/enclave-isolation/fwbuild/src/edk2` **[root, read]**.

## 3. Root cause (leading hypothesis, strongly supported but not proven)

**When an SNP guest is in UEFI boot services, it can only use RAM below 4 GiB. On q35 with large RAM that is a 2 GiB
window. A ~724 MiB initrd needs about two contiguous copies there, plus the kernel and the firmware's own allocations.
The second contiguous 724 MiB allocation fails.**

Evidence for each link:

1. **Only RAM below 4 GiB is accepted in the firmware.** `OvmfPkg/PlatformPei/AmdSev.c:159-169` **[read]** retypes every
   system-RAM resource HOB at or above `SIZE_4GB` to `EFI_RESOURCE_MEMORY_UNACCEPTED` and skips it. Only RAM below
   4 GiB goes through `MemEncryptSevSnpPreValidateSystemRam`. In the DXE core, unaccepted memory is a separate type
   (`MdeModulePkg/Core/Dxe/Mem/Page.c:52,75,1884,2237-2254`) **[read]**. A grep of `Page.c` for
   `Accept|Unaccepted|PromoteMemoryResource` found no accept-on-allocate call in the allocation path. The only fallback
   is `PromoteMemoryResource` (`Page.c:404`, called at `1151` and `1355`). I did **not** read lines 404-450 to confirm
   that it skips unaccepted memory. That is the first line to check.
2. **The low window is 2 GiB and cannot be raised.** QEMU `pc_q35.c` uses lowmem = 0x80000000 when
   `ram_size >= 0xb0000000`. `max-ram-below-4g` can only lower that value (it takes the minimum) **[root]**. Arm A
   (56 GiB) and the earlier loader-only run (48 GiB) therefore had the same ~2 GiB of usable boot-services RAM.
   **Guest RAM size is not the variable. Initrd size is.** That explains why 48 GiB with a tiny initrd booted.
3. **There are two copies of the initrd.**
   - The firmware's `QemuKernelLoaderFsDxe` fetches the initrd blob from fw_cfg into firmware RAM and verifies it
     against the SEV hash table (BlobVerifierLibSevHashes). **[upstream / inference]** The file is at
     `OvmfPkg/QemuKernelLoaderFsDxe/QemuKernelLoaderFsDxe.c`; I did not read its allocation lines.
   - The Linux x86 stub then calls `LoadFile2` on `LINUX_EFI_INITRD_MEDIA_GUID` to get the size and calls
     `efi_allocate_pages(size, ..., ULONG_MAX)`. That is one contiguous `AllocateMaxAddress` region. The stub then
     copies the initrd into it. **[upstream]** The source is `drivers/firmware/efi/libstub/efi-stub-helper.c`
     `efi_load_initrd_dev_path`. The "Failed to load initrd" / "efi_stub_entry() failed!" strings match that path.
   - Under SNP, "anywhere" in practice means below 2 GiB.
4. **The budget does not fit contiguously** **[inference]**. 2 × ~724 MiB = ~1448 MiB, plus:
   - the decompressed kernel (the bzImage alone is 17,232,384 B per `release.json`; the stub allocates its decompressed
     size and places it at a KASLR-randomised address, under 512 MiB upstream)
   - PEI/DXE allocations, page tables, SNP secrets/CPUID pages and the hash-table page

   That all has to fit in under 2048 MiB, with the second 724 MiB block contiguous. The firmware's own blob and the
   kernel split the free space, so no single hole of 724 MiB is left. The KASLR placement means the margin may vary
   from boot to boot.

The following are ruled out by the log **[inference from read lines]**:
- Hash-table refusal. A verifier refusal stops the firmware before the stub runs; the stub ran here.
- A kernel or init fault, and anything about the model, GPU, rings or guestd.
- Host OOM. The unit peaked at about 2.5 GB under a 58,112 MiB MemoryMax.

**Contradiction root must settle.** Production uses identical argv, kernel, firmware and pack format, and a template of
the same size. **I found no record in this session that production ever booted a 27B image from release-5cab66e4 under
SNP.** The live Qwen guest was QUEUED, per my earlier notes. There are two cases:
- If production has booted it, the hypothesis must also explain why production fits. Candidates: a smaller actual
  image (for example a different app), or luck with the KASLR draw.
- If it has not, **the production baseline is itself unbootable on SNP**, and "exact baseline" is not a reachable target
  until root decides on a change.

## 4. Could `max-ram-below-4g` or initrd placement help?

- **`max-ram-below-4g`: no.** On q35 it can only shrink lowmem below 2 GiB **[root]**, which shrinks the accepted window
  and makes this worse.
- **Initrd placement: not from the host.** On the AmdSev `-kernel` path, the firmware fetches the initrd, and the stub
  allocates its copy with a hard limit of `ULONG_MAX` **[upstream]**. The cap is acceptance, not an address limit. QEMU
  has no option that changes either step.
- **A larger guest: no.** Lowmem is fixed at 2 GiB once RAM is at least 2.75 GiB.
- **Switching to i440fx `pc`**, which has a larger low window **[upstream, unverified]**, changes the platform shape. I
  did not verify SNP support or the effect on the measurement for that machine. Not recommended.

## 5. Bounded diagnostic: confirm before choosing a fix

This keeps the pinned firmware (142589cc), the pinned kernel (1a3a02d5), the release cmdline, `kernel-hashes=on` and
SNP. Only the initrd varies, which is a bench-only change and changes the bench measurement as expected. No GPU,
workers, rings, model disk or guestd are involved.

**T1. RAM-independence check.** Boot the **unchanged** `full-images-build-r1/A.cpio.gz`, sha256 7a71d50d...
- Setup: SNP, q35, 4096 MiB, 2 vCPUs, same firmware, kernel and cmdline.
- 4096 MiB is above 0xb0000000, so lowmem is the same 2 GiB.
- Use no `-drive`, no ivshmem and no vsock. `-serial file:`, `-no-reboot`, `-nodefaults`, no QMP or monitor.
- Owned transient unit with `MemoryMax=4864M` and `RuntimeMaxSec=120`.
- **Prediction:** the same `0x8000000000000009` line. If 4 GiB fails exactly like 56 GiB, RAM size is excluded and the
  low-window model is confirmed in its main point.

**T2. Size threshold.** Use the same 4 GiB shape. Build one 1-file initrd per size; each holds only a static `/init`
that prints `BOOT-OK` and powers off.
- Pad the initrd with a stored, incompressible file. Use deterministic bytes from a fixed seed so the gzip size is
  controlled.
- Gzip sizes: 256, 384, 512, 576, 640, 704, 768 MiB.
- Boot each size 3 times to expose KASLR variance.
- **Prediction:** a clean pass/fail boundary somewhere between about 600 and 750 MiB, with possible flakiness near the
  edge. If 724 MiB sits above the boundary, the diagnosis is confirmed and the threshold is measured.

Per-boot record: initrd byte size and sha256, the serial outcome, and the unit's `memory.peak`. Total footprint is at
most 4.75 GiB per boot, serial, 22 boots, each ≤120 s.

Even at this size, run T1 and T2 under a coordinated KVM-coordinator slot, with the same production-identity and
18 GiB-floor watchdog as the existing harness. Do not use the old run-canary scripts and do not use QMP.

**Optional T3, diagnostic only (not baseline).** Run the recorded DEBUG firmware (50c06354..., same script, `BUILD_TARGET=DEBUG`) with
`-debugcon file:... -global isa-debugcon.iobase=0x402` (see `run-domain.sh:24-26,163`) on the 704/768 MiB images.
That firmware is a different binary, so the measurement differs; label the run as diagnostic. It shows the
`QemuKernelLoaderFsDxe` blob sizes and the memory map at the failure, which turns §3 point 4 from inference into a
measurement.

## 6. Correction options (each needs root approval and changes a measurement; none is applied)

No proven fix preserves the exact baseline. If T1 and T2 confirm the diagnosis, the 724 MiB template cannot boot on this
firmware at any guest RAM size. The options, smallest first:

1. **Take `mmproj-F16.gguf` (885 MiB) out of the initramfs.** Serve it from a read-only verified disk whose root hash
   is in the measured release. The Z-Image path already does this with dm-verity (`run-domain.sh:87-100`). This drops
   the initrd to roughly 1.1 GB minus 927 MB uncompressed, well under the threshold. It changes the release template,
   the measured init/loader path and the launch measurement. **This is a production-release change, not a bench
   tweak.** Do not do it silently.
2. **Firmware: pre-validate a bounded range above 4 GiB** in `OvmfPkg/PlatformPei/AmdSev.c:159-164`, for example the
   first 2 GiB above 4 GiB. Alternatively, accept unaccepted memory on allocation failure in the DXE core.
   - Hash verification is unchanged.
   - The firmware digest, and so every launch measurement, changes.
   - Pre-validating costs boot time per GiB.
   - This needs root review of edk2 code, and `verify-firmware.sh` must be re-run.
3. **Recompress the initrd** with zstd or xz. The kernel must support it, and the format change alters the measurement.
   F16 weights compress poorly, so the gain is uncertain. Only worth trying if T2 puts the threshold just under 724 MiB.

I do not recommend:
- `nokaslr` on the cmdline: it changes the measured cmdline and at best moves the margin.
- Any `kernel-hashes=off`, non-SNP or non-verifying firmware run, except as the clearly labelled diagnostic T3.

## 7. Patch recommendations for the bench helper (not applied)

These change only `full-bench-prep/fullbench.py`. They are guards, not fixes:
- Record `os.stat(arm["image"]).st_size` in `plan.json` and the receipt next to the sha256. BUILD.json omits it today.
- After T2 measures a threshold, add a plan-time refusal: "initrd N bytes exceeds measured SNP boot-services limit".
  Then a known-unbootable image never takes a 56 GiB coordinated slot.
- Add a serial classifier. If `EFI stub: ERROR` appears, report the outcome as `firmware_initrd_load_failed`. Today the
  later QEMU exit is reported as `owned_identity_changed:guest` (`receipt.json:10`), which hides the cause.

## 8. Open items, in order

1. Read `Page.c:404-450`, `PromoteMemoryResource`, to confirm that unaccepted memory is never promoted during
   allocation.
2. Read the blob allocation in `QemuKernelLoaderFsDxe.c` to confirm that the firmware keeps a whole in-RAM copy of the
   initrd.
3. Root: was a 27B image from release-5cab66e4 ever booted under SNP in production? Need the serial log, or a record of
   the image size.
4. Run T1, then T2, under a coordinated slot.
