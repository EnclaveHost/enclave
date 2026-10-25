# L1 caught up, non-optimistic; historical blob samples re-checked (2026-10-25, 19:29-19:34 UTC)

**Scope:** L1 (reth + Lighthouse) state only.
- This is **not** full RPC readiness and **not** Base origin coverage.
- It is **not** cryptographic authority against the host.
- Base is disabled, `coverageVerified` is false, and no consumer changed.

## 1. Initial read, 19:29:18 UTC: `initial-1929.json`

Taken by root over loopback against our own paired clients.

**Execution (reth)**

| Field | Value |
| --- | --- |
| `eth_syncing` | `false` |
| latest | 26,271,788 (`0x190e02c`, ts 19:29:11) |
| safe | 26,271,752 (`0x190e008`) |
| finalized | 26,271,720 (`0x190dfe8`, ts 19:15:35) |

**Consensus (Lighthouse)**

| Field | Value |
| --- | --- |
| `is_syncing` | `false` |
| `is_optimistic` | **`false`** |
| `el_offline` | `false` |
| head slot | 15,511,044 |
| `sync_distance` | 0 |

This replaces the 18:06/18:07 state, when the CL followed the head but was execution-optimistic (`../sync-1807/`). That
state is historical.

## 2. Historical blob diagnostic, repeated at 19:32:53 UTC: `blob-1934.{json,out,guard,rc}`

**Probe:** the exact same probe, unchanged: `../sync-1807/probe-precheckpoint-blobs.py`, sha256
`a39d5f3332c39ecdc3b6d336de2302f134d44db8ab502daf3481b103c7485c40`. It is not copied here.
- It uses the pinned coverage `kzgcheck` binary `00b3eeb9…` from the tested coverage helper.
- It made 7 bounded read-only loopback requests.
- It ran under the shared queue with a 256 MiB cap. It exited rc 0 with a peak of 39 MiB, and host available memory stayed
  at least 19,888 MiB.

**Results:**

| Slot (sampled from) | Blobs | KZG commitments recomputed and matching | `blockFinalized` | `executionOptimistic` |
| --- | --- | --- | --- | --- |
| 15505056 (15505056) | 6 | all | true | **false** |
| 15506081 (15506080) | 3 | all | true | **false** |
| 15508000 (15508000) | 10 | all | true | **false** |

- These are the same 19 blobs at the same slots as at 18:07, all before checkpoint slot 15508320. The versioned hashes are
  in `blob-1934.json`.
- At 18:07 every sample was still `executionOptimistic: true`. Now all are finalized and non-optimistic.
- `blob-1934.out` is the queue/guard-wrapped run. Its JSON body is byte-identical to `blob-1934.json`.

**What this does NOT show:**
- It is three sampled slots of availability, as the file itself says (`kind: availability-diagnostic-only`,
  `coverageVerified: false`, `authenticatedCanonicalHistory: false`).
- It is **not** a check of the full Base derivation range. The extracted Base snapshot's safe-head L1 origin is still
  unknown because the Base download is still running.
- It is **not** a coverage receipt.
- It is **not** external cryptographic authority. These clients and this host are the only witnesses.

## 3. Readiness window sampler: `window-1934` (ongoing at publication; no result here)

Root started a bounded readiness sampler at about 19:32 (host exec 93712): 7 samples, 120 s apart, with a 600 s minimum
window, finishing at about 19:45.
- At publication time `window-1934.rc` did **not** exist and `window-1934.out` was empty.
- **No result is published here and none is implied. Root will publish it later.**
- The sampler is expected to report the whole stack as INCOMPLETE, because Base is disabled and there is no coverage
  receipt. The L1 gates must be read separately from whole-stack readiness.

## Files (`SHA256SUMS` covers this directory only)

| File | What |
| --- | --- |
| `initial-1929.json` | root's 19:29:18 L1 read (heads, sync and optimistic status) |
| `blob-1934.json` | probe output |
| `blob-1934.out` | the same run, with queue and memory-guard lines |
| `blob-1934.guard` | memory guard summary |
| `blob-1934.rc` | `0` |

These files hold no keys, JWTs, blob bodies or binaries.

## 3. Readiness sampler window, 19:32:52–19:44:52 UTC: `window-1934.{out,rc}` (added 2026-10-25)

**Run:** root's read-only `enclave-rpc-readiness-sample/v1` sampler, 7 samples over 720 s, against loopback L1 and Base. **rc 4. `overall: "INCOMPLETE"`, `acceptance: false`.**

| Gates | Result |
|---|---|
| **pass (7)** | `l1-consensus-nonoptimistic`, `l1-custody`, `l1-execution-synced`, `l1-finalized-paired`, `l1-head-advancing`, `l1-head-paired-fresh`, `sampling-complete` |
| **incomplete: `l1-identity`** | `rpc-error`: `el eth_getBlockByNumber` returned a JSON-RPC error. Root reports the cause as our **pruned genesis** history (error 4444); the file itself records only "JSON-RPC error". |
| **incomplete: all Base gates** | identity, execution-synced, heads-consistent, labels, unsafe/safe/finalized freshness and advancing. The Base client is **disabled** (endpoints unreachable). |
| **incomplete: `historical-coverage`** | no reviewed COVERED receipt |

This is **not** readiness. L1 liveness gates pass; L1 identity is incomplete; Base is not running.
