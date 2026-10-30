# migration-cutover-site-r1: REPORT (source only, NOT run)

Status: **UNREVIEWED. Nothing was run, tested, built, signed, sent or deployed.** I used only Read/Grep/Write and wrote
only inside `migration-cutover-site-r1/`. `source/`, `production-grant-terms-r1/` and `migration-cutover-prep-r1/` are
unchanged. The original 30 USDC session is untouched. No activation or signature request was prepared. The production
proposal is not human-approved, and nothing here approves it. Prep-r1's REPORT §3 sequence (a selective owner gate,
neutral replacement) is **not** used and **not** implemented.

## Files written
- `generator/generate_site.py`: a pinned, reversible, anchored derivation.
  - **SDK.** Starts from `migration-cutover-prep-r1/candidate/sdk/funding`, with its 8 output hashes pinned and cross-checked
    against its GENERATED.json. Only `funding-client.mjs` is edited (4 edits). The other 7 modules are byte-identical,
    including the reviewed `migration.mjs`.
  - **Page.** Starts from `source/site/js/{pages/funding.js, funding/state.js, funding/flows.js}`, pinned to the
    client-execution-site-r2 INSTALL-MANIFEST sha256 values. **Root: re-hash `source/`**; the generator refuses on drift.
  - **Output.** Writes `candidate/` and refuses if it already exists. `--link-viem` adds one symlink, as prep-r1 did.
- `test/site-cutover.test.mjs`: 14 focused offline tests.
- `fixture/generate_fixture.py` and `generated/FIXTURE-GEN-PINS.json`: one actual-page browser fixture derived from the
  qualified production-grant-terms-r1 harness. The pins are **null placeholders with `rootConfirmed: false`**: root
  fills them, then the generator runs.

## Changes
**SDK (`verifyRuntime` only).**
- New: `PRE_FUNDING_API`, `isPreFundingApiReply`, and an optional `staging` argument (any other value fails with
  `staging_mode`).
- The opt-in matches only this reply to GET `/funding/config`: HTTP 404, body with exactly the keys
  `{"error":"no such sessions endpoint","code":"not_found"}`.
- On a match: `intake: null`, `intakeWhy: "not_found: no such sessions endpoint"`, and
  `intakeAbsent: {status: 404, code: "not_found", error}`.
- The reply is never relabelled `funding_disabled` and never treated as intake on.
- Unchanged:
  - Every chain pin is still checked first.
  - Without the opt-in, the same 404 throws `not_found` as before.
  - Every other error still throws.
  - The return shape is unchanged when there is no match.
  - POST, gas-send and `intake_off` preconditions are untouched.

**state.js** (append-only block):
- `validateCutover` binds the cutover config to the exact owner, chain and oldSid, plus 3 reviewed terms.
- `planMode` never moves a plan between modes: an existing unpaused plan, another owner's plan, or different hashes
  are refused.
- `cutoverView` mirrors the journal.
- `cutoverSignable` / `signableOf` decide what may be signed:
  - Before termination, only the whole 4-step / 7-prompt plan.
  - While paused or when the pause record is missing, nothing.
  - After activation, the normal rule, never across an admitted or unknown step.
- `nextSignable` is unchanged, so normal mode is unchanged.

**flows.js:**
- `cut` is threaded through `freshScopedPlan`, `signFlow` and `runFlow`; a mode mismatch fails with `plan_mode`.
- The guarded store now also refuses a change to `cutover.resumed` after a context switch. A termination outcome and
  its pause are still recorded.
- New `resumeFlow`. It:
  - requires a configured record;
  - runs a fresh `verifyRuntime` and requires the same `ctx.key` (owner, chain, vaults, relay);
  - re-checks scope, proposal, approval, mode and pause;
  - then calls the core `resumeCutover`.
  - It never signs or sends.

**funding.js:**
- `FUNDING_MIGRATION_CUTOVER` and `FUNDING_CUTOVER_ACTIVATION` are read through a namespace import of the **unchanged**
  `core/config.js`. Absent means null, which gives the old behavior.
- The opt-in is passed to `context()` only when the cutover config is valid for this owner and session. The
  execution-check `verifyRuntime` stays strict.
