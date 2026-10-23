# frozen-0318-export: how to rebuild the exact commits

Source and offline tests only. Nothing here is merged into the normal tree, imaged or deployed. Root owns activation.

| Side | Repo / branch | Base → head | Head tree |
|---|---|---|---|
| witness-enclave | `witness-failover/repo` `witness-failover` | `9fdc1418c` → `ee45734df` → **`bfbd649d8c416922691a6dd1eaada8a81765bba5`** | `eec36450` |
| witness-helios | `witness-failover/helios` `enclave-witness-check` | `eeffcc980` → **`1ec2c1a52399b6a8d0fc1eb7658bf030987e132a`** | `88bc44a0` |
| d-review (**UNREADY**) | `linux-wallet-unknown/candidate` `fix/linux-wallet-unknown-hold` | `09ff3ed55` → **`b744ba19022763e9688c6b006e8cecd24e21cc18`** | `2a6ff7c7` |

Each side folder has `patches/` (`git format-patch --full-index --no-renames`) and `files/` (every changed file at its
head blob; `INVENTORY.json` lists path, mode, blob and sha256). All changed files are text.

## Bases come from earlier pushed exports in this checkpoint

All paths below are under `checkpoints/decentralization-20261022/closeout-followup/files/`.

- **9fdc1418c**: check out public `dfe020abf`, then `git am` the 4 patches in
  `rpc-base-evm-export/enclave-rpc-priority-9fdc1418c/patches/`. This gives tree `5c84c3da`.
- **eeffcc9**:
  1. Start from upstream a16z/helios `2af9b41887e069144ee56cd710f3ddca195473f8` (0.12.0).
  2. `git am` the 4 patches in `rpc-base-evm-export/helios-enclave-base-evm-eeffcc9/patches/`.
  3. Recreate `opstack/tests/data/ec197b9f….v4.snappy` with `xxd -r -p` from
     `rpc-peer-audit/head-listener/crates/enclave-base-head-listener/tests/fixtures/base-mainnet-52965074.v4.snappy.hex`
     (see `rpc-base-evm-export/INVENTORY.json` `snappyReconstruction`).

  This gives tree `2171ad2b`.
- **09ff3ed5**: check out pushed `2bbea898`, then `git am`
  `rpc-native-codec-export/d-linux-wallet-unknown-09ff3ed5/patches/0001-…`. This gives tree `5ca835a2`.

Then `git am` this export's patches for the side. Author and committer are SteveDeFacto
<5148995+SteveDeFacto@users.noreply.github.com>.

`verify-frozen-0318-export.py` does all of this offline, in throwaway bare repos. It reads the prior patches from commit
`7b477d57` with `git show`, never from a worker tree. Its output is `REPRODUCE-CHECK.txt`: every base and every commit
tree was reproduced exactly.

## Build notes (not run here)

- **witness-check:** build with `cargo build -p helios-opstack --bin witness-check` from the Helios side.
  - The worker's debug build was `42a8a841…`, built with Rust 1.96.0 at a 1536 MiB cap.
  - It is not stored, and no cargo cache or vendor download is stored either.
  - `Cargo.lock` is unchanged from eeffcc9.
- **Newer worker work is not captured:** the witness worker has since committed follow-up work past both heads
  (a root-history follow-up), and D is repairing b744ba19. Both belong to their workers.
- **The gateway's witness methods need the helper:** `proofs: {checker, roots}` (see `witness-failover/RESULT.md` §5).

## Status labels

- **witness failover:** proof-aware failover and a poisoning-resistant cache, with offline proof and availability tests.
  - It is NOT production and NOT RPC independence. With every fresh witness source down, only cached block-pinned
    history remains.
  - Roots exist only for heads the gateway saw, and the EIP-2935 history path is refused.
- **d-review b744ba19 is an UNREADY candidate.** Root's ROOT-LINUX-DECISION-WINDOW-REVIEW (02:51Z) found that `tryClaim`
  takes the wallet decision and awaits `openForUs`, and only then builds `walletSendGate(null, wallet.validUntil, id)`.
  - In b744ba19 these are `supervisor.js` lines 12038, 12053 and 12062.
  - A withdrawal during that await is therefore absorbed into the new gate.
  - The other teardown paths still free the slice on an unconfirmed stop.
  - Worker D is repairing. There is no image or deployment.
