# Storage final composition: kernel-tested cache fixes adopted into S's holder source and P's L1 package (RESULT, 2026-10-23)

**Status: SOURCE PACKAGE ready for the placement plan.**
- **Not done:** no production cache, ledger, allocation or activation; no kernel test in this scope; no SSH, no push.
- **Old trees and evidence untouched:** `fresh-witness-supply`, `rpc-l1-source-package` and
  `cache-native-boundary-20261023` are unchanged.
- **New clones:** `s/` and `p/`, author SteveDeFacto, origins removed.

## 1. Exact pins

| | Base (immutable history) | Composed commits | HEAD |
|---|---|---|---|
| **S holder** (`s/`) | `bcd3d9ca` = `959e56fd` budget v2 + `47c2f71` + `bcd3d9c` report-timestamp fix. Its tree equals root's `dc767fc3` (which has a personal-email author and is on no branch, so the canonical-identity commit is used) | `c74e302` template fixes + seam tests + mutants; `92b7178` `RUNBOOK-CACHE.md` | **`92b71784c9452056eeeb6a97b8e1fcb8ef1815ca`** |
| **P L1 pair** (`p/`) | `f8351487` | `f8c999e`: re-vendor S `92b7178`; P RUNBOOK §8a; test pin; runner label | **`f8c999ed5a9600ef477ff05ee00b31dee366b2b1`** |

**Files:**
- **`holder/holder-storage.sh.in`:** `eb6a209d` → **`cab32bbe9967d56e75366ee573ff0cf4173ba66080e6b5fc58bc8c857ca8f222`**, identical in S and in P's vendor (`render/summary.json` `pEqualsS: true`).
- **Unchanged:** `holder.py` `c73a4351`, `budget.py` `529e155f` (budget v2), and P's `l1pair.py` `a25bd4ea`.
- **New:** `holder/RUNBOOK-CACHE.md` `c599d997`, vendored in P.
- **P vendor:** `VENDOR.json` pins all seven files.

**Root teardown fixes are present.** They reached S as cherry-picks, so they are ancestors under these hashes, and their
text is in the composed template (`PROVENANCE.json`):
- `b1b6f18` → `08f2efe` (validate ownership before unmount);
- `c3efff4` → `fd0134d` (stop at the first failed teardown).

## 2. What changed (S `c74e302`; P re-vendors it byte-identically)

1. **0002, as kernel-tested in vm-3.** `trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP`, so a signal
   takes the existing EXIT unwind. The code line is byte-identical to vm-3; only the comment wording differs.
2. **0001, tightened as root required.** `create`'s NVMe free-space preflight subtracts the allocated bytes of a cache
   file **only if** all of these hold:
   - it is a regular file, not a symlink;
   - its `.enclave-budget-owner` marker exists, as a regular file and not a symlink;
   - it is on the **same filesystem** (`st_dev`) as the CDATA directory being measured.

   The credit is capped at the declared size; anything else gets 0. `budget.py admit` (unchanged, run right after)
   still refuses a file whose marker names another reservation. This differs from the vm-3 test patch, which credited
   any existing file.
3. **The `cache-loss` loop question, resolved.** Previously it left the origin loop it attached for its own check
   attached; the next `assemble` reused it. That was not a deliberate design: it only leaked a loop.
   - **Now:** it detaches **only loops this run attached**. A loop that existed before (left by an earlier `assemble`,
     or in use) is kept.
4. **The `disassemble` policy, resolved.** It now **never detaches a loop that is still mounted anywhere or held by
   another device** (`lsblk` MOUNTPOINTS, and holders listed as children). Instead it stops with exit 2.
   - **Why:** `losetup -d` on a busy loop "succeeds" by setting autoclear, so the old code could silently schedule
     detaching an active or foreign-used origin.
   - **Unchanged:** the ownership checks of the mount and mapping (root `b1b6f18`).

**Renderer output** (`jobs/render-diff.py`):
- **Configs:** vm-3's holder and pair test configs, rendered with the COMPOSED S `holder.storage_script` and P
  `l1pair.storage_script`.
- **Constants:** identical to vm-3's (`constantsIdenticalToVm3: true` for both).
- **Template body:** both renders use the composed body.
- **Diffs:**
  - against vm-3's PRODUCTION render: 29 changed lines each (holder, pair);
  - against vm-3's FIXED render: **32 lines, exactly the four items above** (see
    `render/pair-storage.sh.vs-vm3-pair-storage.fixed.sh.diff`).

## 3. Runbook: suspect cache vs power loss (`s/holder/RUNBOOK-CACHE.md`, P RUNBOOK §8a)

**These are distinct, and not automatically the same.**
- **Power loss with a healthy cache:**
  - the boot `assemble` is acceptable (vm-3: exit 0, 0 dirty, fsynced data correct);
  - then `dmsetup status` must show `writethrough`, 0 dirty, no `needs_check`, mode `rw`;
  - any deviation → treat it as suspect.
- **Suspect or corrupted cache device:**
  - **triggers:** I/O errors, SMART warnings, `needs_check`, dirty > 0, fsck errors, tampered or restored images;
  - **procedure:** **stop the consumer first**, then `disassemble`, then **`cache-loss` BEFORE `assemble`**;
  - **why:** dm-cache serves corrupted cache content unchecked. Measured: 10,688 / 40,960 4 KiB blocks wrong, and the
    filesystem unmountable.
