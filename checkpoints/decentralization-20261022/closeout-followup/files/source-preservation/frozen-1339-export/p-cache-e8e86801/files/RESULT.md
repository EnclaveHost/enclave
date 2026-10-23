# Kernel gate for the composed 32-line storage delta (RESULT, 2026-10-23)

**Status: CLOSED for the delta, at guest scale.** The composed template **`cab32bbe9967d56e75366ee573ff0cf4173ba66080e6b5fc58bc8c857ca8f222`**
(S `92b71784`, vendored byte-identically in P `f8c999ed`) ran on the REAL 7.2.11 kernel (installed package) in a
networkless throwaway QEMU/KVM guest. **No bug was found, so there is no source change and no P re-vendor.**

**Not done:**
- no host loop, dm or mount change; no host module load; host kernel 7.2.8 untouched;
- no real ledger, no production cache, no SSH, no push.

**Prior source and evidence untouched:** `cache-native-boundary-20261023`, `rpc-storage-final-compose`, and S's and P's
trees.

## 1. Exactly what ran

- **Renders:** `harness/render.py`, run on the host, used:
  - S's own `holder.storage_script()` (S `92b7178`) for `holder-storage.sh` and `probe-storage.sh`;
  - P's own `l1pair.storage_script()` (P `f8c999e`) for `pair-storage.sh`.

  It asserted that both vendored templates are `cab32bbe…` and that the renders' bodies equal the template. Render
  shas are in `run/<ts>/out/render/seam.json`.
- **Labelled controls, not production:**
  - `old-holder-storage.sh`: the pre-fix template `eb6a209d` with the **identical** constants block;
  - `mutant-credit-symlink.sh`: the composed pair render with the `[ ! -L "$1" ]` guard removed (S mutant
    `sh:credit-symlink`).
- **Seam**, as in cache-native-boundary:
  - **Sizes:** origin 160 / 32 / 16 MiB; cache data 64 / 8 / 4 MiB; metadata 16 / 8 / 8 MiB.
  - **Free margins:** 0. The credit cases substitute ONLY the `NVME_FREE_MARGIN='0'` constant line at run time, with
    every other byte unchanged.
  - **Guest paths:**
    - `/usbtest`: ext4 on the rotational test disk, in place of NTFS `/mnt/usb`;
    - `/vmtest`: ext4 on dm-crypt (LUKS2, fixture key) on the non-rotational disk, as for `/vm`;
    - `/vmtest2`: a second non-rotational ext4 on a test-owned loop, used only for the other-filesystem case.
  - **Ledger:** a fixture at the canonical path in the guest's tmpfs `/etc`, host share exactly full (113,668,096 B).
  - **Production bounds:** validator minima untouched.
- **Source pins of this run** (`run/20261023T112303Z/out/source-pins.txt`): `guest.py` `b1ceb531…`, `render.py` `937ab5bd…`.

## 2. Results (run vm-1, `run/20261023T112303Z/`; every exit code in `out/receipts.jsonl`)

**A. Real lsblk/losetup facts the new checks rely on.** Under the live `enclave-base-holder` mapping, each of the three
holder loops shows:
- `/sys/.../holders = [dm-1]`;
- `lsblk -nro NAME` = `[loopN, enclave-base-holder]` (holders ARE listed as children, so the count is > 1);
- MOUNTPOINTS lists the mapping's mount;
- `autoclear 0`.

After `disassemble`: no holder loops and no mapping.

**B. `disassemble` never detaches an active loop.**

| Case | Composed | OLD-template control |
|---|---|---|
| origin loop held by a foreign mapping | **exit 2** "still mounted or held …: not detaching it (stopping)". `autoclear` stays **0**; the loop stays bound after the foreign user is gone | exit **0** "disassembled", but the kernel set **`autoclear=1`**: the loop vanished once the foreign mapping was removed |
| origin loop mounted elsewhere (`/mnt-raw`, ro) | **exit 2**, `autoclear 0`, still bound after umount | exit **0**, **`autoclear=1`**, gone after umount |

**C. `cache-loss` detaches only what it attached.**

| Case | Composed | OLD control |
|---|---|---|
| no origin loop before | exit 0, **no loop left** | exit 0, **leaves `/dev/loop1`** |
| an origin loop existed before | exit 0, **the same loop kept** (same backing file and inode) | — |

**D. Free-space credit**, on real ext4 on dm-crypt with block size 4096:
- **D1, owned complete cache files:** origin removed, margin so a full 16 MiB re-allocation would not fit. **exit 0**:
  adopted.
- **D2, unmarked foreign file at the CMETA path:**
  - tight margin → **exit 2** "not enough NVMe free space" (no credit);
  - zero margin → **exit 2** from budget admit, "exists without this reservation's ownership marker".
  - In both cases the foreign file is unchanged, and no origin and no loop are created.
