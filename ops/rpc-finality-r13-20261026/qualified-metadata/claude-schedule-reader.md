# Authenticated Base schedule reader: ACTUAL offline test PASS (14/14); NOT run against any live L1; no network/SSH/commits

**Stage:** `derivation-schedule-auth-stage/reader/` (frozen, read-only; `reader/SHA256SUMS` lists every file).
- **Unchanged:** the audit report `derivation-schedule-auth-stage/REPORT.md` (its stage `SHA256SUMS` re-verified).
- **Not touched:** `derivation-client-stage` (6d24) and every other stage.

| File | Content |
|---|---|
| `schedule_reader.mjs` | the reader: pure bounded functions + `readSchedule()`, branded results |
| `helios_l1.mjs` | the production `l1` binding to the in-domain Helios over loopback (never run here) |
| `test/schedule_reader.test.mjs` | 14 tests; the mock L1 is a test double only |
| `README.md` | source pins, the caller trust contract, missing items |

## What it does

1. **Anchor:** `readSchedule({l1, keccak, anchor, claimedL2Block, scheduleL2Block})` takes one trusted finalized L1 block `{hash, number}` from the caller (the proof's `l1Head`). Raw labels are never authority. Through the Helios-verified interface it requires, **before and after** the reads:
   - anchor ≤ the verified finalized number;
   - verified block(anchor.number).hash == anchor.hash;
   - finality not regressing.
2. **Read:** at that block number, only the source-grounded interface on `0x7480Afc8D99a5c645c247dB5A1e4a4f440e6e095`: `getSchedule()` and `minimumProtocolVersion()`. No `activatedScheduleId` ABI and no storage layout are assumed.
3. **Decode strictly:**
   - offset 0x20;
   - declared length ≤ 256 (abi), and more than 15 = `unknown_entries` (empty refused);
   - exact size, zero-padded uint64s, lowercase hex;
   - uint256 exactly 32 bytes.
4. **Version check:** the minimum protocol version must be non-zero and ≤ the pinned client **1.5.1** under the upstream `PackedProtocolVersion` ordering (prerelease below final, build ignored, unknown type refused).
5. **Map:** contract `0` = **unscheduled → null**; missing entries → null. The order is exactly the 15 upstream `CONTRACT_VARIANTS` (registration ids).
6. **Horizon:** from the same claim and schedule block as the proof client (0 = the claim; below the claim refuses), with compiled MAINNET genesis (`l2_time` 1686789347, number 0, `block_time` 2). **The Denim 200 ms schedule applies when the authenticated schedule sets Denim**, exactly as `rollup.rs`/`schedule.rs`. Arithmetic is u64-checked.
7. **Schedule id:** `ScheduleId::pin`: the inclusive prefix, holes = 0, entries above the prefix excluded, the 96-byte `keccak256(prev ‖ uint256 i ‖ uint256 ts)` chain. **keccak** is the existing `@noble/hashes` 1.8.0, loaded only after `source/package-lock.json` matches its pin `9ada1611…`, with a self-test.
8. **Result** (frozen, module-privately branded; a JSON or spread copy is rejected by `assertAccepted`):
   - the full 15-entry schedule (timestamp or null, plus whether it was a contract entry);
   - `contractLength`, the minimum version;
   - the claim and schedule blocks and the horizon timestamp;
   - `pinnedCount`, `expectedScheduleId`;
   - the bound L1 `{hash, number}`;
   - `configHashPinCandidate` `0x1607709d…3c57`, labelled a **source pin candidate** until the native client computes the same `rollupConfigHash`.

## Actual tests (offline, shared queue, 512 MiB, `unshare -Urn`, `env -i`)
```
bash jobs/q-exit-status.sh claude-schedule-reader-tests 512 unshare -Urn /usr/bin/env -i PATH=/usr/bin:/bin \
  ANCHOR_DEPS_ROOT=<work>/source /usr/bin/node --test derivation-schedule-auth-stage/reader/test/schedule_reader.test.mjs
```
**Receipt:** `logs/claude-schedule-reader-tests.out` `67fe985d44bfef0b51dd42a74b14ce40f238f6f85ae84c36b2f076f892f81b8f`, `.rc` = 0. Result: `# tests 14`, `# pass 14`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `[queue] EXIT 0`. One background handle (`b6zoxd83w`), not restarted.

**Coverage:**
- **Upstream `schedule_id.rs` vectors:** golden `c04583a1…f00c`, zero-when-inactive, inclusive boundary, gap, clear-above.
- **Holes and boundaries:** hole = 0 (contract 0 ≠ genesis); horizon equal (included) vs +1 s (excluded); future entries excluded but returned.
- **Horizon:** the schedule block sets the horizon (0 = claim, below the claim refuses, u64 overflow refuses); the Denim horizon.
- **Refusals:**
  - unknown 16th entry, >256, empty;
  - 7 malformed-ABI cases;
  - packed-semver accept/refuse sets; a minimum above the client refuses the read;
  - not-finalized anchor; anchor mismatch; hash change during the read; finality regression; malformed anchor;
  - forged results (JSON, spread, hand-built) rejected, with frozen output.
- **Source pins:** 8453, the address, the 15-entry order, genesis.

## Missing (not faked)
1. **No live run.** The pinned in-domain **Helios service and its runtime binding** (URL, unit, readiness) for this reader do not exist yet. `heliosL1` was never run against a service, and **no real `expectedScheduleId` has been read**.
2. **Anchor by number:** reads use the anchor number with hash equality before and after. EIP-1898 block-hash calls were not assumed.
3. **Genesis convention:** if the deployed contract stores `0` (not the genesis timestamp) for a genesis-active upgrade, the reader (0 → None) and the client (`Some(0)` → genesis) disagree, and the proof refuses (fail closed). The first real read settles it.
4. **Bridge to 6d24** (native client):
   - pass this reader's `anchor` = the client's `l1Head`/`l1HeadNumber`, and the same claim and schedule block;
   - feed the same authenticated schedule into the oracle rollup config (0 → `None`);
   - accept only if `BootInfo.schedule_id == expectedScheduleId` **and** the client's computed `rollupConfigHash == 0x1607709d…3c57`.
5. **Unchanged:** Base chain rules (the compiled config, Zenith/Beryl) and Enclave admin rights. The reader is read-only.
