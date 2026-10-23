# Shared NVMe cache budget: a hard aggregate bound in source (RESULT-CACHE-BUDGET, 2026-10-23, rounding fix ~08:40Z)

**Status: SOURCE + SEAM-TESTED. NOT kernel-proven, NOT allocated, NOT activated.**
- **Not done:** no SSH, no sudo, no mount, no allocation, no sync, no production or VM change, no push.
- **Prior commits preserved:** `6b9dae9` (RESULT-BINARY-PREFLIGHT), `2681e8a` (budget v1 source) and `9f1492f` (v1
  result and handoff) are unchanged history; the work below is later commits.
- **Commits** (`work/fresh-witness-supply`, SteveDeFacto):
  - **source (current):** `959e56fd7ea191bfcc7eb94b26a20d4795856bd3`, budget v2. It replaces `2681e8a`, which **must
    not be activated** (§0);
  - **this file, the handoff note and the P note:** HEAD.

## 0. Correction: v1 (`2681e8a`) was not a bound on ACTUAL allocation (root review, fixed in `959e56f`)

**Root's counterevidence holds.** Root froze `budget.py` `a82192bc…` (the exact `2681e8a` source) and ran a real
`allocate` + `verify` (`outputs/decentralization-audit/cache-budget-allocation-accounting-20261023.json`). The setup
was a local share of 1 B, one reservation `maxBytes` 1 / `slackBytes` 0 / one 1-byte file, and the other host's
`CAP-1` share declared only. **Two real files allocated 8192 B (the file 4096 + its marker 4096), and `verify` accepted,
reporting `chargedBytes` 1.** My earlier §6 claim ("every holder cache byte is reserved at its maximum") was therefore
wrong for real allocation. v1:
- charged **declared** bytes only;
- let **each file** over-allocate by `EXTENT_SLACK_MAX` (64 MiB) on its own, never charged to the reservation's slack
  or the host share. Two files could each use the "same" slack;
- never charged markers, block rounding, the ledger or the lock;
- accepted zero slack and sizes that are not block-aligned.

`test_budget.py` now reproduces both cases against the real `2681e8a` source (read with `git show`, sha-asserted
`a82192bc…`, not a rewrite):
- **1-byte case:** charged 1, 8192 B real, verify accepted;
- **two over-allocated files:** verify accepted, charged `maxBytes`, while actual exceeded it.

**Fix (`budget.py` `529e155f…`, ledger format `enclave-rpc-nvme-cache-budget/v2`; v1 ledgers are refused):**

*Rules checked before any write (`validate`, pure):*
- **ACTUAL bytes** of a reservation = `st_blocks` of its files + their markers + a fixed directory-entry charge (one
  block per file). Every bound compares ACTUAL with `maxBytes`. **There is no per-file allowance any more.**
- **`blockBytes`:** each reservation declares it, and every file size must be a multiple of it (no partial blocks).
- **`slackBytes ≥ required_headroom`:**
  - per file: 1 marker block (markers are ≤ 512 B), 1 directory-entry block, and 2× the ext4 extent tree of a contiguous
    `fallocate` (unwritten extents of ≤ 32767 blocks; (B−12)/12 entries per tree block; 4 in the inode);
  - plus **one allocation step's worst case**: one extent per block across the 64 MiB step, plus a leaf split and one
    more tree level.
- **Per host:** `BOOKKEEPING_BYTES` = 64 KiB + 3 × 4096 = **77,824 B** is charged for every listed host (the ledger,
  capped at 64 KiB by `load`, plus the lock and their directory blocks). The host's reservations + bookkeeping must
  be ≤ its share, and shares must still sum to ≤ 250,000,000,000.

*Allocation (`allocate`, exclusive lock):*
- **Filesystem check first:** it reads the file system type (`/proc/self/mountinfo`) and block size (`statvfs`) of every
  file's directory. Only `ext4` and `tmpfs` are accepted, with block size = `blockBytes`; anything else is refused
  before a marker or file exists.
