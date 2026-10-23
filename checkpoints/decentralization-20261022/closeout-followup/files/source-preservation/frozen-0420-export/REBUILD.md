# frozen-0420-export: how to rebuild the exact commits

Source plus offline tests only. Nothing is merged into the normal tree, imaged or deployed. Root owns activation.

| Side | Repo / branch | Base → head | Head tree |
|---|---|---|---|
| a-policy-callers | `rpc-priority/repo` `rpc-priority` | `0c43e4db` → `437d6ced6` → **`2efc4a83ec6636f875fa4523d50674bda06bcdcb`** | see INVENTORY.json |
| d-root-adopt-stop | `linux-adopt-stop-review` `fix/adopt-pending-stop` (ROOT) | `f1d0666b` → **`1086cf2346b913177e38cf02e0b2b571628cc758`** | see INVENTORY.json |

Each side has `patches/` (made with `git format-patch --full-index --no-renames`) and `files/` (every changed file at its
head blob). No binaries.

## Bases (pushed material only, under `closeout-followup/files/`)

- **0c43e4db:** public `dfe020abf` + the 4 `rpc-base-evm-export` enclave patches + the frozen-0331 A patch (that is
  921d60c2) + `source-preservation/frozen-0410-export/a-reth-e2e-0c43e4db/patches/0001-…`.
- **f1d0666b:** checkpoint commit `2bbea898` + `rpc-native-codec-export/d-linux-wallet-unknown-09ff3ed5` + the frozen-0318
  `d-linux-wallet-review-b744ba19` + `source-preservation/frozen-0410-export/d-linux-hold-final-f1d0666b/patches/0001-…`.

`verify-frozen-0420-export.py` rebuilds both bases and every commit tree offline, in throwaway bare repos, and writes
`REPRODUCE-CHECK.txt`.

## Status

**1086cf23 is ROOT's fix of a real `adopt()` await race in D f1d0666b.** It is required before D can be called
rollout-ready, and it is source only, not activated. Root's probe ran the actual function with scripted edges, not a
physical VM.
