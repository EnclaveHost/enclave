# migration-cutover-prep-r1: REPORT (source only, not run)

Status: **UNREVIEWED. Nothing was executed, signed, sent or deployed.** I used only Read/Grep/Write. The original
`source/`, `production-grant-terms-r1/` and all runtime files are unchanged. The original 30 USDC session is untouched.
No signing request was prepared.

Files written (only here):
- `generator/generate_cutover.py`: a strict, hash-pinned derivation of the **qualified**
  `production-grant-terms-r1/candidate/sdk/funding`. The 8 input hashes equal that candidate's `GENERATED.json` outputs,
  and the generator also cross-checks against that file. Only `migration.mjs` is edited, with 11 anchored and reversible
  edits. The other 7 modules are byte-identical. It refuses to run if `candidate/` already exists, if any pin drifts, if
  an existing refusal disappears, or if the edits add any forbidden text (fake intake, finality relaxation, signing,
  secrets, overrides, `send(`, `"*"`).
- `test/cutover-pause.test.mjs`: 7 focused offline tests covering the pause only. They do not repeat the
  already-qualified codec, split or literal tests.
- This report.

## 1. Minimal SDK change (generated, `migration.mjs` only)

| Change | Where | Effect |
|---|---|---|
| `terms.cutover = { pauseAfter:"terminate", activationPlanSha256, rollbackPlanSha256, claim:"termination-prefix-only-not-a-relay-drain" }` | `buildMigrationPlan(..., cutover)` → `cutoverTerms()` | The pause, the activation-plan hash and the rollback-plan hash are inside `termsHash`, so root reviews them with the money terms. Plans without a cutover keep the exact qualified terms shape. |
| A cutover plan can be **prepared** with intake off or absent | the same function | It records `stagedIntake: null` and `stagedIntakeWhy` truthfully. Intake is never set to true. The gas-send precondition `intake_off` is unchanged. |
| Terminate requires the **full** plan signed | `runMigration` | Terminate is sent only when the signed bundle covers terminate, legacyOpen and every gas part with the exact digests. The existing `replacement_unsigned` refusal is kept. |
| Durable pause in the **same compare-and-set** as the terminate proof | `markProven` | Writes `plan.cutover = { paused, after, at, terminate:{txHash, block, blockHash} }` only after `proveEnded` has proven an exact full refund with fee 0 and the USDC Transfer from vault to owner, from a canonical receipt. The run and reconcile paths both go through this. |
| Fail-closed gate | `runMigration` returns `{paused:true}`; `admit` refuses `cutover_paused` inside its compare-and-set | A plan with `terms.cutover` stays held until a resume record exists for that exact terminate tx. A missing marker blocks; it never opens. |
| `resumeCutover(ctx, planId, activation)` | new | Never signs or sends. It requires all of the following, then records `cutover.resumed` (the pause record is kept for audit). See the list below. |

`resumeCutover` checks:
- **Activation evidence.** The `enclave-funding-cutover-activation-r1` record has `rootReviewed:true` and `reviewedBy`. It binds `planId`, `termsHash`, the terminate tx hash and block hash, the reviewed `activationPlanSha256`, the successor `relayer`, and `legacyRelayerReconciledThroughNonce`. The nonce is a reviewed statement; the browser cannot verify it.
- **Live runtime.** A fresh `verifyRuntime` with `intake.openEnabled`, the same relayer, and a verified block after the terminate block.
- **Terminate proof.** The terminate is re-proven at its original block and is final.

Unchanged: signatures stay digest-bound and memory-only. Every proof, reorg recheck, unknown-outcome rule, void and
rearm rule, owner control, old grant and gas candidate literal is the same. Key bytes are never exported.

`rearmStep` is allowed while paused, because the replacement and gas windows will expire during the pause. Reconcile
and a page reload keep the pause, since it lives in the IndexedDB journal and not in memory.

## 2. Real blockers and remaining minimum work

1. **Pre-cutover `/funding/config` (intake-off staging).** `verifyRuntime` tolerates only `funding_disabled` and
   `relay_unreachable`. The running relay has no funding route, so `context()` fails with whatever status and code it
   returns.
   - **I could not pin that response:** the installed api/sessions source (sha `481f…` / `457e…`) is not in the tree
     I read, and I found no `unavailable` handler for this route.
   - **Truthful read-only option, no SDK change:** for the GET `/funding/config` call only, the site passes
     `verifyRuntime` a relay wrapper. When the response matches the exact root-pinned `(HTTP status, code)` of the old
     relay, the wrapper rethrows it as `RelayError("funding_disabled", "pre-cutover: running relay exposes no funding
     route (<status> <code>)")`.
   - The result is `intake: null` with an explicit `intakeWhy`, while the chain identities are still fully verified.
   - Every other response, and every POST, passes through unchanged.
   - Do **not** start the successor host for staging. It would be a second writer with the same signer.
