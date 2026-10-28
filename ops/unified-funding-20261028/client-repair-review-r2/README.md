# client-repair-r2 (UNREVIEWED · NOT RUN · NOT BUILT · NOTHING SIGNED · NOT PRODUCTION-READY)

Source only. I ran no command, test, build, network call, signing or deployment for anything here. Originals in
`../client-migration-r1`, `../client-r1` and `../../source` are untouched.

## Files changed in this pass

| Path | Change |
|---|---|
| `lib/chain-proof.mjs` | **new**: strict `canonicalReceipt`, separate `receiptFinality`, exact event proofs (`proveEnded`, `proveOpened`) |
| `lib/funding-client.mjs` | re-exports the new receipt check; `pinBlock` (freshness + hash recheck) used by `verifyRuntime` / `freshRecoveryScope`; scope env from `legacyVault.held(id)` on chain; gas open proven on chain; owner controls without intake/config |
| `lib/v2-store.mjs` | `casJournal` = get + mutate + put in ONE IndexedDB readwrite transaction (two-tab admission) |
| `lib/migration.mjs` | rewritten as a resumable, CAS-journaled step machine (see below); `maxRateHour6` mirrored |
| `site-patch/js/pages/funding.js` | owner controls render first and independently; resumable sign / run / reconcile / re-arm buttons |
| `root-receipt.test.mjs` | root's 6 cases unchanged + 12 new (missing metadata, removed log, unknown status, reorg, index, finality) |
| `test/offline.test.mjs` | scripted chain now mines realistic blocks/receipts/logs through the REAL `canonicalReceipt`; new recovery tests |

## Root findings → fixes

1. **Receipt binding.** `canonicalReceipt` now requires each of the following; anything malformed throws:
   - every receipt field is present;
   - a nonzero, valid block hash;
   - transaction-hash equality;
   - a nonzero, canonical-quantity block number, with the header number and hash matching it;
   - the transaction sits at its `transactionIndex` in that block;
   - status is exactly `0x1`/`0x0` (`0x0` → `tx_reverted`);
   - every log has the same tx/block/number/index, `removed === false`, and a unique valid `logIndex`.

   It returns `null` for an absent or pending receipt, a zero-hash preconfirmation, a header not visible yet, or a reorged block. `receiptFinality` is a separate later fact (it uses the `finalized` head); proofs record `final` but advance on canonical-at-observation unless `ctx.requireFinal`.
2. **`maxRateHour6`.** It is in `normState` and compared in `compareGrantToChain`. Only `label` and `preset` are unmirrored. The previous README was wrong.
3. **Resumable journal.** Per step the journal holds `planned → admitted → submitted → proven`, or `void` (re-armable).
   - **Contents.** It stores the UNSIGNED exact review: the Terminate message, the replacement grant JSON and the gas grant JSON, each with its digest and sid. Every rebuild re-hashes to that digest and is checked against the approved `terms`.
   - **Restart.** After a reload `signSteps` can re-sign only the NEXT unproven planned steps. Terminate is only signable together with its replacement, and `runMigration` refuses terminate without a signed replacement.
   - **Never resent.** Only `planned` steps are sent. An `admitted` or `submitted` step is never resent.
4. **Reconcile.** Reconcile handles an unfinished step as follows:
   - It proves the step by its txHash, or finds the step's own event via `eth_getLogs` when the reply was lost.
   - A canonically reverted transaction does not wedge reconcile: it falls through to the void check below.
   - It marks a step `void` only after the signed window closed AND the chain shows no effect: old session still live and untouched, or `authorizationState` unused and sid nonexistent.
   - It STOPs (`step_contradiction`) when the chain shows an effect it cannot prove, e.g. an old session that merely expired (`!live` is never refund proof).