- **Projected bound, before writing anything:** present allocation + missing markers (1 block each) + all remaining
  declared data + one step's headroom must be ≤ `maxBytes`.
- **Bounded steps:** each file is allocated in 64 MiB steps, re-checking actual + remaining + one step's headroom before
  every step. If a filesystem allocates more than the estimate, allocation stops **inside** the maximum and unwinds what
  it created.
- **Final check:** actual ≤ `maxBytes` after the last step.
- **Interrupted create:** an owned incomplete file is reset to 0 in place (same inode), so its old blocks are never
  miscounted, and is then allocated again. A complete owned file is untouched; nothing is ever re-granted.

*Verification (`verify`):*
- every local reservation's ACTUAL ≤ its `maxBytes`;
- ledger + lock allocation ≤ `BOOKKEEPING_BYTES`;
- it reports `actualBytes`, `reservationActualBytes` and `requiredHeadroomBytes`.

**The existing real cache example stays valid unchanged.** It needs 286,720 B of headroom against its 67,108,864 B of
slack:
- data file: 57,344 B (1,476 extents → 5 leaves + 1 index, ×2, + marker + entry);
- metadata file: 16,384 B;
- one step: 212,992 B.

`maxBytes` stays 199,140,835,328. The workstation share of 200,000,000,000 leaves **859,086,848 B** after bookkeeping.

**What this bound depends on (not proven here):**
- **`st_blocks`:** it must report all of a file's data AND extent-tree blocks. This holds for ext4 and tmpfs.
  Filesystems with CoW, snapshots, compression or delayed accounting are refused as unsupported.
- **Directories:** parent-directory growth must stay within one block per entry.
- **Other per-file space:** ext4 must not allocate per-file space outside `st_blocks` (inode tables are preallocated at
  mkfs).
- **The headroom estimate** only decides how much slack is required. If real extent metadata is larger, allocation
  refuses inside `maxBytes` rather than exceeding it. **The worst case is bounded only by that progressive check, and
  the check has been exercised on tmpfs, not on the real `/vm` ext4 under dm-crypt.**

## 1. The defect, and why the previous design was not a bound

The previous `verify-cap` (`fd0134d` and earlier) measured other caches **at a point in time**, from an inventory of
paths:
- **a missing path counted 0;**
- **later growth was unconstrained;**
- **two concurrent creates could each measure the other as absent** (there was no lock);
- **directory entries were allowed**, though nothing bounds a directory;
- **the planning estimates in the config** (`otherNvmeCacheAllocations`) were not enforced anywhere.

The controls in §5 reproduce all of this against the old script.

## 2. Fix: one static ledger of fixed maxima (`holder/budget.py`)

**Identity (canonical, shared by every package and host):**
- path `/etc/enclave-rpc-cache/nvme-cache-budget.json`, format `enclave-rpc-nvme-cache-budget/v2` (v1 refused, §0);
- a root-owned regular file that is not group/other writable;
- lock: the sibling `nvme-cache-budget.json.lock`, used only for this budget and never for anything host-wide.

**Rules (`validate`, pure):**
- **Cap:** `capBytes` is exactly 250,000,000,000; it is not configurable. `targetBytes` is 200,000,000,000.
- **Hosts:** keyed by `/etc/machine-id`, each with a fixed `shareBytes`. **The shares of all hosts sum to ≤ cap.**
  Hosts that do not share a lock therefore still cannot exceed the aggregate, and no host gets an implicit 250 GB.
- **Reservations:**
  - **Charged at their declared `maxBytes`**, whether or not the files exist: absent never means zero. `maxBytes` equals
    Σ fixed, `blockBytes`-aligned file sizes plus `slackBytes` (≥ the required headroom, §0); ACTUAL allocation is
    bounded by it.
  - **Only hard-bounded kinds:** `preallocated-files`, meaning fixed-size, fully allocated files whose consumer cannot
    grow them (dm-cache data/metadata, or a fixed image holding a cache filesystem, which bounds that cache's
    metadata, journal, tmp and spill too). **Directory entries are refused.**
  - **Per-host sums** must fit the host's share.
  - Ids and machine ids must be unique, and paths must not overlap.

