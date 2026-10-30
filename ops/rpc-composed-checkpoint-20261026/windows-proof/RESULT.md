# Windows verifier integration

Source fixes committed and pushed as 64156dcd9 (full SHA is available from the branch). The fixture now uses the actual witness proof API, compares proof-backed account nonces with the chain, loads contract pins before negative probes and selects the supported verifier authority. The diagnostic driver preserves bounded nested causes without changing success or error-code semantics.

The r2 full suite passed five of six cases. The sixth refused the stale read correctly, but the driver truncated the specific cause. After the diagnostic-only change, the selected tamper/missing-witness/stale-head case passed. The ten Windows chain-authority tests also passed. Five earlier passes are reused because their assertions are unaffected by diagnostic text; this is not represented as a fresh six-case run. No test assertion was weakened to accept an unrelated refusal.

Node reports only the selected test, not five filtered-out skips. The initial result checker expected six entries and falsely marked the successful run failed. Its raw result is retained; reviewed-result.json records the actual one-pass TAP and exit zero. No repeat run was needed to correct this bookkeeping.

These are local Reth and synthetic-sequencer tests. They do not establish production Windows cutover or Base finality. Existing source and native input hashes are retained in the parent checkpoint and canonical runner records.
