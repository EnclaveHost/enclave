# RPC production readiness sampler — result after root review

**Status: the root-reproduced false READY is fixed and tested (74/74 synthetic tests; root's unchanged probe now returns FAIL, rc 3).** It still has NOT been run against live clients (they are not synced), so it is not proof of production readiness and does not authorize activation.

Until root attaches an independently reviewed `COVERED` coverage receipt, its best output is `INCOMPLETE` (`historical-coverage: coverage-receipt-absent`). `activationAuthorized` and `coverageVerifiedWritten` are always false.

This report replaces the pre-review report at `wo/logs/claude-readiness-result.md`. That file is kept, marked superseded, because it was written to an ambiguous bare `logs/` path. Its "59/59, READY on a valid receipt" claims predate the defect below and must not be relied on.

Constraints observed:
- No SSH, no live access, no keys or private configs read.
- No service changes, no commits, no pushes.
- Changes only under `readiness-stage/`, this report, and the superseded-pointer header on the old report.

## 0. Root review (blocking, 14:33 UTC) and the fix

**What root reproduced.** Root's review file says 14:35; root corrected that to 14:33 UTC.
- `readiness-root-probe.py` rewrote only the Base EL `eth_getBlockByNumber('safe'|'finalized')` hash to `0xabab…`. The numbered canonical blocks and the rollup status were left unchanged.
- The old sampler returned rc 0 READY with `base-el-labels: pass`.
- Cause: the old `base_el_labels` checked only that each tag was non-null and not numerically behind the rollup ref. It never compared the tag's block identity with anything.

**What the sampler does now.** For both `safe` and `finalized` (`readiness_sampler.py` `base_el_labels`):
1. A null tag is incomplete (`base-el-label-absent`).
2. The tag block must equal the canonical block at its own height: `eth_getBlockByNumber(hex(number))`, compared on number, hash, parentHash and timestamp. Any difference is a FAIL (`base-el-label-noncanonical`).
3. If the tag is at the same height as the validated rollup ref, its hash, parentHash and timestamp must equal that ref. Otherwise FAIL (`base-el-label-mismatch`).
4. A tag ahead of the ref is allowed only after check 2 passes, and only up to `LABEL_AHEAD_MAX = 150` Base blocks (5 min). This covers labels advancing between the two reads. Further ahead is a FAIL (`base-el-label-ahead-incoherent`).
5. A tag behind the ref is incomplete (`base-el-label-behind`): fail-closed, never READY.
6. The required ordering is EL finalized ≤ EL safe ≤ a fresh EL `latest`. Otherwise FAIL (`base-el-label-order`).

The rollup refs used in check 3 are the ones `base_heads` already validated against the numbered Base EL blocks and the blocks' own L1-info deposits. The verified ref now also carries `parentHash`.

**JSON-RPC envelope** (`Sampler.rpc`):
- The reply must be an object with `jsonrpc == "2.0"`, `id == 1` (not a boolean), and not both `result` and `error`.
- `error` → incomplete (`rpc-error`).
- A missing `result` or a bad envelope → incomplete (`malformed-response`).

**Found while testing the fix.** The first targeted run raised `KeyError: 'parentHash'` (6 errors in `logs/reviewfix-targeted.out`, kept), because the verified ref lacked `parentHash`. It was fixed before the full run.

An unexpected internal exception aborts the run without writing a report: exit 1, never READY. Unexpected exceptions are deliberately not converted into gate results.

## 1. Files and exact hashes

All under `work/rpc-production-final-20261025/readiness-stage/`.

| File | sha256 |
|---|---|
| `readiness_sampler.py` (857 lines, stdlib only) | `b15b77afa653ee70439596d1a6aa6b8b4add0371e0a6d01eb506e276c114cec8` |
| `test_readiness_sampler.py` (908 lines) | `3ebca288455ef00d2b042f3e235af048165ec371296e89a26a959d80d80b6404` |
| `jobs/test.sh` (now takes optional unittest selectors) | `940757885c74c8a24f29efb5c62311f2d4b279fd9fcf4d99b04395062513cd24` |
| `jobs/root-probe.sh` (runs root's probe unchanged) | `cb1e2b6adcd0e70db0907215d2d3b865097db5b0a6b2055fffcfed3db91244ea` |
| `README.md` (docs only; link is now `../logs/claude-readiness-result.md`) | `2c42091ab43aed1af5760f96f3ce549bdf064eed855523227a7ab7f002374f7f` |
| `../readiness-root-probe.py` (root's, unmodified) | `824239ea0567537760530d479d5a8c67c09cc8c489b6753cdadf7e2e5b100feb` |
| `../coverage-stage/origin_extract.py` (decoder parity reference, unchanged) | `6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c` |

The sampler and test hashes are the ones printed inside the final full run, `logs/reviewfix-full.out`. Only README changed after that run.

**Superseded hashes.** The pre-review sampler `c6c442a5…cd75` is the false-positive version: do not deploy it. The pre-review tests were `fc4292e3…cb`.

## 2. Test evidence (synthetic only)

Every run used the shared queue at 256 MiB with the 16 GiB floor, inside `unshare -rn` (loopback only).

| Run | Result |
|---|---|
| `logs/test1.*` (pre-review) | 58 tests, 1 fixture failure (fixture fixed) |
| `logs/test2.*` (pre-review) | 59/59, but missed the label defect |
| `logs/reviewfix-root-probe.*` | root probe on the first fixed draft: rc 3 FAIL, `base-el-label-noncanonical` |
| `logs/reviewfix-targeted.*` | 18 targeted tests: 6 errors (`KeyError parentHash`) |
| `logs/reviewfix-targeted2.*` | 18 targeted tests (`TestElLabels`, `TestJsonRpcEnvelope`, `TestHealthy`): OK |
| `logs/reviewfix-full.*` | **74/74 OK in 105.8 s**; guard `exit=0 peakTreeRssMiB=47 minHostAvailableMiB=21011` |
| `logs/reviewfix-root-probe2.*` | root probe on the final source: `{"rc": 3, "overall": "FAIL", "baseElLabels": {"code": "base-el-label-noncanonical", ...}}`; guard exit 0, peak 37 MiB |

Commands:

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo
L=work/rpc-production-final-20261025/readiness-stage/logs
python3 work/claude-test-queue.py --mib 256 --log $L/reviewfix-full.guard -- \
  unshare -rn bash work/rpc-production-final-20261025/readiness-stage/jobs/test.sh
python3 work/claude-test-queue.py --mib 256 --log $L/reviewfix-root-probe2.guard -- \
  unshare -rn bash work/rpc-production-final-20261025/readiness-stage/jobs/root-probe.sh
```

**New tests (15).**

`TestElLabels` (11):
- Root-probe shape: both tag hashes contradict → FAIL `noncanonical`.
- Safe tag hash only → FAIL `noncanonical`.
- Finalized tag hash only → FAIL `noncanonical`.
- Finalized tag parentHash → FAIL `noncanonical`.
- Safe tag timestamp → FAIL `noncanonical`.
- Ahead tag with a wrong hash → FAIL `noncanonical`.
- Ahead canonical race (+1 block) → READY (rc 0).
- Ahead beyond the bound → FAIL `ahead-incoherent`.
- Finalized tag ahead of the safe tag → FAIL `order`.
- Behind tag → INCOMPLETE `behind`.
- Unit test of the same-height defence: a canonical tag differing from the validated rollup ref → `base-el-label-mismatch`. End-to-end this case cannot be reached, because `base_heads` rejects such a ref first.

`TestJsonRpcEnvelope` (4): each of these → INCOMPLETE `malformed-response`:
- missing `jsonrpc`
- wrong `id`
- both `result` and `error`
- missing `result`

The original 59 tests all still pass. They cover the healthy, L1, Base, unavailable, bounds, coverage and decoder-parity scenarios listed in the superseded report and in `TestHealthy`, `TestL1Negative`, `TestBaseNegative`, `TestUnavailable`, `TestBounds`, `TestCoverage` and `TestDecoderParity`.

**Actual evidence: none.** No live client, real Base snapshot or real mainnet response has been sampled.

## 3. Pinned-source API citations

**Base v1.5.1**, at `work/resume-after-checkpoint-20261022/witness-failover/vendor-inspect/base-v1.5.1/`:

- **`optimism_syncStatus`**
  - Defined at `crates/consensus/rpc/src/jsonrpsee.rs:98-113` (namespace `optimism`, method `syncStatus`) and also `crates/consensus/rpc/src/sync.rs:5-9`.
  - It is served by the embedded consensus RPC of `base rpc`: `bin/base/src/commands/rpc.rs` flattens `EmbeddedConsensusNodeConfigArgs`.
  - Its port is `--rpc.port` (`crates/consensus/cli/src/rpc.rs:78`), which `chain_service.py` sets to `127.0.0.1:19545`.
  - It is enabled unless `--rpc.disabled` is set (`rpc.rs:69`, `:150`).
- **`SyncStatus` fields:** `crates/consensus/protocol/src/sync.rs:14-57` (snake_case).
- **Ref shapes**
  - `BlockInfo` (`crates/consensus/protocol/src/block.rs:27-37`, camelCase): `hash`, `number` (JSON u64), `parentHash`, `timestamp`.
  - `L2BlockInfo` (`block.rs:107-117`) adds `l1origin` (alias `l1Origin`) and `sequenceNumber`.
- **Zeroed when not derived:** `crates/consensus/rpc/src/rollup.rs:70-87` (`unwrap_or_default`). The sampler treats zero as "not derived" (FAIL), never as a head.
- **`optimism_rollupConfig`**
  - `RollupConfig` at `crates/common/genesis/src/rollup.rs:18-71`; `ChainGenesis` at `genesis.rs:11-20`.
  - Mainnet values at `crates/common/chains/src/config.rs:455-497`.
- **Deposit transaction JSON**
  - `BaseTxEnvelope::Deposit` is `#[envelope(ty = 126)]` with `serde_deposit_tx_rpc` (`crates/common/consensus/src/transaction/envelope.rs:43-46`).
  - `TxDeposit` is camelCase with `input` (`deposit.rs:27-59`).
  - The L1-info layouts match `coverage/origin_extract.py`.

**Lighthouse v8.3.2**, at `work/rpc-hdd-storage-compose-20261023/p/evidence/sources/lighthouse-v8.3.2/beacon_node/http_api/src/`:
- GET `beacon/blinded_blocks/{block_id}` is at `lib.rs:1323-1368`.
- The `finalized` block_id is the finalized checkpoint root with `Finalized = true` (`block_id.rs:60-66`).
- `node/syncing` provides `is_syncing`, `is_optimistic` and `el_offline` (`lib.rs:~2385-2404`).

## 4. Gates

**Overall.** Any fail → `FAIL` (exit 3). Otherwise any incomplete → `INCOMPLETE` (exit 4). Otherwise `READY` (exit 0). Usage or bounds errors exit 2.

**Ethereum (L1) gates:**
- `l1-identity`: chainId, genesis hash, CL genesis root and time, spec, and the `Lighthouse/v8.3.2` version prefix.
- `l1-execution-synced`, `l1-consensus-nonoptimistic`.
- `l1-head-paired-fresh`: the beacon head payload equals the EL block by number (hash, parent, timestamp), and the head is fresh.
- `l1-finalized-paired`: the beacon finalized payload equals the EL block and the EL `finalized` tag (one race re-read). Finality must be fresh, must not regress and must not be rewritten.
- `l1-custody`: at least 64 custody groups.
- `l1-head-advancing`.

**Base gates:**
- `base-identity`.
- `base-execution-synced`.
- `base-heads-consistent`:
  - Unsafe, safe and finalized are nonzero and ordered.
  - Each equals the Base EL numbered block.
  - Each block's own L1-info deposit equals the reported l1origin and sequenceNumber.
  - The origins and `finalized_l1` are canonical on our L1 and within our L1 finality.
  - Base finality is never regressed or rewritten.
  - A safe reorg is incomplete.
- `base-el-labels`: §0.
- `base-unsafe-fresh`, `base-safe-fresh`, `base-finalized-fresh`.
- `base-safe-advancing`, `base-finalized-advancing`: strict increase on verified samples over at least `--min-window` (default 600 s).

**Coverage and sampling:** `historical-coverage` (§5) and `sampling-complete`.

An unsafe `latest` alone can never pass.

## 5. Coverage receipt binding rules, and their trust limits

The sampler never re-runs coverage. It needs the receipt, the verdict and the origin, plus root-pinned `--expect-snapshot-manifest-sha256` and `--expect-chain-config-sha256`. The kzgcheck pin (`00b3eeb9…10eb`) and the base binary pin (`9c44836d…e53f`) are defaults. If any input is absent, the gate is incomplete. A boolean is never evidence.

Receipt `enclave-base-coverage-acceptance/v1`:

```json
{"format":"enclave-base-coverage-acceptance/v1","decision":"accepted",
 "verdictSha256":"<sha256 of verdict bytes>","originSha256":"<sha256 of origin bytes>",
 "snapshotManifestSha256":"<root pin>","chainConfigSha256":"<root pin>",
 "kzgcheckSha256":"00b3eeb9…","baseBinarySha256":"9c44836d…",
 "baseBootstrap":{"l1Block":<needFromBlock>,"blobSlot":<proposed blobSlot>},
 "review":{"reviewer":"…","gateRunner":"…","reviewedAt":"ISO-8601"}}
```

FAIL on mismatch:
1. The format matches and `decision` is `accepted`.
2. The reviewer, gateRunner and reviewedAt strings are present and distinct.
3. The SHA-256 of the verdict and origin bytes equals the receipt.
4. The pins equal the expected values.
5. The origin is `SAFE_HEAD_PERSISTED`, extracted read-only by the pinned base binary.
6. The verdict is `COVERED` under `safe-origin-minus-seq-window` and eligible, with no refusal and `coverageVerifiedWritten:false`. missingData and mismatches are 0, blobsVerified ≥ 1, and blocks equals the full range.
7. `needFromBlock == safe.l1Origin − 3600 == proposed.l1Block == receipt.l1Block`, blobSlot is equal across documents, and the batcher is equal.
8. Live, at sample 0: the running Base EL has the snapshot safe block with the same hash, and its L1 origin is canonical on our L1. If either is unavailable, the gate is incomplete.

**Unsigned reviewer assumption.** `review.reviewer`, `review.gateRunner` and `review.reviewedAt` are an UNSIGNED operator record. They are not authenticated proof of an independent reviewer.
- The sampler checks only that the strings exist and differ.
- Anyone able to write the receipt file can write any names.
- Root's process must keep that guarantee: who wrote the receipt, file permissions and custody.
- Adding a signature or attestation would need a separate key-management design. That is out of scope and would touch keys.

**Configuration and evidence identity limits.**
- **What the sampler can and cannot know.** It never reads `chain.json`, the snapshot manifest, kzgcheck or the base binary. It compares the receipt's hashes with pins root passes on the command line. It cannot know that those pins are the bytes actually installed or used on the VM; root must derive them from the deployed files.
- **The verdict does not bind its inputs.** `coverage_gate.py`'s verdict records neither the origin hash nor the kzgcheck hash. The verdict↔origin link rests on range arithmetic plus the reviewer's (unsigned) receipt.
- **`chainConfigSha256` has a circularity.** Setting `coverageVerified` changes `chain.json`. Root must define which config bytes the pin names, for example the pre-activation config. The sampler cannot tell which one was meant.
- **The snapshot identity is only partly cross-checked.** The receipt's `snapshotManifestSha256` is compared with the pin, and the snapshot is tied to the running chain only through the safe-block live check (item 8).

## 6. Bounds and residual behaviours

Built-in bounds:
- **Endpoints.** The host is fixed at `127.0.0.1` and only ports are configurable. There is no URL option, no proxy, and redirects are refused.
- **Envelope.**
  - Samples 2–32. Interval 0.05–600 s, with (samples−1)×interval ≤ 3600 s.
  - min-window ≤ 3600 s. Timeout ≤ 15 s.
  - Body 64 KiB–16 MiB (default 4 MiB). Requests ≤ 2000.
  - max-duration ≤ 3900 s.
- **Output.** Details are capped at 200 characters. Output is ≤ 1 MiB and evidence files are ≤ 16 MiB. `--out` is never overwritten.
- **Secrets.** It reads no keys or configs.

Residual behaviours, reported rather than hidden:
1. **Slow-drip and deadline overruns.** A slow-drip body is cut at about 2× timeout. One in-flight request can overrun the deadline by about 2× timeout.
2. **Ambiguous evidence is incomplete, not fail.** This covers JSON-RPC errors, a lagging Base EL label, a Base safe reorg, an absent tag, and a malformed envelope. Treat persistent INCOMPLETE as not ready.
3. **Some missing values err toward FAIL.** A missing spec key is reported as `wrong-chain`; an EL that lacks a non-optimistic beacon payload block is a FAIL.
4. **The ahead tolerance is a choice.** `LABEL_AHEAD_MAX` = 150 blocks is a chosen race tolerance, not a pinned-source constant. It is applied only after the canonical identity check passes.
5. **What the sampler cannot prove.** It does not prove that Base uses only our L1/beacon, or that current blobs are served (safe advancement is the indirect signal). Freshness depends on the guest clock.
6. **Version checks.** Only Lighthouse's version is gated; the reth and Base version strings are recorded, not gated. The deposit `"0x7e"` tag text comes from alloy's derive macro, which is not in the local tree; it is compared case-insensitively.
7. **Where it must run.** It must run inside the guest: 19545 is not forwarded to the host, and the host loopback ports differ.

## 7. Root actions

1. Re-review `readiness_sampler.py` `b15b77af…cec8`. Do NOT deploy the earlier `c6c442a5…` version.
2. After EL/CL/Base sync, run it once in the guest as an unprivileged user and expect INCOMPLETE until a receipt exists. Any `malformed-response` means a field assumption was wrong: fix the sampler, do not override it.
3. Produce a real `COVERED` verdict with the staged coverage helper and write the receipt (§5). Decide what the config pin means, and keep custody of who wrote the receipt.

Single site and operator, sequencer dependence and no forced inclusion remain out of scope.