**Transitions:**

| verb | lock | behaviour |
|---|---|---|
| `admit` (`create` preflight) | shared | the reservation exists **for this host** and names exactly the config's files and sizes; present files must carry this reservation's marker |
| `allocate` | exclusive | re-validate; check filesystem and projected total first (§0); write an O_EXCL ownership marker, then `posix_fallocate` each file to its exact size in bounded steps. Foreign files are refused untouched. An interrupted earlier create (marker present, file partial) is **reset and completed in place (same inode), never re-granted**. On failure it removes only what this call created; pre-existing owned artifacts are kept |
| `verify` (`assemble`, `verify-cap`) | shared | ledger valid; this host's charged maxima fit its share; every present file of every local reservation is owned, exactly sized and non-sparse (it refuses grown, sparse or foreign files); this reservation's own files must exist (**missing → refused**); every local reservation's ACTUAL allocation ≤ its `maxBytes` (§0) |

**Storage script.** `holder-storage.sh.in` no longer measures anything itself:
- `create` calls `admit` before allocating anything, then allocates the cache files only through `allocate`;
- `assemble` and `verify-cap` call `verify`;
- **there is no fallback into another path:** if the reservation is refused, nothing is allocated.

**Config compatibility (holder).**
- `storage.otherNvmeCacheAllocations` and `storage.nvmeInventoryPath` are **removed and refused**.
- `storage.nvmeBudget {ledgerPath, reservationId}` is **required** for `dm-cache`. Its `ledgerPath` must be the
  canonical path. It is refused for `none`.
- A single cache above the 200 GB target is refused by itself.
- `preflight` checks that the ledger reservation equals this cache exactly (files, `maxBytes`, `slackBytes`) and that
  `verify` passes.
- The rendered package includes `nvme-cache-budget.example.json`. It is not valid until root fills in the machine ids.

**Unchanged:**
- the official binary pin `9c44836d…`;
- the HDD-backed origin and placement rules;
- root's teardown fixes `b1b6f184` and `c3efff41`;
- the RAM limit and gate;
- writethrough only;
- admin and features.

## 3. Fixed budget example (one host)

| reservation | files | maxBytes |
|---|---|---|
| `base-holder-dm-cache` | `blockBytes` 4096; `/vm/enclave-base-holder-cache/cache-data.img` 197,999,984,640 + `cache-meta.img` 1,073,741,824, slack 67,108,864 (required 286,720) | **199,140,835,328** |

- **Host share:** workstation 200,000,000,000 (the target). After bookkeeping (77,824 B), 859,086,848 B of headroom
  remain.
- **Unassigned:** 50,000,000,000 B (between target and cap); no host share covers it.
- **P (L1 pair, cache none):** reserves 0.
- **Any future cache** (for example Sia) needs its own root-approved fixed-size reservation, and the share must be
  adjusted so the total stays ≤ cap, or ≤ target operationally.

The full JSON is in `HANDOFF-P-CACHE-BUDGET.md` §4.

## 4. Coordination with P (`work/rpc-l1-source-package`; its code was not edited and its tests were not touched)

The note is `HANDOFF-P-CACHE-BUDGET.md`, with a copy at `rpc-l1-source-package/NOTE-FROM-S-CACHE-BUDGET.md`. The
rounding fix has its own separate note: `rpc-l1-source-package/NOTE-FROM-S-CACHE-BUDGET-ROUNDING.md`.