5. **Exact proofs.** Each step advances only on these events:
   - **Terminate:** exactly one `SessionEnded(oldSid, reason 1, refund = full balance, fee 0)` plus a USDC `Transfer(vault→owner, refund)`.
   - **Opens:** exactly one `SessionOpened(sid, keyHash, expiresAt, actions, envs, budget)` plus USDC `AuthorizationUsed(owner, grantDigest)` plus `Transfer(owner→vault, amount)`.
   - **Replacement:** additionally `sessionOf` scope equality, including `maxRateHour6`.
   - **Gas open:** proven on chain, not from the relay's view.
6. **Adoption.** When the replacement is proven, by `run` or by reconcile even if the reply was lost:
   - the new SDK record is rebuilt from the journal using the original non-extractable CryptoKey by reference;
   - the old record is kept;
   - the active pointer moves only if it still names the old sid (or nothing).
7. **Two tabs.** Admission is a CAS on `(status === "planned" && digest === signed digest && previous steps proven)`. A re-armed digest also defeats a stale tab.
8. **No duplicate budget.** An open is re-armed only once its EIP-3009 `validBefore`/grant `signBefore` has passed and the authorization is still unused, so the old signature can never land.
9. **Stale evidence.**
   - **Freshness:** reads use one pinned block that is ≤ 120 s old and whose hash is rechecked at the end.
   - **Observed blocks:** they are stored per step (`observed`) and refreshed before every irreversible submission, never inside `terms`.
   - **Quotes:** they refuse a scope older than 120 s.
10. **Owner controls.**
    - **Inputs:** `controlsTarget(parseRuntimePins(pins), owner)` is offline. `endGasSession` needs only the stored record.
    - **Rendering:** controls render before, and independently of, intake, relay config, catalog and scope.
    - **Wire shapes:** they match `funding-route.mjs` (`/funding/owner`: owner, vault, op, args{…}, sig; `/funding/end`: vault, sid, deadline, x, y, r, s).
11. **Held shape.** It is no longer taken from the relay. The env of a legacy-vault-held record comes from `legacyVault.held(id)`.
12. **More than 8 apps.** This refuses with `byApp` and the remaining constraint (how many apps to drop); never `*`.

## Tests (written, NOT executed)

- **`root-receipt.test.mjs`:** 18 cases (root's 6 unchanged + 12 new).
- **`test/offline.test.mjs`:** 13 cases:
  - the original key, grant, quote, evidence and sign cases (the evidence case now also covers wrong key hash, expired old, `maxRateHour6` mismatch and expiring old);
  - full run with canonical proofs;
  - **pending + reload recovery** (never resent, adopts record + pointer, then the next step);
  - **lost reply** discovered from logs;
  - **refused → wait window → void → re-arm** with no duplicate budget;
  - **two-tab CAS**;
  - **wrong refund reason / wrong txHash / expiry is never done**;
  - **owner controls with intake off**.

These are scripted. They do not prove a wallet, browser IndexedDB (only `MemoryV2Store`'s CAS is exercised), the DOM, deployed contracts, live relays, the native HTTP path or production. Not covered: `verifyRuntime`, `freshRecoveryScope`, `pinBlock`, `legacyChain` (the JSON-RPC adapter), `confirmGasFund`.

## Unresolved (all block signing)

1. Root review and a real test run.
2. **Event signatures.**
   - Confirm that the successor `FundingSessionVault` `SessionOpened` signature is identical to the original's (`proveOpened` assumes it; its first line matches).
   - Confirm that Base USDC emits `AuthorizationUsed` and a single `Transfer` per `receiveWithAuthorization`.
3. **Finality policy.** Advancing at canonical-at-observation shortens the API gap; `requireFinal` is available if root prefers.
4. **Runtime and deployments.** Deployed runtime pins, enabled intake, and fresh resolution of the nine deployments to ≤ 8 apps.
5. **Legacy record.** The old session record must exist in this browser's `enclave-sessions` IndexedDB (otherwise STOP).
6. **Browser behaviour.**
   - Real IndexedDB CAS behaviour across tabs.
   - The bundle (`lib/browser-entry.mjs`) is unbuilt.
   - `prepare-expect.json` is still all `null`.
