# REVIEW: SEV-SNP boot-window candidate for `OvmfPkg/PlatformPei/AmdSev.c`

Date: 2026-10-27. This is **source only**. Nothing has been compiled, dry-run patched, tested, booted or deployed.
Tags: **[read]** means I read it in this tree. **[root]** means root supplied it. **[upstream]** means it is not
verified here. **[inference]** means it is my reasoning.

## Status (no inflated claims)

| Item | State |
|---|---|
| `CHANGE.patch` (AmdSev.c + PlatformPei.inf) | Written by hand. **Not dry-run.** The first gate is `patch -F0 --dry-run` (BUILD-RECIPE step 3). |
| `src/OvmfPkg/PlatformPei/SnpBootWindow.h` | New pure helper. Not compiled. |
| `tests/test_snp_boot_window.c` | Offline helper and HOB-walk model tests. **Not compiled or run.** |
| Firmware build | Not done. Recipe in `BUILD-RECIPE.md`. |
| SNP boot of 724 MiB image | Not done. Gated (see below). |
| Production / verifier / admission | Untouched. The candidate has a **new measurement** and is **not** the baseline. |

Baseline sha256 of the two targets: I cannot compute it without running commands. Root records it in BUILD-RECIPE step 1
before applying.

## What changes

The original code (`AmdSev.c:159-164` **[read]**) marks every ordinary `SYSTEM_MEMORY` resource HOB with
`PhysicalStart >= 4GB` as `EFI_RESOURCE_MEMORY_UNACCEPTED`, so firmware can only allocate below 4 GiB. That is a 2 GiB
window on q35. Root confirmed that `PromoteMemoryResource` does not promote unaccepted memory. The firmware also holds
the initrd in pool and LoadFile2 copies it, and the stub uses `ULONG_MAX`. T1 (4 GiB, no devices) reproduced the
failure **[root]**.

The candidate changes only that branch:

1. `SnpBootWindowClassify(Start, Length, Remaining, &Head)` (pure, in `SnpBootWindow.h`) intersects the HOB with the
   absolute window **[4 GiB, 6 GiB)**.
2. **AcceptAll.** The HOB lies wholly inside the window. It stays `SYSTEM_MEMORY` and goes through the **unchanged**
   `MemEncryptSevSnpPreValidateSystemRam(Start, EFI_SIZE_TO_PAGES(Length))` call.
3. **Split.** The tail `[Start+Head, End)` is appended first, as a new `UNACCEPTED` resource HOB with the same
   attributes and Owner GUID (`BuildResourceDescriptorWithOwnerHob`, `PeiHobLib/HobLib.c:322-343` **[read]**). Only
   after a successful append is the original HOB shrunk to `Head` and pre-validated.
4. **DeferAll** keeps the exact original behaviour: the whole HOB is retyped `UNACCEPTED` and skipped. It applies when
   the HOB is empty, not 4 KiB-aligned (start or length), overflowing (`Length > MAX_UINT64 - Start`), starting at or
   beyond 6 GiB, or larger than the remaining budget. It also applies when the append failed.

What is unchanged: the below-4 GiB path, the SPECIAL_PURPOSE path, a HOB that starts below 4 GiB and crosses it (still
fully pre-validated, as before), non-RAM HOBs, the SEV-ES/GHCB setup, `SevInitializeRam`, and all of
`QemuKernelLoaderFsDxe` / `BlobVerifierLibSevHashes`. **Kernel, initrd and cmdline hash verification is not touched.**

## Range math

- Head = `min(End, 6GB) - Start`, where `4GB <= Start < 6GB`. It is computed only after the overflow check, so `End`
  is representable. Head is page-aligned because Start and 6 GiB both are, and `0 < Head <= 2 GiB`.
- Tail = `[Start+Head, Start+Length)`. Head and tail tile the original exactly, with no gap and no overlap. Both
  start page-aligned, and the tail length is greater than 0 because a split happens only if `End > 6GB`.
