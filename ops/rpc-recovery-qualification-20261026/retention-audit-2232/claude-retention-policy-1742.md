# Base own-node retention vs the signed lease-history floor 52,515,705 (1742). Source audit; no stage created

**Verdict:**
- **My 1739 statement was stale and wrong for Base.** The "receipts/bodies distance ≥ 140,000" assert I cited is in an **old** wrapper (`node-payload-v4/chain_service.py`, `6d93c8b7…`, 2026-10-25 04:55).
- **The deployed wrapper keeps Base receipts, bodies and transaction lookup from an absolute block.** It does not keep a distance.
- **The planned block (48,000,000) is below the floor** (52,515,705).
- **No safety defect was found.** One **availability-hardening gap** remains (§4); it is not implemented (reasons in §4).
- **Pruning configuration is not actual coverage.** The Base DB is currently **deleted**, so actual coverage today is **none**.

**Not done by me:** tests, builds, live actions, originals or guest reads.

## 1. Exact provenance (not picked by filename)
| record | path | sha256 | status |
|---|---|---|---|
| **Deployed wrapper** (root's guest capture) | `outputs/rpc-production-final-20261025/m7-m10-release-completed-0055/current-chain_service.py` | `75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92` | byte-identical to `ops/rpc-backend-bootstrap/2026-10-25/chain_service.py` (source `df15955ce`), `l1-proof-window-stage/patched/chain_service.py`, and `base-wrapper-integration-stage/base/chain_service.py` (that stage's README) |
| Later candidates (NOT deployed) | `base-wrapper-integration-stage/src/chain_service.py` (release mode); `base-retention-stage/v2/chain_service.py` `713b0ddf…` | | same retention code family; unqualified for deployment here |
| Old wrappers (superseded) | `chain_service.py` `6d93c8b7…` (= `node-payload-v4`), `node-payload` `cc3a1061…`, `node-payload-v3` `55e19ca0…` | | no `RETENTION_SEGMENTS`: the source of my 1739 error |
| **Retention policy used live** (root 1394, `/opt/enclave-rpc/retention-stage/activation-r2-409b8ed2`) | `base-retention-stage/activation-r2/retention_guard.py:38` | stage SUMS `409b8ed25a2f5096…` | `HISTORY_FROM, STATE_FROM = 48_000_000, 52_500_000`; manifest pin `1f0c4e6c…` |
| Selection and completion verifier (prepared) | `base-retention-stage/selection-r4/` | SUMS `7bb30de2…` | `EXPECTED_SELECTION` transactions/receipts chunks 96..106, changesets 105..106 (500,000 blocks per file) |
| `reth.toml` | the guest Base datadir (written by the snapshot, then rewritten by the client) | — | **I did not read it** (guest/root only). Root reported a `retention-backup` holding only `reth.toml` + its hash (HANDOFF 15:58). **The DB is deleted.** |
| Deployed `chain.json` `baseRetention` | guest `/opt/enclave-rpc/chain.json` | — | **No local record of its values was found.** Activation evidence item E1. |

## 2. What the deployed wrapper enforces (`75c879ec`, read in full for these lines)
**Base side (`run('base')`):**
- **Required config:** `history_from_block(CONFIG)` (`:367-372`) **requires** `chain.json baseRetention.historyFromBlock` (> 0). `state_history_from_block` requires `stateHistoryFromBlock`.
- **Snapshot bound:** both must be ≤ the verified snapshot block (`:497-501`).

**`prune_args` (`:408-445`):**
- **The CLI replaces the whole persisted `[prune]` section,** so every segment is passed explicitly (`:411-414`).
- **For `receipts` and `bodies_history`** (`RETENTION_SEGMENTS`, `:357`) and **`transaction_lookup`**, `_before_args` (`:397-406`) emits `--prune.<seg>.before H`:
  - an existing `before` is kept only if ≤ H;
  - a downloader `distance` is accepted **only** when 140,000 ≤ d ≤ 500,000 (`DISTANCE_UPGRADE_MAX`), and is **replaced** by `before H`;
  - anything else refuses.
- **The 140,000 minimum applies only** to L1 and to segments outside retention.

**File check (`:393-395`, `:382-391`):** `history_files_present` requires the static file holding H to exist for **receipts and transactions** (`static_file_{stem}_{start}_{end}`).

