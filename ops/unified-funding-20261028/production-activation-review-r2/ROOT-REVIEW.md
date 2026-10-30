# Activation preparation review, 2026-10-28

No production install, restart, signing or fund movement. All four additive deployments are already confirmed; never repeat. Original session30USDC untouched. Snapshot imports retain staging paths and are evidence, not a portable install.

Root fixed malformed block timestamp acceptance, missing explicit sequencer-grace change comparison, misleading queue-idle wording, and added bounded response size, exact JSON-RPC ID/version/result checks, public read-only provider allowlist and2500ms pacing. Thirteen focused offline tests pass/zero skips. Original two failing prepare regressions retained in the first log. Full prepare/capture end-to-end qualification remains pending; equal nonce observations do not establish in-memory queue quiescence.

Historical successful actual Base-fork call traces: wallet app625399gas; old-vault apps609472/631198gas, three tests pass/zero skips. These are execute call traces, NOT transaction receipts and exclude intrinsic/cold-state differences. The prior600000gas draft ceiling was too low. A1000000gas refusal ceiling is being prepared; actual queue gas estimate and size/price/attempt checks remain mandatory.

Two independent read-only providers Base official RPC and Blast agreed block53217886 for the sequencer-aware revised fee envelope. Observation fee56553USDC micro-units ($0.056553) includes conservative L2/L1/operator compensation and20% margin. This is not actual receipt cost and has no refund when actual relay cost is lower. Configured max fee0.08USDC, max gas1M, price20Mwei, tip2Mwei, signed720bytes,3attempts,25% replacement bump. Provider/runtime pins and signed grant limits remain required; observations are not new owner grants. L1/operator inclusion drift remains relayer risk. r5 failed on second-provider429, retained; r6 passed with independent observations parallel and2500ms per-provider pacing, no identity/rate-limit bypass.

Full integrated site build passed161files/26.8MB, no production replacement. It regenerated tracked CSS/contract-artifacts as a build side effect; those bytes were retained locally and committed source restored. Live apex is newer than source; only a reviewed additive page is allowed. Standalone package browser qualification and concrete relay maintenance plan remain outstanding.

Official references: https://docs.base.org/get-started/connect-to-base and https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments . Quoter0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a requires actual getter/runtime binding checks before use.