- Shows "The new funding service is not deployed yet (the server answered 404 not_found)". Owner controls are untouched.
- The reviewed `cut` is passed to `buildMigrationPlan`.
- Pause UI:
  - "Paused … $30.00 returned … tx …".
  - No "Prepare again" while paused.
  - A **Record activation** button, disabled without a record.
- `r.paused` gets its own toast.
- After activation, Sign and Send are explicit clicks. Reload, reconcile and rearm keep the pause (SDK journal).

## Root commands (exact, unrun)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028
sha256sum ../source/site/js/pages/funding.js ../source/site/js/funding/state.js ../source/site/js/funding/flows.js
python3 migration-cutover-site-r1/generator/generate_site.py --link-viem
node --test migration-cutover-site-r1/test/site-cutover.test.mjs
node --test migration-cutover-prep-r1/test/cutover-pause.test.mjs migration-cutover-prep-r1/test/root-cutover.test.mjs   # unchanged SDK pause
# fill generated/FIXTURE-GEN-PINS.json (sha256 of the 11 production-grant-terms-r1 inputs), set rootConfirmed true, then:
python3 migration-cutover-site-r1/fixture/generate_fixture.py
# then, as for production-grant-terms-r1:
#   build candidate/site/vendor/funding.js from candidate/sdk/funding/browser-entry.mjs
#   fill generated/BUILD-PINS.json and HARNESS-INPUTS.json
#   node migration-cutover-site-r1/build/build-harness.mjs
#   node migration-cutover-site-r1/out/server.mjs
```
Root browser order:
- `pStart`
- C1–C10: `cMode`, `cPrepare`, `cApprove`, `cTerminate`, `cReload`, `cPausedCheck`, `cBadAct`, `cNoApi`, `cActivate`,
  `cResign`
- `pReload`, `pRecover`, `pSwitch2`, `pComplete`, which now checks 19 prompts and the same 30 → 24/4.8/1.2 balances,
  same-key API and finite 8 + 2 apps
- the existing `pQuote` through `pNullCheck`, then `pCleanup`

Cleanup, hard timeouts, the prompt cap of 24, exact counters and the `/owner` / `/open` / `/funding/*` POST counts are
all kept. Silence is never treated as success: every step waits for a toast and checks the journal and the chain.

## Early source outputs
None. Nothing was executed. No hash in this report was computed by me except the copied pins.

## Limitations / open items
- **Match strength.** `relayClient` parses the JSON and does not expose the raw bytes or content-type. The match is on
  status, code, message and exact keys and values. A key-reordered or whitespace variant of the same JSON would also
  match.
- **Live deploy needs root's separate versioned vendor.**
  - The page keeps `import("/vendor/funding.js")`. The addon/composite step must point it at a new versioned bundle, as
    production-site-addon-r2 did with `funding.funding-r2.<hash>.js`. Never overwrite the global vendor or whole-deploy.
  - With the old vendor, `f.PRE_FUNDING_API` is undefined, so the check stays strict; `resumeCutover` would be missing.
  - esbuild may warn "import is undefined" for the two optional config names.
- **Signing windows.** The fixture assumes C2 → C10 completes inside the 600 s terminate window and the 900 s window
  for the other steps. The expired → "Prepare again" path after activation is unit-level only (`stepView` with
  `rearmOk`) and is not driven in the browser.
- **Not covered.** A lost termination reply and concurrent reload or admission, both required by ROOT-REVIEW before
  production. Phases 1–4 (pre-sign account switch) are not re-run here; that coverage comes from the earlier qualified run.
- **Fixture assumptions.**
  - `MAX_TICKS` headroom is unknown; this adds about 10 ticks.
  - The finality wait before C9 is 4 ticks; this is assumed from Anvil settings, not verified.
  - The activation record's `legacyRelayerReconciledThroughNonce: "0"` is a labelled TEST statement and not a drain proof.
- **Build-harness allowlist.** The new page path must appear in `BUILD-PINS`; root fills it. The facade config exports
  the two new names.
- **Not a drain proof.** Termination plus full signatures do not prove the old relayer has drained. The SDK records
  only the reviewed external activation evidence. The operational stop, nonce reconciliation and successor write
  quarantine remain the controller's.
