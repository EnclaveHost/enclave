# Derivation schedule/config authentication audit (READ-ONLY source audit; nothing built, tested or run; no code written)

**Source:** `/tmp/recipe-pk5njlzh/w8/vendor-inspect/base-v1.5.1`, byte-identical to the pinned upstream base `5476069f` (tar `9784e20a…`, per `derivation-client-stage/INTERFACE.md`). Paths below are relative to that tree.

**Not touched:** `derivation-client-stage`, `source/`, anything live. **No value below is invented;** unresolved items are listed as unresolved.

## 1. `ScheduleId`: exact algorithm (KNOWN)

**Location:** `crates/proof/proof/src/schedule_id.rs`, `ScheduleId::pin(config, l2_timestamp)` (l.22-54) and `next_link` (l.58-64).

**Steps:**
1. **Normalize:** every contract-backed upgrade with activation `Some(0)` is set to `config.genesis.l2_time`, the contract's representation of genesis-active upgrades. Boot rejects `genesis.l2_time == 0` first.
2. **Prefix:** `pinned_count` = 1 + the highest index `i` in `BaseUpgrade::CONTRACT_VARIANTS` whose activation is ≤ `l2_timestamp` (inclusive), or 0 if none. Every entry at index ≥ `pinned_count` is **cleared** in the config.
3. **Chain:** `id = 0x00…00`. For `i` in `0..pinned_count`, `id = keccak256(id ‖ uint256(i) ‖ uint256(ts_i))` (96 bytes, big-endian, = `abi.encode(bytes32,uint256,uint256)`). `ts_i` = 0 for unscheduled **holes inside the prefix**.

**Upstream golden vector** (test, l.75-90): Regolith 10, Canyon 20, Azul 30, all else unset, `pin(…, 30)` = `0xc04583a182a2a57476d1ca57f9e5e7aa24f1eee188221f75fe17634b8a63f00c`. Further upstream vectors: zero when nothing is active (l.94); an inclusive boundary (l.109); an inactive gap below an active upgrade (l.120); genesis-zero normalization (l.140); clearing above the prefix (l.161).

**Two on-chain functions, as described in upstream comments (l.9-16):** the pin "mirrors the onchain `ProtocolVersions.activatedScheduleId(l2Timestamp)`" (timestamp-filtered prefix). It **differs from the no-argument `ProtocolVersions.scheduleId()`**, which commits **every** registered upgrade, including future-scheduled ones. An authenticated reader must use the timestamp-filtered form at the right horizon, never `scheduleId()`.

**`CONTRACT_VARIANTS` order:** `crates/common/genesis/src/chain/upgrade.rs` l.169-185, 15 entries. **The index is the contract registration id:**

| Index | Upgrade |
|---|---|
| 0 | Regolith |
| 1 | Canyon |
| 2 | Delta |
| 3 | Ecotone |
| 4 | Fjord |
| 5 | Granite |
| 6 | Holocene |
| 7 | PectraBlobSchedule |
| 8 | Isthmus |
| 9 | Jovian |
| 10 | Azul |
| 11 | Beryl |
| 12 | Cobalt |
| 13 | Denim |
| 14 | Everest |

The code says this order MUST equal the contract's append-only registration order. Bedrock and Zenith are not contract-backed.

## 2. Where `BootInfo` pins it (KNOWN): `crates/proof/proof/src/boot.rs` `BootInfo::load` (~l.249-475)
- **Chain:** the chain id must be a built-in Base chain. For non-devnet chains, the **compiled** `chain_config.rollup_config()` is used, and **only** the contract-backed activation timestamps are copied from the oracle-served config (`apply_upgrade_activation` over `CONTRACT_VARIANTS`). Host timestamps therefore enter only through `schedule_id`, which the verifier must check against an authenticated value. The host is never the authority.
- **Schedule horizon:**
  - The horizon block is the local key `L2_SCHEDULE_BLOCK_NUMBER_KEY` (11). Missing or 0 means the claimed block.
  - It must be ≥ the claimed block (`ScheduleBlockBeforeClaim`).
  - `l2_schedule_timestamp = rollup_config.l2_block_timestamp(schedule_block)`, and `schedule_id = ScheduleId::pin(&mut rollup_config, l2_schedule_timestamp)`.
- **Zenith:** active at or before the claim timestamp means rejected; later means removed.
- **Beryl:** a pinned Beryl requires the built-in `beryl_activation_admin_address()` (`MissingActivationAdminAddress`).
- **Committed outputs:** `BootInfoStruct` (`crates/proof/zk/utils/src/boot.rs`) commits `rollupConfigHash` and `scheduleId` alongside `l1Head`, the pre/post roots and the block numbers.

## 3. `rollupConfigHash` (KNOWN algorithm; static)
- **Algorithm:** `hash_rollup_config` (`crates/proof/zk/utils/src/boot.rs` l.15) = `PerChainConfig::from_rollup_config(cfg)` → `force_defaults()` → `keccak256(marshal_binary())`.
- **Fields** (`crates/proof/primitives/src/per_chain_config.rs`):
  - version;
  - chainId;
  - genesis L1 hash and L2 hash;
  - genesis `l2_time`;
  - genesis batcher;
  - scalar;
  - gas limit;
  - deposit contract;
  - L1 system-config address.
  - Overhead is forced to zero. **Hardfork timestamps are excluded** (committed via `scheduleId`). `force_defaults` body not inspected.