2. **Site wiring, not implemented here.**
   - `state.nextSignable` must offer the whole plan in one batch in cutover mode: 1 + 2 + 2×2 = 7 wallet prompts.
   - The proposal or approval config must carry the reviewed `cutover` object, and it must be passed to `buildMigrationPlan`.
   - Add a paused render and a "Record activation" click. The click runs a fresh `verifyRuntime`, then
     `resumeCutover(stepCtx, planId, FUNDING_CUTOVER_ACTIVATION)` using static reviewed config, like
     `FUNDING_MIGRATION_APPROVAL`.
   - `runFlow` must map `r.paused`. Today it would show "Check status on chain".
   - These changes need their own pinned generator round and a browser re-qualification.
3. **Windows.**
   - The terminate review expires 600 s after the plan is built (`OWNER_OP_WINDOW`). Rearm terminate, which is
     allowed while it is planned, right before the signing session.
   - The pre-terminate signatures (900 s) are consent evidence for the exact `termsHash`. They are dropped after the
     run and will have expired by resume.
   - After resume, the owner re-arms and re-signs legacyOpen and the gas parts under the **same** `termsHash` and
     approval.
4. **Not a drain.** The pause proves only that the original's refund is canonical. Earlier admitted legacy-relay work
   (open, owner ops, attest, execute, keeper) can still land after nonce N. The legacy relayer's nonces must be
   stopped and reconciled by the controller (bootstrap-audit "stop-and-reconcile"). The SDK only binds the reviewed
   statement.

## 3. Safe sequence (actionable)

0. **Root prepares the reviewed documents.** These are the candidate terms approval, the activation plan (stop the
   old service, reconcile nonces, start the successor with writes fenced, then release) and the rollback plan. Hash
   both plans.
1. **Prepare (read-only, intake off).** Run `verifyRuntime` (chain identities) with the pre-cutover wrapper from §2.1,
   then `freshRecoveryScope` and `loadLegacyEvidence`. Then call `buildMigrationPlan({... split 24/4.8/1.2, cutover})`.
2. **Root reviews `termsHash`.** It covers the split, the gas candidate and the cutover hashes. Configure approval only
   if the activation plan, the successor build and the rollback plan are all ready. Otherwise stop here: the original
   stays untouched.
3. **Gateway.** Exact owner route gate on the old relay: only this owner's POST `/v1/sessions/owner` is allowed. Record
   the legacy relayer's baseline nonce.
4. **Owner signs, by click.** Rearm terminate if needed, then sign the full plan: terminate, the replacement grant
   with its EIP-3009 deposit, and both gas parts.
5. **Owner clicks Send.** Only the termination goes out. The proven exact refund is followed by a durable pause, and
   the 30 USDC is now in the owner's wallet.
6. **Controller.**
   - Stop the old service with stop, not restart, and confirm no process remains in its cgroup.
   - Reconcile every legacy relayer nonce above the baseline across providers. Any ambiguous nonce goes through an
     explicitly approved same-account neutral replacement, or manual recovery.
   - Start the qualified successor with writes fenced and the same signer, never a second writer. Release writes only
     after the reconciliation acknowledgment.
   - Confirm `/funding/config` is live and `open.enabled` is true.
7. **Root signs off activation evidence.** The record binds the plan, terms, terminate tx/block, activation-plan hash,
   relayer and reconciled nonce.
8. **Owner clicks "Record activation".** This runs a fresh `verifyRuntime`, then `resumeCutover`. There is no send.
9. **Owner finishes the plan.** Rearm and re-sign legacyOpen and the two gas parts, then click Send. Each step has its
   normal proofs. The active pointer moves only after the replacement is proven.

**Rollback (any failure at step 6 or 7):**
- The plan stays paused. The funds sit in the owner's own wallet; nothing is in flight.
- Restore the old image per the reviewed rollback plan.
- The paused plan cannot continue without activation evidence. A legacy-only reopen through the old relay needs a
  separately reviewed decision; this mode does not provide one.

**Invariants preserved:**
- The original never ends without a signed replacement and full plan.
- The original never ends unless activation, the new grant and rollback are reviewed into `termsHash`.
- There is no auto-send.
- Unknown outcomes keep blocking.

## 4. Root run instructions (not run by me)

```
python3 migration-cutover-prep-r1/generator/generate_cutover.py --link-viem
node --test migration-cutover-prep-r1/test/cutover-pause.test.mjs
```

- `--link-viem` expects viem 2.53.1, the version in the prior `GENERATED.json`.
- If `source/node_modules/viem` resolves to a different version, the generator refuses. Re-pin it deliberately.

**The tests were not run, and I make no claim that they pass.**

The 7 tests cover:
- the export and byte-identity diff against the qualified candidate;
- intake-off preparation, plus the non-cutover `intake_off` refusal still holding;
- `cutoverTerms` shape refusals;
- full-plan signatures required before terminate, with zero sends otherwise;
- termination being the only send, followed by the durable pause marker;
- reload, reconcile, re-sign and rearm all keeping the pause;
- resume refusals: activation shape, review, plan, terminate tx, activation hash, intake absent or off, relayer, stale
  runtime, reorg-lost proof. Then success, then `needsSignature` with no send.
