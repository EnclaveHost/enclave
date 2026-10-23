# frozen-0331-export: how to rebuild the exact commits

Everything here is source plus offline tests only. Nothing is merged into the normal tree, imaged or deployed, and root
owns activation.

| Side | Repo / branch | Base → head | Head tree |
|---|---|---|---|
| s-bridge | `work/storage-restore-memory/candidate` `master` | `0d7e6b8` (root) → **`f98786e90e83c66da6f593315faea83e717caeed`** | `b442ef6c` |
| e-sia-cache | `rpc-sia-cache/repo` `work/sia-witness-cache` | `9fdc1418c` → **`b71c82615975ba6d1d7c966d1baddf57f5c53eea`** | `93b256fe` |
| e-receipt-witness | `rpc-receipt-witness` | root → **`b84c5a1127edfedf3d6ba8fb1553e17aa50ee846`** | `f5c195f5` |
| p-history-enclave | `witness-failover/repo` `witness-failover` | `bfbd649d` → `cf5cc363b` → **`ce7c1b7309dbc1cb65bedbdf7db5a173c977208c`** | `9dc123dd` |
| p-history-helios | `witness-failover/helios` `enclave-witness-check` | `1ec2c1a5` → **`aca81764f1d41a34829a3b408cea11c5c186e9e9`** | `082c719e` |
| a-verifier-authority | `rpc-priority/repo` `rpc-priority` | `9fdc1418c` → **`921d60c2b37ec8ae64e1fd22d7bc7b408939bd70`** | `c5be3e08` |

Each side folder has:
- `patches/`, made with `git format-patch --full-index --no-renames`;
- `files/`, which holds every changed file at its head blob.

`INVENTORY.json` lists each file's path, mode, blob and sha256.

**The one binary.** `e-receipt-witness/files/probe/fixture-1.json.gz.hex` is the lowercase hex of blob `43bad437`.
- It is excluded from that side's patch.
- To restore it, run `xxd -r -p fixture-1.json.gz.hex > probe/fixture-1.json.gz` and add it before committing.

## Bases (all from material already pushed in this checkpoint, under `closeout-followup/files/`)

- **9fdc1418c:** public `dfe020abf` plus the 4 `rpc-base-evm-export/enclave-rpc-priority-9fdc1418c/patches/` (tree
  `5c84c3da`).
- **bfbd649d:** that, plus the 2 `source-preservation/frozen-0318-export/witness-enclave-bfbd649d/patches/` (tree
  `eec36450`).
- **1ec2c1a5:**
  1. Start from upstream a16z/helios `2af9b418`.
  2. Apply the 4 `rpc-base-evm-export/helios-enclave-base-evm-eeffcc9/patches/`.
  3. Add the snappy object from its stored hex (see `rpc-base-evm-export/INVENTORY.json`).
  4. Apply `source-preservation/frozen-0318-export/witness-helios-1ec2c1a5/patches/0001-…` (tree `88bc44a0`).
- **0d7e6b8:** the 12 files under `sia-whole-restore-harness/`, at the modes listed in `INVENTORY.json` `baseTreeFiles`
  (tree `97b973b8`). They are the frozen harness, unchanged.
- **b84c5a11:** a root commit; start from an empty tree.

`verify-frozen-0331-export.py` rebuilds every base and every commit offline, in throwaway bare repos. It reads prior
material with `git show 552fb9f5:…`, never from worker trees. `REPRODUCE-CHECK.txt` records the result: every base
and every commit tree was reproduced exactly.

## Status labels

- **s-bridge f98786e9:**
  - **Test evidence:** offline bridge 17/17 and harness 18/18. The 420 s loopback load fixture moved
    211,648,774,144 B with 0 mismatches, at a peak of 232,480,768 B.
  - **A load fixture is never a restore pass.** The old OOM remains the latest terminal full restore. A new attempt
    was prepared but had not started at 03:31Z.
- **e-sia-cache b71c8261:** an optional S3 cache, NOT live Sia. The first-writer poisoning availability gap is still
  open.
- **e-receipt-witness b84c5a11:** diagnostic only, NOT policy authority.
- **p-history ce7c1b73/aca81764:** recovers roots by authenticated ancestry over 52 real headers.
  - The combined proof-call test uses a SYNTHETIC block identity.
  - Fresh witness availability is not solved.
- **a-verifier-authority 921d60c2:**
  - **Known gap:** a whole-operation deadline gap was identified, and B's fix is in progress.
  - **Not included:** A's later Reth positive E2E (`0c43e4db8`) is NOT part of this commit and is not captured.
