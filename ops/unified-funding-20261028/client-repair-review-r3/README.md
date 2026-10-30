# client-repair-r3 (UNREVIEWED · NOT RUN · NOT BUILT · NOTHING SIGNED · NOT DEPLOYABLE)

Source only. I ran no command, test, build, network call, signing or deployment for this pass. Production source and
the originals in `../client-migration-r1`, `../client-repair-r2`, `../client-r1` and `../../source` are untouched. The
partition below holds CANDIDATE terms only. It is not approved and not signable.

## 1. The three reproduced reorg failures (`test/root-reorg.test.mjs`, root's file, unchanged)

| Failure | Fix |
|---|---|
| reconcile re-adopted a proven replacement whose canonical receipt disappeared | `reconcileMigration` now re-proves every `proven` step (`recheckProven`: same tx, same exact events, **same original block number and hash**) before `afterProven`/adoption. A lost, moved or contradicting receipt throws `prior_proof_lost` / `prior_proof_changed` / `prior_proof_contradiction`. |
| run sent the next gas open on orphaned canonical-only proofs | `runMigration` re-proves all earlier steps in order before every send (`preconditions → recheckPrior`) and again before every adoption. `admit` also refuses while any earlier step carries an unresolved `recheck`. |
| `receiptFinality` accepted a header with a mismatched number | Both headers are now validated. The finalized head needs a nonzero canonical number and a nonzero 32-byte hash. The header at the receipt height must have exactly the receipt's number (else `receipt_identity`) and hash (else `receipt_reorged`). When the finalized head is at that height, its hash must match too. |

How a failed recheck is handled:
- **Proofs are retained.** A failed recheck keeps `status: "proven"` and the original proof. It journals `recheck: { at, result }` and is never reset or re-armed.
- **Recovery.** A later successful recheck clears the flag. A receipt re-included in a different block stays refused (`prior_proof_changed`) for review.
- **Final vs non-final.** These stay distinct: proofs record `final`, and `requireFinal` makes steps wait for finality.
- **Cached finality.** Final proofs skip re-proving only under an explicit policy, exactly `{ cacheFinalized: true, source: "finalized-tag", reviewedBy }`. Anything else fails closed (`finality_policy_invalid`).

**Chain time for void/re-arm.** An admitted/submitted step becomes `void` only when all of the following hold:
- the pinned **chain** block timestamp is past its signed window, and so is the local clock;
- the USDC `authorizationState` and the step's own effects show nothing, read at that same pinned block;
- that block's hash is rechecked afterwards.

The void evidence (block, hash, timestamp) is journaled. Local time alone only yields `wait_window`.

## 2. Explicit gas partition (nine distinct apps > eight per grant)

Single-grant form (unchanged, backward compatible): `split = { legacy6, gas6 }` gives steps `terminate, legacyOpen, gasOpen`.
A fresh scope with more than 8 apps refuses this with `gas_partition_required`.

Partition form: `split = { legacy6, gas: [{ name, budget6, opsPerPeriod, appIds: [...] }, ...] }` gives steps
`terminate, legacyOpen, gasOpen:<name>…` in the listed order. `parseSplit` enforces:
- each part names 1..8 explicit app ids (no wildcard; contract limit unchanged);
- parts are disjoint (`gas_scope_overlap`);
- every fresh-scope app is covered (`gas_scope_uncovered`) and nothing outside it is named (`gas_scope_excess`);
- each part has a positive budget ≤ 1 USDC, and the parts total **exactly** the reviewed 1 USDC (no duplicated or enlarged gas budget);
- `opsPerPeriod` totals ≤ 20; `spendPerPeriod` = the part's budget; every other cap is the reviewed candidate's;
- legacy + gas = the fresh old balance ≤ 30 USDC.

