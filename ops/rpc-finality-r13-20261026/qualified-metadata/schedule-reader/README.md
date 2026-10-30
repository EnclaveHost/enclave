# derivation-schedule-auth-stage/reader (50cf): authenticated Base mainnet upgrade-schedule reader → `expectedScheduleId`

**Ownership:**
- **This reader:** 50cf.
- **The native proof client** (`derivation-client-stage`): 6d24. That stage is not edited here.

## Files

| File | What it is |
|---|---|
| `schedule_reader.mjs` | pure, bounded functions plus `readSchedule()`. Accepted results are frozen and module-privately branded (`isAccepted`/`assertAccepted`), so forged JSON is rejected |
| `helios_l1.mjs` | the production `l1` binding: JSON-RPC to the in-domain Helios on a loopback literal (redirect:error, integer timeout, byte cap, strict envelope/hex) |
| `test/schedule_reader.test.mjs` | 14 offline tests; its `mockL1` is a test double, **never live authority** |

## Source pins (upstream base `5476069f`, vendor-inspect base-v1.5.1)
- **Chain id and contract:** chain id `8453`. L1 `ProtocolVersions` reader `0x7480Afc8D99a5c645c247dB5A1e4a4f440e6e095` (`upgrade-signal/src/config/args.rs:41`). Read interface `getSchedule() → uint64[]` and `minimumProtocolVersion() → uint256` (`upgrade-signal/src/contract.rs`). **No `activatedScheduleId` ABI and no storage layout is assumed.**
- **Registration order:** exactly 15 entries, regolith … everest (`common/genesis/src/chain/upgrade.rs` `CONTRACT_VARIANTS`).
- **Algorithm:** `ScheduleId::pin` (`proof/proof/src/schedule_id.rs`):
  - the prefix through the highest entry at or below the horizon (inclusive);
  - holes inside the prefix committed as 0;
  - entries above the prefix excluded;
  - `link = keccak256(prev ‖ uint256 i ‖ uint256 ts)`, 96 bytes.
- **Contract `0`:** means **unscheduled**, mapped to `null`/`None`, never the legacy `Some(0)` genesis convention.
- **Horizon:**
  - the schedule block, where 0 or absent means the claimed block and anything below the claim refuses (`boot.rs`);
  - its timestamp comes from compiled MAINNET genesis (`l2_time` 1686789347, L2 number 0, `block_time` 2);
  - **if the authenticated schedule sets Denim**, the 200 ms Denim schedule applies (`genesis/src/rollup.rs l2_block_timestamp`, `schedule.rs`).
- **Minimum protocol version:** non-zero and ≤ pinned client **1.5.1** under `version.rs` `PackedProtocolVersion` ordering (type, major, minor, patch, prerelease-below-final; build and reserved ignored; unknown type refused).
- **Bounds:**
  - ABI offset == 0x20;
  - declared length ≤ 256 (abi) and ≤ 15 (more = `unknown_entries`; empty refused);
  - exact size, zero-padded uint64s, lowercase hex;
  - u64-checked arithmetic.
- **`rollupConfigHash` `0x1607709d…3c57`:** carried only as a **source pin candidate** until the native client computes the same value.

## Caller trust contract (internal; the reader cannot check these)
1. **`l1` is the pinned in-domain Helios over loopback.** Its `eth_getBlockByNumber`/`eth_call` results are light-client verified. A raw execution RPC is not acceptable.
2. **`anchor {hash, number}` comes from the trusted in-domain finality authority.** It is the **same** L1 block the proof claim is judged at (the client's `l1Head`/`l1HeadNumber`). It is never a provider label, the ASR, or an unsafe head.
3. **`claimedL2Block`/`scheduleL2Block` are exactly what the proof client receives.**

**The reader checks:**
- the anchor ≤ the verified finalized number, before **and** after the reads;
- the verified block hash at `anchor.number` == `anchor.hash`, before and after both calls (any change refuses);
- finality not regressing;
- the ABI, version and algorithm rules above.

**Output (branded):** the full 15-entry schedule, `expectedScheduleId`, `pinnedCount`, the horizon (claim and schedule blocks, timestamp), the bound L1 `{hash, number}`, the minimum version, and the config-hash candidate.

## Missing (not faked)
- **No live authority yet:** the running, pinned in-domain Helios instance and its runtime binding (URL, unit, readiness) for this reader. `heliosL1` has never been run against a service, so mocks are not authority.
- **Helios calls use the anchor number,** with hash equality before and after. EIP-1898 block-hash calls were not assumed.
- **Contract-0 assumption:** genesis-active upgrades are assumed stored as the genesis timestamp, per the `schedule_id.rs` comment. If the deployed contract stores `0` for one, the native client (`Some(0)` → genesis) and this reader (0 → `None`) disagree, and the proof is refused (fail closed). A real read will show which holds.
- **Native-client equality:** the native client must feed the same authenticated schedule into its oracle config (0 → `None`), so its `BootInfo.schedule_id` must equal `expectedScheduleId`.