**What P must do:**
- vendor `959e56f`: `holder.py` `c73a4351…`, `budget.py` `529e155f…`, `holder-storage.sh.in` `eb6a209d…` (unchanged
  since `2681e8a`; includes root's `b1b6f184` and `c3efff41`). **`2681e8a`'s `a82192bc…` must not be vendored for
  activation;**
- adopt the canonical ledger, which replaces both inventory TSV paths;
- drop `otherNvmeCacheAllocations` and `nvmeInventoryPath`;
- set the template constants `PY BUDGET_TOOL LEDGER RESERVATION`;
- with cache none, reserve nothing.

## 5. Tests and controls (queue, 256 lane unless noted; logs in `logs/`)

**Rounding fix (`959e56f`; the tested sha256 values printed in each log equal the committed ones):**

| run | result |
|---|---|
| `ra-t1` | `test_holder.py` **18/18**, `test_storage.py` **23/23**, `test_budget.py` **19/19** (11 earlier + 8 new). Peak RSS 99 MiB |
| `ra-m1` | **20/20 mutants killed**, each by its targeted test: the 7 earlier budget mutants, plus 11 new ones (`no-alignment`, `no-headroom`, `no-bookkeeping`, `markers-uncharged`, `no-prewrite-bound`, `no-step-bound`, `no-final-bound`, `no-verify-actual`, `any-block-size`, `any-fs`, and `adopt-foreign` rewritten for the new code), plus `cap-off-by-slack`, `sh:verify-bypassed` and `sh:admit-bypassed` |
| `ra-render` | review render refreshed: `nvme-cache-budget.example.json` is v2 with `blockBytes` 4096 |
| not re-run | the official-binary offline fixture (`cb-off`). The launcher argv/env, `BINARY.json` and the storage template are unchanged |

**New tests** (`test_budget.py`, the `Accounting` class plus 2 `Rules` additions; real tmpfs files, real `fallocate`):
- **Root's case, rejected before any write:**
  - the old source reproduces charged 1 / 8192 B / accepted;
  - new: a 1-byte file, zero slack, and an aligned headroomed file over a share of 1 are each refused **before any
    marker or file exists**, each for its own reason;
  - a correctly shared one-block reservation passes, with actual ≤ max and host actual ≤ share.
- **Correctly budgeted small files pass, counted exactly:** actual = files + 2 marker pages + entry charge.
- **Files and markers together ≤ the reservation:**
  - one file over-allocated past EOF (`FALLOC_FL_KEEP_SIZE`, real) by all the spare is exactly at `maxBytes` and
    accepted;
  - +4096 B on the second file is refused by `verify` and by re-`allocate`;
  - the old source accepts the same state.
- **Overshoot while allocating:**
  - a filesystem seam that adds 2 blocks per step makes allocation stop before step 2, with the observed actual never
    above `maxBytes`, and everything unwound;
  - a last-step overrun is caught by the final check and unwound;
  - a pre-existing over-allocated owned file refuses before the rest is written.
- **Filesystem rules:**
  - a block-size mismatch (8192 declared on a 4096 tmpfs) and an unsupported fs are refused before writing;
  - the real NVMe scratch reads as ext4/4096;
  - exact-headroom −1 is refused; share = max + bookkeeping − 1 is refused; a ledger over 64 KiB is refused.
- **Kept:** idempotence, 4-process concurrency, interrupted create (now reset and completed, same inode), foreign file
  untouched, failure keeps pre-existing artifacts, lock ordering, the storage-script seams (create/assemble/teardown/stop
  on cleanup failure).

**Earlier v1 runs (`2681e8a`):**

| run | result |
|---|---|
| `cb-t2` | `test_holder.py` **18/18**, `test_storage.py` **23/23** (17 S + 6 root seam cases, on the ledger), `test_budget.py` **11/11** |
| `cb-m3` | `test_budget.py` 11/11 again, then **7/7 budget mutants killed**, each by its targeted test: `no-share-sum`, `no-per-host`, `allow-directory`, `missing-ok`, `allow-sparse`, `adopt-foreign`, `no-lock` |
| `cb-m1` | **16/16 launcher and storage-script mutants killed**, including the new `sh:verify-bypassed` and `sh:admit-bypassed`. The 6 root/S teardown and storage mutants still apply |
| `cb-off` | 768 lane: the official-binary offline fixture, unchanged behaviour (loopback `0x2105` at 1.3 s, L1-less exit 1, default `reth.toml` refused, `l2_jwt.hex` in the datadir) |
| `cb-render` | refreshed review-only render (`evidence/render-review/`, with `nvme-cache-budget.example.json`) |

**What `test_budget.py` covers** (real small files, real `posix_fallocate`, real processes):
- **Ledger rules:** 11 refusals, plus an exact two-host split at the cap that becomes +1 → refused.
- **Allocation:**
  - exact, non-sparse sizes;
  - idempotent re-allocate that grants nothing;
  - foreign file refused and left untouched;
  - interrupted create completed in place (same inode);
  - failure keeps pre-existing owned artifacts.
- **Verification:** an absent participant is charged at its maximum; sparse, grown and missing-own files are refused.
- **Concurrency:**
  - 4 processes allocate one reservation, and exactly one creates while the others adopt;
  - an allocation blocks behind a held ledger edit, and then sees the edit's result (reservation removed → refused, no
    files).
