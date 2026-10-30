# Preliminary review while author is active

Not a final review and no candidate tests have run. Do not edit the frozen r4 core.

1. Check `intent_conflict` classification against actual activation-r1/generated/relay/funding-route.mjs. Its response means the nonce is already reserved for different terms and explicitly requires reconciliation before another intent. The current draft lists it as definitive refusal, clearing the per-session blocker. Add an independent regression retaining the hold until the conflicting nonce is proven consumed or the operation otherwise resolved; do not use absence of a hash as proof.
2. `executionBlockers` currently scopes new entries by both sid and record.id. Its contract is a per-session hold. Verify behavior when two public records for the same sid have different local ids, including imported/duplicated records. Do not allow a second id to evade a pending execution for the same session.
3. The active actual-page harness tests the unchanged r4 bundle. Do not claim it qualifies this successor. The harness RPC allowlist currently lacks eth_getTransactionByHash; successor qualification will need a narrow read-only addition and updated hash pins.
4. Core gas-execution source contains new import paths and a proposed entry overlay. Review the final generator and exact served exports, not just source tests, before the page can use it. Keep old proof/migration sources pinned.

These are inspection findings awaiting finalized source and executable tests, not assertions that a production duplicate payment occurred.

20:43 UTC correction after actual bounded frozen-snapshot tests (root-r1): 21 checks, 19 pass, 2 fail, zero skips. The intent_conflict failure is confirmed. The duplicate-local-id test failed BEFORE confirmation at existing validateGasRecord(record_id); this does not prove a bypass through supported storage or a second debit. Its original failure is retained in the frozen root snapshot/log; the current root test now asserts that rejection and the original hold. Do not present preliminary item 2 as a demonstrated product defect. No production transaction occurred.