- **Upstream asserted value** for chain **8453**: `0x1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57`. This is test `test_config_hash_matches_nitro_enclave`, equal to the nitro enclave's `CONFIG_HASHES`, which is derived the same way from `ChainConfig::all()` (`crates/proof/tee/nitro-enclave/src/server.rs` l.25-45).
- **Status:** a **reviewed static pin candidate**, source-derived and upstream-test-asserted. **We have not executed it.** The derivation-client run's own `rollupConfigHash` output must equal it before use.

## 4. Address and interface provenance
- **L1 address (KNOWN, source constant):** Base mainnet (8453) `ProtocolVersions` reader default `0x7480Afc8D99a5c645c247dB5A1e4a4f440e6e095` (`crates/utilities/upgrade-signal/src/config/args.rs` l.41; README table). The README says this is the dynamic upgrade-reader default, **not** the legacy protocol-versions address in the rollup config. It may be a proxy.
- **Read interface in the repo** (`upgrade-signal/src/contract.rs` l.26-36): `getSchedule() → uint64[]` (one timestamp per registration id, ascending; `0` = not scheduled) and `minimumProtocolVersion() → uint256` (packed semver). The node maps entries positionally onto the ladder. Entries beyond the binary's ladder are logged and **ignored**; an authenticating reader should refuse them instead.
- **NOT in the repo (UNRESOLVED):**
  - the deployed `ProtocolVersions` source and its storage layout;
  - its proxy implementation;
  - **its owner/upgrade authority (the L1 authority)**;
  - confirmation that the deployed contract exposes `activatedScheduleId(uint64)`/`scheduleId()`. That evidence is only the comment in `schedule_id.rs`.
- `crates/utilities/test-utils/contracts/src/MockProtocolVersions.sol` (`uint64[] private schedule; uint256 private minimumVersion;`) is a **devnet mock, not evidence** of the production layout.
- **Authority split:**
  - **L1:** whoever controls the `ProtocolVersions` schedule (unresolved).
  - **L2:** the built-in Beryl activation-admin address (compiled chain config), governing Base precompile activation. This is separate, and nothing here changes it.
- **On-chain verifier (UNRESOLVED):** how the on-chain proof verifier/dispute game derives its expected `scheduleId`. Which function, at which L1 block, with which timestamp is not in this repo. Only the journal layout is: `crates/proof/primitives/src/proposal.rs` `config_hash` (l.41, l.64).

## 5. What the client needs (bridge to `derivation-client-stage` owner; this stage does not edit it)
- **`expectedRollupConfigHash` (8453):** the upstream pin `1607709d…3c57`, after the client's own measured `rollupConfigHash` equals it.
- **`expectedScheduleId`:** **not resolvable today without an authenticated L1 read.** The smallest correct reader:
  1. **Anchor:** an L1 block that is **Helios-finalized**, in-domain. Never ASR/unsafe/latest. It must be bound to the proof's `l1Head` (the schedule is mutable, so it must be read at the same L1 state the claim is judged against; the on-chain rule for this is unresolved).
  2. **Read**, either:
     - **(a)** a Helios-verified `eth_call` `activatedScheduleId(l2ScheduleTimestamp)` on `0x7480…e095`, **if** the deployed contract exposes it; or
     - **(b)** `getSchedule()` via a Helios-verified call, or an `eth_getProof` MPT proof of the schedule storage (needs the real proxy and implementation layout, unresolved), then compute `ScheduleId::pin` locally with the algorithm in section 1.
  3. **Horizon:** `l2ScheduleTimestamp = genesis.l2_time + (scheduleBlock − genesis.l2.number) × block_time`, with `scheduleBlock` = the same `L2_SCHEDULE_BLOCK_NUMBER_KEY` the client passes (default = the claimed block, and must be ≥ the claimed block).
  4. **Coverage:**
     - all prefix entries, with holes as 0;
     - refuse on entries beyond the 15-entry ladder;
     - refuse on a schedule array longer than 256 (upstream bound);
     - check `minimumProtocolVersion` (non-zero and ≤ the client's version) as the node does.
- **Static measured pin alternative:** record (L1 finalized block, schedule array, resulting id) once, and review it. It is valid only while that L1 schedule is unchanged **and** the claim horizon stays below the next scheduled-but-future activation. Re-read before any later horizon.
- **Preserved:** Base chain rules (the compiled config, the Zenith/Beryl rules) and Enclave admin rights are unaffected. The reader is read-only, and nothing in this audit changes any authority.

## 6. Unresolved, precisely
1. The deployed `ProtocolVersions` implementation, its ABI (whether `activatedScheduleId`/`scheduleId` exist), its storage layout, proxy and owner.
2. Which L1 block, and which L2 timestamp, the on-chain verifier uses to derive its expected `scheduleId`.
3. The `force_defaults` body, not inspected.
4. Any actual `expectedScheduleId` value for Base mainnet (needs the authenticated read above).
5. Our own execution of the config-hash and schedule algorithms (no build or test was run).

**Stage copy:** `derivation-schedule-auth-stage/REPORT.md` (identical), plus `SOURCES.sha256` for the cited source files.
