# derivation-schedule-auth-stage/integration-r1 (50cf; PREPARED): reader → native trusted-input bridge

**Inputs, frozen and not edited:**
- `../reader/` (`SHA256SUMS` `7951abe6…`; `bridge.mjs` verifies `schedule_reader.mjs` = `688b7a1f…` before importing it);
- `derivation-client-stage/r3` (`SHA256SUMS` `2a12cd13…`, owned by 6d24).

**Report:** `../../logs/claude-schedule-integration.md`.

## What `bridge.mjs` does
1. **`buildTrustedInput({accepted, anchor, agreedL2OutputRoot, claim, rollupConfigTemplate, expectedRollupConfigHash})`** produces **exactly** r3's 9 `TRUSTED_KEYS`. It refuses unless:
   - `accepted` is the reader's **branded** result;
   - the caller's `anchor` is the reader's bound L1 block;
   - the reader horizon block == the claimed block (r3 injects no `L2_SCHEDULE_BLOCK_NUMBER_KEY`, and upstream then uses the claim);
   - the candidate claim number == that block;
   - `expectedRollupConfigHash` == the source pin candidate `0x1607709d…3c57`.
   The claim is passed as an **untrusted candidate**: the native run must derive that number **and** root.
2. **`scheduleRollupConfig(template, accepted)`:** the host-served rollup config is an untrusted shape template. Upstream `BootInfo::load` for 8453 uses only its `l2_chain_id` and the 15 contract-backed activations, and takes every static parameter from the compiled config.
   - The template must be an object with `l2_chain_id == 8453`.
   - All 15 activations are **replaced** from the authenticated schedule, using upstream serde keys: `regolith_time` … `jovian_time` and `base.{azul,beryl,cobalt,denim,everest}`.
   - `None` (contract 0 or no entry) means the key is absent, which upstream applies as `Never` (cleared).
   - The `v1`/`v2`/`v3` alias spellings are removed, so serde can't hit a duplicate field.
3. **`acceptNativeResult(result, trusted)`:** r3's stdout JSON must bind every trusted field (chain, L1 head and number, agreed root, derived root/number = the claim, `rollupConfigHash` = pin, `scheduleId` = expected). Anything else refuses.

**It is not a lifecycle `readAnchor` provider:** it authenticates no Base header and runs no native process.

`test/bridge.test.mjs`: 10 offline tests (the mock L1 and the hand-built native result shapes are test doubles only).