**The reason for this design** (wrapper comment `:350-356`, from the base-retention-stage review of pinned reth `7134be3`; **the citations are not re-read by me**):
- `eth_getLogs` needs receipts **and** transactions;
- it silently skips blocks whose receipts are absent (`rpc/rpc/src/eth/filter.rs:1282-1284`);
- distance pruning deletes whole static files (`prune/src/segments/mod.rs:32-71`);
- bodies may lag receipts (`segments/user/bodies.rs:112-125`).

## 3. Answers
1. **Is the minimum-distance assert unsafe for the signed floor?** **No.** On the Base side it is not used for receipts, bodies or lookup. The node keeps `[H, tip]` with an **absolute** `before`. With the planned H = 48,000,000 ≤ 52,515,705, the receipts and raw transactions needed by the backward-history scan (floor..N) are **in policy**.
2. **Across future heads:** `before H` does not move with the head, so the floor stays retained forever. The **retained range grows** by about 43,200 blocks/day (`selection-r4` `BLOCKS_PER_DAY`). Storage growth belongs to worker 50's NVMe audit and is not duplicated here.
3. **Even if retention is misconfigured, safety holds.** The reader's backward scan verifies every receipt list against the authenticated `receiptsRoot` and binds transactions by `transactionsRoot`. A pruned or missing block **fails closed** (old claims stay unservable). There is no wrong fact and no RPC trust fallback. Misconfiguration costs availability, not safety.
4. **Pruning is irreversible.** Data pruned under a shorter profile, or deleted (as the current DB is), **cannot be restored by any config change.** It must be re-downloaded through the pinned archive selection (`1f0c4e6c`; tx/receipts chunks 96..106, changesets 105..106) and the retention flow, or re-synced.
5. **Config is not coverage.** `before H` only stops future deletion. The file check proves that the **file holding H exists**, not that every file from H to the tip exists or is intact. `verify_retention_completion.py` is size presence only (its own label: "NOT readiness"). **The only proof of usable coverage is the reader's authenticated backward scan reaching `complete` down to 52,515,705.**

## 4. The gap and the proposed small patch (NOT prepared)
**The gap:**
- Nothing ties the wrapper's `baseRetention.historyFromBlock` (root-written `chain.json`) to the **signed** reader history floor 52,515,705 (the reader template's `history` section in the KVM image).
- A future H > 52,515,705 would pass every wrapper gate. It would irreversibly prune the floor-era receipts and transactions on first start.
- The reader still fails closed, but old-claim availability would be lost until a re-download.

**Proposed diff for root to place on whichever wrapper root names as the activation base** (`75c879ec` as deployed, or the release candidate):
```python
REQUIRED_LEASE_HISTORY_FLOOR = 52_515_705   # = signed reader template history.floor (ledger16d deployment); change only with that signature
# in history_from_block(), after the existing assert:
    assert r['historyFromBlock'] <= REQUIRED_LEASE_HISTORY_FLOOR, \
        'Base retention start is above the signed lease-history floor: refusing to prune required history'
```
**Tests:**
- H = 52,515,706 refuses before any `--prune` argv is built;
- H = 52,515,705 and H = 48,000,000 pass;
- a downloader distance profile is still upgraded to `before H` ≤ the floor;
- a `before` > the floor refuses.

**Admin rights:** unchanged. There is no RPC fallback and no live pruning change.

**Why I did not prepare it:**
- **The base is ambiguous:** three live-or-planned wrapper lineages carry this function, and preparing a patch on the wrong one would be wasted.
- **The turn budget** was spent establishing provenance.
- **It is not a safety fix**, and the planned H already satisfies it.

## 5. Activation evidence required (root, read-only, before any Base start)
- **E1:** the exact guest `chain.json` (sha256) with `baseRetention.historyFromBlock` ≤ 52,515,705 (planned 48,000,000) and `stateHistoryFromBlock` (planned 52,500,000).
- **E2:** retention completion `jobComplete` (all four of terminal, marker, history, state) for the **re-downloaded** DB, under the pinned manifest `1f0c4e6c`. Size presence only.
- **E3:** the persisted `reth.toml` after first start shows `receipts`, `bodies_history` and `transaction_lookup` = `{before = H}` (the client rewrites `[prune]` from the CLI). Static-file listing for receipts and transactions contiguous from the file holding 48,000,000 to the tip.
- **E4, the actual proof:** the reader backward-history scan `complete` from the start-time ASR anchor down to 52,515,705 against the own node, with no `history_unavailable`. Without E4, no old-claim coverage is claimed.

**Currently unavailable:** the Base DB was deleted, and the re-download and retention are paused (USB writes, download and VM boot are paused). E1–E4 cannot exist yet.