How the partition runs:
- **Keys.** Each part gets its own fresh non-extractable key and record. The legacy replacement keeps the same key and API scopes, with no owner or custody migration.
- **Terms.** `terms.order`, `terms.split.parts` and `terms.gas.parts[]` (with exact templates) are inside the approved `termsHash`.
- **Prompts.** Full signing is 1 + 2 + 2×parts owner prompts. For the candidate that is 7: terminate plus 3 grant/deposit pairs.
- **Recovery.** Every gas part has its own CAS admission, pending/reload/lost-reply/void/re-arm handling and on-chain proof. A later part is never sent before the earlier ones are proven and rechecked.
- **Funding selection.** `selectGasRecord(records, scope, deployment)` returns the ONE open grant whose app scope names the deployment's app. It refuses `matching_grant_not_open` (no first-open fallback) and `matching_grant_ambiguous`. The page uses it for quotes.
- **Scope reads.** `freshRecoveryScope` no longer refuses more than 8 apps. It reports `partitionRequired` and the constraint.

Candidate (from `../GAS-GRANT-SCOPE-DESIGN-INPUTS.md`, historical ids from `../RECOVERY-SCOPE-HISTORICAL-r1.json`):
legacy 29 + gas 0.9 over the eight NucBox apps + gas 0.1 over the single Metal0 image app = 30. The tests' per-part
`opsPerPeriod` (18 / 2) are placeholders; root chooses them.

**Known constraint (not resolved here).** At the candidate caps one gas op may need up to 0.10 (maxGasUsdcPerOp) +
0.05 (maxFeePerOp) = 0.15 USDC, so the 0.1 USDC image grant can fund an op only when the actual quote's
`maxUsdcIn6 + fee ≤ 0.1`. Otherwise `quote_exceeds_budget` refuses; it is never enlarged. Root must refresh quotes before
approving the split.

## Tests (written, NOT executed this pass)

| File | Cases |
|---|---|
| `root-receipt.test.mjs` | 18 (unchanged) |
| `test/root-reorg.test.mjs` | 3 (root's, unchanged) |
| `test/offline.test.mjs` | 14 |
| `test/partition.test.mjs` | 7 |

`test/fixtures.mjs` is shared and has an explicit chain clock `W.time`.

The offline file keeps all 13 r2 cases on the shared fixtures. Its void/contradiction cases now advance chain time, and
the refused case also asserts that local time alone waits. One case is new: a reorg after proof keeps the proof, sends
and adopts nothing, makes an invalid finality policy fail closed, and recovers when the same receipt returns.

The partition cases cover:
- split totals (accept the candidate; refuse wrong total, enlarged gas, ops overflow, zero, single form on 9 apps);
- overlap, uncovered, excess, >8 apps in one part, wildcard, duplicate part names;
- 3 distinct keys, exact scopes, 7 prompts, no-gap signing;
- legacy first and parts in order, wallet ends at 0 with 3 authorizations, selection by app scope (unopened grant refused, no fallback);
- multi-part pending + reload; multi-part lost reply; refusal before any key is created.

None of this exercises a real wallet, browser IndexedDB (only `MemoryV2Store`'s CAS), the DOM, deployed contracts, live
relays, the native HTTP path or current prices. Still uncovered: `verifyRuntime`, `freshRecoveryScope`, `pinBlock`,
the JSON-RPC `legacyChain` adapter, `confirmGasFund`.

## Unresolved (all block signing)

1. **Review and run.** Root review and a guarded run of all four test files.
2. **Event signatures.**
   - The successor `FundingSessionVault` `SessionOpened` signature must equal the original's.
   - Base USDC must emit exactly one `AuthorizationUsed` and one `Transfer` per `receiveWithAuthorization`.
3. **Finality policy.** Choose canonical-at-observation (default) or `requireFinal`, and whether to approve a `cacheFinalized` policy.
4. **Partition terms.** A fresh scope at current state, root-chosen per-part `opsPerPeriod`, and quotes refreshed against the 0.1 USDC part. Then approve one exact `termsHash`.
5. **Deployment and runtime.** Deployed runtime pins, enabled intake, and the legacy record present in this browser's `enclave-sessions`.
6. **Browser behaviour.**
   - Real IndexedDB CAS across tabs.
   - The bundle (`lib/browser-entry.mjs`) is unbuilt.
   - `prepare-expect.json` is still all `null`.
   - Native contract/HTTP integration tests are outstanding.