- **Controls against the previous script** (`fd0134d` via `git show`, the same stub seam):
  - **Missing path counts 0, then growth:** OLD admits while the Sia path is absent; the directory then grows and the
    aggregate exceeds the cap with nothing stopping it. NEW refuses both the directory kind and the over-share sum
    before anything is allocated.
  - **Concurrent creates:** OLD runs two creates at once (a slowed `fallocate` holds the window open); **both pass and
    the NVMe aggregate exceeds the cap.** NEW decides the same pair from the ledger, independent of timing: it is
    allowed within the share, refused over it.

## 6. What is guaranteed where (honest boundary)

**In source, by these tests (`959e56f`; the v1 claim made here at `9f1492f` was wrong, §0):**
- every reservation's ACTUAL allocation (files + markers + entry charge, rounded to real blocks) is held ≤ its
  `maxBytes` before, during and after allocation and at verify;
- each host's reservations + bookkeeping fit its share, and the shares sum to ≤ 250 GB;
- allocation is serialized and ownership-marked;
- unbounded kinds, unaligned sizes, insufficient slack, unsupported filesystems or block sizes, missing own files,
  foreign, sparse or grown files, and over-share configurations are refused, before anything is written where
  applicable.

**NOT proven:**
- **Kernel/device behaviour:** that dm-cache never grows its preallocated images, real `fallocate` on the `/vm` ext4
  under dm-crypt, that real extent overhead stays within the required headroom, that `st_blocks` there includes the
  extent blocks, and real flock between root processes. The `drill-cache.sh` boundary
  and invalidation drill is still pending, root-only.
- **Caches outside the ledger:** they are not detected. The bound holds only if every participant allocates through
  the ledger, which root's activation must enforce.
- **Other participants' internal growth:** only a fixed-size image or file bounds it. A participant must place its cache
  inside such an image; this source checks file sizes, not their internals.

## 7. Remaining gates (unchanged unless noted)

1. **The ledger itself:** root writes it with real machine ids and shares. It must be root-owned at the canonical path.
2. **Kernel drill:** `drill-cache.sh` on scratch directories (`/vm` and `/mnt/usb`).
3. **RAM:** about 24 GB is available against the 32 GiB limit. This is not lowered.
4. **Snapshot restore** (820 GB / 1,258 GB) and the follow test, which gives the throughput verdict.
5. **L1:** an L1 endpoint is required at startup (proven), and the signer is unverified. Fresh witnesses are available
   only while a holder is synced. Transaction submission is incomplete.
6. **P:** P re-vendors `959e56f` per the rounding note before any combined activation. `2681e8a` is never activated.

## 8. Next concrete action

1. **Root reviews** `959e56f` (the rounding fix) and the notes.
2. **Root writes the v2 ledger** at `/etc/enclave-rpc-cache/nvme-cache-budget.json`: workstation share 200 GB,
   reservation `base-holder-dm-cache` 199,140,835,328 B with `blockBytes` 4096.
3. **Root runs** `python3 -I budget.py validate` on it.
4. **Then `drill-cache.sh`** as root on empty scratch directories, all before any `holder-storage.sh create`.
