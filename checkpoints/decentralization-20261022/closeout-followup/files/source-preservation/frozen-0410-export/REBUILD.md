# frozen-0410-export: how to rebuild the exact commits

Everything here is source plus offline tests only. Nothing is merged into the normal tree, imaged or deployed, and root
owns activation.

| Side | Repo / branch | Base → head | Head tree |
|---|---|---|---|
| a-reth-e2e | `rpc-priority/repo` `rpc-priority` | `921d60c2` → **`0c43e4db89f1be615ff11319abc43aefd69a9fcb`** | `63f1746a` |
| b-verifier-deadline | `rpc-verifier-deadline/repo` `verifier-deadline` | `921d60c2` → `62feb3aaf` → **`8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346`** | `740120a4` |
| c-host-services-cold | `windows-host-services-compose/candidate` `compose/host-services` | `d7f520bf` → **`427780bbc0fc524f8091893614eae8a653518139`** | `820ae4be` |
| d-linux-hold-final | `linux-wallet-unknown/candidate` `fix/linux-wallet-unknown-hold` | `b744ba19` → **`f1d0666b9fc80d25a7c4cbacf4025f3a33152111`** | `2db82e4f` |
| e-sia-cache-compose | `rpc-sia-cache/compose/repo` `work/sia-cache-compose` | `bfbd649d` → `73c11ec93` → **`2778527853fdf2a42675eb8e613646727b7df509`** | `e9c0a82b` |
| p-real-history | `witness-failover/repo` `witness-failover` | `ce7c1b73` → **`7b4dd69201d00bc5649cda6bcf57b21c6197c3af`** | `ccb7f0ac` |

Each side folder has:
- `patches/`, made with `git format-patch --full-index --no-renames`;
- `files/`, which holds every changed file at its head blob.

`INVENTORY.json` lists each file's path, mode, blob and sha256. No series contains a binary file.

## Bases (all from material already pushed in this checkpoint, under `closeout-followup/files/`)

- **921d60c2** (a, b): public `dfe020abf` + the 4 `rpc-base-evm-export/enclave-rpc-priority-9fdc1418c/patches/` (that is
  9fdc1418c) + `source-preservation/frozen-0331-export/a-verifier-authority-921d60c2/patches/0001-…`.
- **d7f520bf** (c): checkpoint commit `f58e03ec4` + the 7 `rpc-native-codec-export/c-host-services-compose-d7f520bf/patches/`.
- **b744ba19** (d): checkpoint commit `2bbea898` + `rpc-native-codec-export/d-linux-wallet-unknown-09ff3ed5/patches/0001-…`
  + `source-preservation/frozen-0318-export/d-linux-wallet-review-b744ba19/patches/0001-…`.
- **bfbd649d** (e): 9fdc1418c (as above) + the 2 `source-preservation/frozen-0318-export/witness-enclave-bfbd649d/patches/`.
- **ce7c1b73** (p): bfbd649d + the 2 `source-preservation/frozen-0331-export/p-history-enclave-ce7c1b73/patches/`.

`verify-frozen-0410-export.py` rebuilds every base and every commit offline, in throwaway bare repos. It reads prior
material only with `git show f6668d86:…` and writes `REPRODUCE-CHECK.txt`.

## Status (what these commits are NOT)

- **c 427780bb is NOT rollout-ready:** a known late-start/close race (root's mock-runtime stop-race probe) and a policy gate
  that trusts DigitalOcean mirrors only.
- **d f1d0666b** needs a measured image and a host-admission bundle with `decision()`; it is not deployed.
- **e** is not live Sia.
- **p 7b4dd692's** authorized real-proof recording obtained NO real proof (2 sources failed: 2 pass, 1 skip).
- **a** is a test addition, and **b** is a fix not yet merged into A.