- **D3, a symlinked cache path with a forged "own" marker** (the mutant assessment, §3): composed **exit 2** in every
  case. With zero margin, budget **allocate** refuses: "is not this reservation's regular file". State preserved.
- **D4, metadata on ANOTHER filesystem** (`/vmtest2`, st_dev 1792, vs `/vmtest` 64768):
  - margin set so that crediting both files would pass → **exit 2** "not enough NVMe free space", because only the
    same-filesystem CDATA is credited;
  - files unchanged, no origin, no loop;
  - zero margin → exit 0 (adoption).

**E. Retained composition checks:**
- **E1, SIGTERM to the process group** during a fresh composed `create` (uninterrupted 0.296 s): **6 of 6 attempts →
  exit 143**, origin removed, no loop left.
- **E2, fsynced data survives:** 4 × 4 MiB fsynced files survived `disassemble`, uncached origin access (case B), and
  `cache-loss` (×3) + `assemble`: **0 mismatches**. Status: writethrough, 0 dirty, no `needs_check`. `verify-cap` exit 0.

**F. Cleanup:**
- **Guest:** every script `disassemble` exit 0. The test's own loops were detached only after re-checking backing file
  and inode. umount, `cryptsetup close` → **no loops, no dm devices, no test mounts**.
- **Host before/after:** identical — no loops; dm `control cryptroot cryptvm`; the same block devices; mountinfo hash
  `df9e600d…`; 0 QEMU processes.
- **Removed:** the disk images, fixture key and initramfs.
- **Allocation:** `du` of the test directory peaked at **134,721,536 B ≤ 512 MiB**. Disks actually allocated
  52.7 MB + 72.3 MB (sparse; apparent 256 + 208 MiB). Queue peak RSS 384 MiB.

## 3. The surviving `sh:credit-symlink` mutant, assessed on the real kernel

**What it does:** the mutant removes the `[ ! -L "$1" ]` guard, so a symlinked cache path is credited
`stat -c %b` × 512 of the **link itself**.

**Measured** (ext4, 4 KiB):
- a short (fast, 21-char) symlink allocates **0 B**;
- a long (slow, 110-char) symlink allocates **4,096 B**.

The ≤ 4 KiB assumption holds for the supported fixture.

**Behaviour:**

| Case | Outcome |
|---|---|
| Short symlink | mutant ≡ composed in both margins |
| Long symlink, margin inside that 4 KiB window | the mutant passes the free-space preflight where composed refuses. `budget.py allocate` then refuses ("is not this reservation's regular file"), and the unwind removes the transient origin and loop |
| Final state, every case | identical and preserved: target unchanged, symlink intact, no origin, no loop, no data file |

**Conclusion for these fixtures:** the guard adds an earlier refusal. Removing it permits a 4 KiB preflight credit
in the measured long-symlink case; budget allocation still refuses the symlink. An owned origin and loop can be
created transiently before that refusal, then unwound. The tested final states contain no retained allocation or
foreign-data modification. This is final-state preservation in the exercised cases, not identical intermediate
behavior or a proof that removing the guard is harmless in every environment. The production guard is retained.

**Mutant score, stated plainly:** S's shell mutants remain **13/14 killed**. The surviving mutation changes the
refusal stage and transient work but preserves the tested final states. That is not a claim that every negative
control is killed.

## 4. Remaining gates (unchanged by this run)

- **Not proven by this guest:**
  - real NucBox placement: Windows/Hyper-V host, Linux VM, its real virtual disks and flush semantics;
  - where the durable HDD origin lives (the 33 TB HDD is on the desktop);
  - a real USB RAID or NTFS origin;
  - throughput;
  - a physical power cut;
  - the host's running kernel 7.2.8;
  - full-size caches;
  - the real shared ledger.
- **Owners:** the `nucbox-rpc-placement` worker owns placement and memory. Root owns ledger creation and activation;
  D owns the source checkpoint.

## 5. Files

- `harness/`: `render.py`, `guest.py`, `run.sh`, `init`, `build-initramfs.sh`.
- `vendor/`: S `92b7178` and P `f8c999e` (read via `git show`); the old template from S `bcd3d9c`.
- `run/20261023T112303Z/out/`:
  - `results.json`, `receipts.jsonl`, `console.log`, `guest-delta.log`;
  - host and disk identity files;
  - `render/` (incl. `seam.json`), `source-pins.txt`.
- `logs/`: render-1, vm-1, scan.

## 6. Scans

- **scan-1:** gitleaks `generic-api-key` hit 2 receipt lines. Both were the receipts' own `"key"` field holding the
  result names `D2.unmarkedForeign` and `E2.verifyCap`: not credentials.
- **Fix:** `.gitleaks.toml` allowlists exactly those two values, plus the existing public PGP fingerprint.
- **scan-2:** crypto-key scanner 0; gitleaks **no leaks** over all commits and `run/`.
