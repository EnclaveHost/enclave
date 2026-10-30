# Schedule reader ↔ native derivation client (r3): integration-r1 bridge: ACTUAL offline PASS 10/10; NOT a provider; core blockers remain

**Stage:** `derivation-schedule-auth-stage/integration-r1/` (frozen, read-only; `SHA256SUMS` lists `bridge.mjs`, `README.md`, `test/bridge.test.mjs`).

**Inputs, verified unchanged and not edited:**
- `reader/` (`7951abe6…`);
- the audit report;
- `derivation-client-stage/r3` (`2a12cd13…`, 6d24).

**Not done:** no network, no live operations, no SSH, no commits.

## Upstream checks (base `5476069f` vendor-inspect, cited) against the reader's assumptions

| Item | Finding |
|---|---|
| Native schedule-block key | r3's `inject_trusted` puts `L1_HEAD`, `L2_OUTPUT_ROOT`, `L2_CLAIM`, `L2_CLAIM_BLOCK_NUMBER`, `L2_CHAIN_ID`, `L2_ROLLUP_CONFIG`, `L1_HEAD_NUMBER` and **no `L2_SCHEDULE_BLOCK_NUMBER_KEY`**. Upstream `boot.rs` then uses the **claimed block** as the horizon. The bridge refuses any reader result whose schedule block ≠ claim (the reader's default is the claim). |
| Rollup config injection | `boot.rs` (8453, non-devnet): the compiled `chain_config.rollup_config()` plus, for each of the 15 `CONTRACT_VARIANTS`, `apply_upgrade_activation(oracle.upgrades.activation(u))`. `UpgradeConfig::activation` gives `Some(t)` → `Timestamp(t)` and `None` → `Never`, and `Never` **clears** (`rollup.rs:249-256`). The oracle config must also have `l2_chain_id == 8453`. **So the JSON's static fields are ignored for 8453; only its chain id and the 15 activations matter.** |
| JSON keys | `RollupConfig` is serde `deny_unknown_fields` with `upgrades` flattened. `UpgradeConfig` uses top-level `regolith_time` … `jovian_time` and nested `base` {`azul` (alias `v1`), `beryl` (`v2`), `cobalt` (`v3`), `denim`, `everest`, `zenith` (`future`)}; `None` = absent. The bridge writes exactly these and removes the alias spellings (to avoid duplicate fields). Zenith is not contract-backed and BootInfo ignores the oracle's value. |
| Zero/genesis semantics | contract 0 → the reader gives `None` → the key is absent → `Never`. **Consistent.** Upstream `ScheduleId::pin` only normalizes `Some(0)`, which the bridge never emits. **Residual:** if the deployed contract stores 0 for a genesis-active upgrade, the native compiled/genesis behaviour and the committed schedule may differ, and the run refuses (fail closed). The first real read decides. |
| Config hash | `0x1607709d…3c57` stays a **source pin candidate**. The bridge requires the caller to pass exactly it, and `acceptNativeResult` requires the native `rollupConfigHash` to equal it, so the first successful native run is the confirmation. |
| Helios historical `eth_getBlockByNumber`/`eth_call` | **UNVERIFIED.** The reader assumes the pinned Helios (`helios-eeffcc9`) light-client-verifies `eth_getBlockByNumber(n)` and `eth_call` at block `n` for the anchor. Nothing in the vendored base tree establishes how far back (relative to its finalized head) Helios can verify. A recent finalized anchor is the intended use. Historical anchors must be proven against the pinned Helios before anyone relies on them. |

## Bridge (`bridge.mjs`, internal)

- **Integrity:** it verifies the frozen reader's sha `688b7a1f…` before importing it (`reader_pin`).
- **`buildTrustedInput`** produces **exactly** r3's 9 `TRUSTED_KEYS` from:
  - the **branded** reader result (forged or copied results refuse);
  - the caller-authorized agreed root;
  - the same L1 anchor (a mismatch refuses);
  - the **untrusted candidate claim** (its number must equal the reader's horizon block; the root is checked only by the native run);
  - the untrusted host rollup-config template (chain 8453; the 15 activations overwritten from the authenticated schedule);
  - `expectedRollupConfigHash` (must be the pin candidate) and `expectedScheduleId` (from the reader).
- **`acceptNativeResult`** requires r3's result JSON to bind every trusted field. A config-hash mismatch gives `config_hash`; a schedule mismatch gives `schedule`; a root, number, L1 or agreed-root mismatch, or a refusal, gives `native`.

## Actual tests (offline, shared queue 512 MiB, `unshare -Urn`, `env -i`, host floor 16384 MiB)

1. **`claude-schedule-integration-tests`: FAIL** (rc 1, `# fail 1`, `SyntaxError`: `await` inside a non-async arrow in the test file). Receipt `logs/claude-schedule-integration-tests.out` `19a51214…`, kept. It was launched before my syntax check returned; the fix was test-only.
2. **`claude-schedule-integration-tests-2`: PASS.** `# tests 10`, `# pass 10`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `[queue] EXIT 0`, rc 0 (`logs/claude-schedule-integration-tests-2.out`/`.rc`).

**Covered:**
- exact keys and bindings;
- the 15-key schedule injection (`None` absent, aliases removed, host values never survive);
- anchor mismatch;
- a claim for another block, a non-claim horizon, malformed roots;
- forged reader results;
- an expected config hash ≠ pin;
- the wrong chain or a non-object template;
- native-result binding (config hash, schedule, root, number, L1, agreed root, refusal);
- an omitted upgrade (Cobalt) changing `expectedScheduleId` and being refused by the binding;
- a tampered reader sha.

## Blockers (specific; not papered over)

1. **r3 cannot load boot info as written.** Upstream `BootInfo::load` requires `INTERMEDIATE_BLOCK_INTERVAL_KEY` (9) (`MissingIntermediateBlockInterval`, `boot.rs`). r3 does not inject it, and it refuses Local keys from the witness. So any real r3 run would refuse at boot. **Owner 6d24:** add it to the trusted input and injection, with a value the caller authorizes; the bridge then gains one key. Also: r3 has **never built or run** (r1/r2 test-rc 101, a chrono resolution failure; r3 build log without rc).
2. **No live in-domain Helios binding** for the reader (`helios_l1.mjs` never run). The historical-verification question above is open.
3. **No callable lifecycle `readAnchor` provider.** `AUTHORITY-ADAPTER.md` requires `{tier: 'l1-finalized-derived', base: {number, hash, stateRoot, outputRoot, timestamp}, l1: {number, hash, timestamp}}` returned only after light-client, derivation, execution and schedule checks. This bridge yields only `{l1, base: {number, outputRoot}}` after a native result. Still missing:
   - the native run itself;
   - authenticating the Base header `hash`/`stateRoot` against the output root (`keccak(version 0 ‖ stateRoot ‖ messagePasserRoot ‖ blockHash)`) and the timestamp;
   - the L1 timestamp;
   - the runtime (journal, deadlines).
   **It is labelled `notAProvider` and must not be wired as `readAnchor`.**
4. **Agreed-root authority:** it must come from the caller's accepted chain (the ASR anchor first, then the previous accepted result). The bridge only format-checks it.

**Unchanged:** Base chain rules (the compiled config, Zenith/Beryl) and Enclave admin rights. Nothing here signs, serves or activates.