- **Budget.** `WindowRemaining` starts at 2 GiB and drops by every accepted head. With disjoint HOBs, the window bound
  alone caps the total at 2 GiB. The budget is defence in depth: duplicate or overlapping HOBs are deferred rather
  than pre-validated twice (PVALIDATE on an already-validated page would hit the library's error path).
- The window is **absolute**. High RAM that starts above 6 GiB gets nothing, which is the original behaviour: safe,
  but no fix. On q35, high RAM starts at exactly 4 GiB **[root/upstream]**.
- **T1 shape (4 GiB guest).** High RAM is exactly [4G, 6G), so the HOB is AcceptAll and **the split path is not
  exercised**. **Bench shape (56 GiB).** [4G, 6G) is accepted and [6G, 58G), 52 GiB, stays unaccepted.

## HOB iteration safety

- The PEI HOB list is append-only and contiguous. `PeiCreateHob` writes at `PHIT->EfiEndOfHobList` and advances it
  (`MdeModulePkg/Core/Pei/Hob/Hob.c:100-106` **[read]**). On exhaustion it returns `EFI_OUT_OF_RESOURCES` without
  moving it (`:97`). `BuildResourceDescriptor*Hob` returns `void` and silently skips on NULL in RELEASE. The candidate
  therefore compares `PhitHob->EfiEndOfHobList` before and after the append. If it did not move, the candidate takes
  DeferAll and no memory is lost.
- Existing HOBs never move, so `ResourceHob` stays valid. Only field values change, never `HobLength`, so
  `GET_NEXT_HOB` is unaffected.
- The appended tail sits where the old end marker was, so the same walk reaches it. It is `UNACCEPTED`, so the
  `ResourceType == SYSTEM_MEMORY` test skips it. It is never split again, and the walk terminates: each split adds at
  most one non-RAM-typed HOB.
- **No allocation recursion.**
  - `MemEncryptSevSnpPreValidateSystemRam` above 4 GiB calls `InternalMemEncryptSevCreateIdentityMap1G`
    (`PeiSnpSystemRamValidate.c:123-133`, `PeiDxeVirtualMemory.c:555-640` **[read]**).
  - That function allocates only when the PML4 entry is absent, which is never for addresses below 512 GiB
    **[inference]**.
  - Any allocation is a PEI page allocation below 4 GiB. It creates a *memory-allocation* HOB, not a resource HOB, so
    the loop ignores it.
  - The same path already existed for SPECIAL_PURPOSE ranges above 4 GiB.
- **No false acceptance.** A HOB leaves this code as `SYSTEM_MEMORY` only on the path that falls through to the
  pre-validate call, with exactly its final `ResourceLength`.

## Offline tests (`tests/`, not yet run)

1. **Grid.** The helper is compared with an independent `__int128` reference over 16 starts × 17 lengths ×
   5 budgets. The grid covers below 4G, 4G±page, unaligned values, 6G±page, 2^63 and MAX, plus lengths 0/1/page/2G±page
   and overflow edges. It checks the head's invariants.
2. **HOB-walk model.** A statement-for-statement model of the new loop includes appends and HOB-space exhaustion.
   Generic checks run on every case:
   - tiling with no gap or overlap;
   - a tail exists only for a split;
   - a head is inside the window and validated exactly once;
   - no tail intersects a validated range;
   - the total is ≤ 2 GiB;
   - below-4G and SPECIAL_PURPOSE HOBs are unchanged and validated whole;
   - non-RAM and already-unaccepted HOBs are untouched;
   - appended HOBs are all `UNACCEPTED`.

   Cases:
   - q35 at 4 GiB and at 56 GiB;
   - a 4 KiB HOB;
   - a start at 5.5 GiB;
   - one page straddling 6 GiB;
   - a start above 6 GiB;
   - malformed start, length, zero length and 2^64 overflow;
   - two HOBs sharing the budget;
   - a duplicate HOB;
   - SPECIAL_PURPOSE above 4G, sub-4G crossing 4G and a pre-existing unaccepted HOB;
   - append failure.

   **Limit:** the model has to be kept in step with `AmdSev.c` by review. It does not execute edk2 code.

## Limitations and open risks

- Every artefact is unbuilt and unrun. The patch's hunk offsets were computed by hand against the read file.
- **Host RAM.** About 2 GiB more of guest_memfd is now faulted in at boot. Expect `memory.peak` to be roughly +2 GiB
  over the ~2.49 GB seen on arm A. Re-check the bench RAM-floor formula and any MemoryMax before a coordinated slot.
- **Boot time.** Pre-validating 524,288 pages takes extra time. This is unmeasured.
- **Fit (inference).** 2 GiB low plus 2 GiB high should hold firmware pool, the stub's 724 MiB copy and the kernel.
  The stub's `AllocateMaxAddress(ULONG_MAX)` should land top-down in [4G, 6G) **[upstream]**. This is not proven
  until a boot shows it.
- The guest kernel must support unaccepted memory (already true for today's >4G deferral).
- **Upstream precedent [upstream, unverified here].** TDX has partial-acceptance HOB splitting. This candidate is not
  upstream and has to be carried.

## Gates before any qualified use (in order, each needs root approval)

1. Patch dry-run with `-F0`. The diff touches exactly 3 files. Offline tests print ALL PASS under ASan/UBSan.
2. The base build reproduces `142589cc...`, and then `cand` builds. Record both sha256 values.
3. Re-run `verify-firmware.sh` against `cand`, in a separate output, never into `fwbuild/`.
4. **Mandatory negative tests on `cand` before any production release.** Each must refuse before the stub runs: no
   `EFI stub:` line, and boot falls to the AmdSev GRUB fallback or terminates.
   - (a) `kernel-hashes=off` / missing hash table.
   - (b) Kernel substitution: the served kernel ≠ the table hash.
   - (c) Initrd substitution, including the 724 MiB image with one flipped byte.
   - (d) Cmdline substitution.
   - (e) Table present but with a corrupted GUID, a truncated or overlong length, or swapped entries.
   - Use the existing review-lane substitution fixture. Do not invent a new harness.
   - (f) Confirm the production verifier and admission still **reject** the `cand` measurement while it is
     unqualified, with allowlists unchanged.
5. **Positive tests, one boot each, not a 22-boot sweep.**
   - The T1 shape (4 GiB, 2 vCPU, no devices) with the unchanged 724 MiB image boots past the stub.
   - An 8 GiB shape exercises the split path. In the guest, `MemTotal` equals the full RAM and unaccepted memory is
     accepted lazily.
   - Run both under a coordinated slot with the existing watchdog.
6. Only after 1-5 can root decide whether A and B both use this one qualified `cand` firmware. Any production
   adoption is a separate, measured release decision.