- **Also covered:** uncached origin access (`cache-loss` is mandatory), replacing or dropping the cache device (and the
  known gap: no single "re-create cache for an existing origin" verb; the manual steps are given), interrupted `create`
  (signals unwind; SIGKILL/power-loss recovery steps), the loop policy, and the one aggregate budget.

## 4. Tests (delta-required only; no kernel run in this scope)

All through `work/claude-test-queue.py` (16 GiB floor; one large + small 256 MiB lanes; ≤ 1536).

| Run | What | Result |
|---|---|---|
| **s-t1** | S's own `run-tests.sh holder` on the composed S (environment pointed at this clone): `test_holder` / `test_storage` / `test_budget` | **18 / 30 / 19 OK**. 7 NEW storage seam tests (below); none skipped |
| **s-m1** | S's shell mutants (template only changed): 6 existing + 8 new | **13/14 killed**. The survivor, `sh:credit-symlink`, drops the `[ ! -L ]` guard. It is behaviourally equivalent within the test's tolerance: `stat -c %b` without `-L` measures the LINK itself (0 blocks, or 1 block for a long target), so a symlinked cache path is still credited at most 4 KiB. The guard is kept as defence in depth |
| **p-u2** | P's unit suite on the re-vendored P (final commit) + the byte-level render diff | **20/20 OK**; vendor pins verified; render-diff rc 0 |

P's mutants and the real-binary reth/Lighthouse/Base runs were not repeated, because P's launcher `l1pair.py` is
unchanged. vm-3's kernel run was not repeated, per scope.

**New seam tests in `test_storage.py`** (real script, stubbed privileged commands, real files):
- **SIGTERM to the process group** mid-`create` (stub mkfs sleeping, with the origin and loop present): exit **143**,
  "undid only what this run created", origin removed, loop detached.
- **Owned complete cache files present** after a removed origin, with free space below a full re-allocation: `create`
  passes (credit).
- **No credit for:**
  - an **unmarked** file;
  - a **symlinked** cache path;
  - a cache file on **another filesystem** (CMETA on the workspace ext4 vs CDATA on `/tmp` tmpfs).

  Each is refused with "not enough NVMe free space", and nothing is created.
- **A credited file whose marker names ANOTHER reservation:** the free-space check passes, but **budget admit refuses**
  ("ownership marker"); the foreign file is untouched and no origin is created.
- **`cache-loss`:**
  - with no prior loop → none left afterwards;
  - with a pre-existing origin loop → kept.
- **`disassemble`:** a loop held by a foreign mapping, or mounted elsewhere → exit 2, "still mounted or held", the loop
  and its user untouched, and no `losetup -d` of it.

**Kernel coverage, stated exactly:**
- **Kernel-tested in vm-3 (7.2.11 guest):**
  - 0002 as composed;
  - the credit concept, with a looser rule (any existing file).
- **Seam-tested only:**
  - the tightened credit conditions;
  - the `cache-loss` own-loop detach;
  - the `disassemble` in-use refusal (it relies on `lsblk -nro NAME` listing dm holders as children).

  A bounded re-run of `cache-native-boundary` `harness/run.sh` against these renders is the remaining verification. It
  was not authorized in this scope.

## 5. Budget (unchanged design, one aggregate)

- **One ledger for everything:** the Base holder and the L1 pair, plus any other cache of this work, are charged in ONE
  ledger, `/etc/enclave-rpc-cache/nvme-cache-budget.json` (budget v2).
- **Limits:** a cap of 250,000,000,000 B across ALL hosts and caches, with a 200 GB target.
- **What a reservation is charged:** its maxBytes = files + markers + directory entries + extent metadata + one
  allocation step's spill. Node temp lives on the HDD mount.
- **Current shares:**
  - **L1 pair:** default `cache: none`, which reserves nothing;
  - **Base holder:** S's example plan is 199,140,835,328 B, leaving 0.86 GB under the target.
- **No ledger was created, and no allocation was made.**

## 6. Gates remaining for root

- **The NucBox placement plan.** It is owned by the `nucbox-rpc-placement` worker, not this package. Per root's
  inventory (09:45), NucBox has 45.27 GiB physical free of 111.82 total, VMs assigned 56.375 GiB, and only NVMe
  attached; the 33 TB HDD is on the desktop.
  - **This package does not choose:** the placement, a RAM limit, or the HDD transport.
  - **Its preflight still refuses:** memory, placement and budget gates that are unmet.
- **Before any production cache:**
  - run the cache harness inside the **actual NucBox Linux VM** on its real virtual disks, at bounded scratch size (crash
    test included), with these composed renders;
  - decide where the durable HDD origin lives for that VM;
  - create the canonical ledger with real per-host shares.
- **Still unproven:** a real USB RAID or NTFS origin, throughput, a physical power cut of the enclosure, and the host's
  running kernel.

## 7. Files

- `PROVENANCE.json`: pins, commits, ancestry and cherry-pick evidence, render shas.
- `render/`: composed renders, diffs against vm-3 (production and fixed), `summary.json`.
- `jobs/`: `s-tests.sh`, `p-unit.sh`, `render-diff.py`.
- `logs/`: s-t1, s-m1, p-u1, p-u2.
- `s/`, `p/`: the composed source repositories. Root and D capture them; they are not pushed.
