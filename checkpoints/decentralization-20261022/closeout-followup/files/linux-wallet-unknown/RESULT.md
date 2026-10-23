# Linux: hold on an UNKNOWN host wallet policy instead of releasing the lease (RESULT, 2026-10-23)

**Status:** a source candidate, committed locally. NOT built into an image, not deployed, not pushed or merged.
- No SSH, network, wallet or production action.
- main-repo, the A/B/C/E trees and installed software were only read (the live metal lineage was read once, for one
  bundle hash).
- Requirements read: `work/effective-goal-requirements.txt`, md5 `c66f26fc…`.

## 1. Candidate

| item | value |
|---|---|
| repo | `linux-wallet-unknown/candidate`: `git clone --local --no-hardlinks` of main-repo, branch `fix/linux-wallet-unknown-hold`, from **`2bbea8987ddc3d127c15e9709b5db2f867eae30d`**, origin removed |
| commit | **`09ff3ed553ba97f5fd5a880ab4197d3209a83d0a`**, tree `5ca835a2…`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `linux-wallet-unknown.patch` = `git diff 2bbea898 09ff3ed5`, sha256 **`f621fe4bb7c6ba95b4aa08caa34f295d952de560b39e5068b5962fbd44377084`** (3 files, +313/−24) |
| `supervisor.js` | `89ebb50a…` → **`2742f5355017819a19a2f9b18f49503707ee485776d30937037038c50a495ef6`** |
| `test/supervisor-wallet-unknown-hold.test.mjs` (new) | `59840e65ca20783cbcb015476077fdd1571bcb8ba3d8caec5db5400833a116f7` |
| `test/supervisor-wallet-policy.test.mjs` | → `712f6b64459a97d196cb9e963a4de1eda8b4e271ece25a25e2d39725f826ac38` (fixture moved to `decision()`; its pre-existing missing-global failure fixed) |

**Dependency closure:**
- `supervisor.js` only. No contract, bundle, Windows, network or installer change.
- The supervisor needs `windows/node/host-admission.bundle.mjs` **with `decision()`**: this tree's `3438cdf2`, or the
  installed Windows `6bef372d`.

## 2. Audit of the real Linux callers (base 89ebb50a)

`hostWalletRefusal` returned `"host wallet policy unavailable: …"` on ANY exception: no RPC quorum, an expired
snapshot, an unloadable policy, no identity. Every caller treated that string as a definite refusal:

| caller | base behaviour on UNKNOWN |
|---|---|
| `renewLeases` (60-s renewal clock) | `retireForPlacement`: stop + **prove + release the lease** |
| `auditClaims` (every pass, running/claimed records) | `retireForPlacement`: stop + **release** |
| `gateAppReference` (claim, resume, direct deploy, version switch, config fallback) | 403 `not_approved` |
| `switchTenantVersion` with a share resize | 403 is "structural", so `evict`: stop + **release** |
| `considerClaim`/`tryClaim` | declined at the gate (no release). But the claim tx went out after the prefetch (up to 300 s later) on the sweep's old decision, with no re-check |

**Effect:** an external RPC outage spent reserve gas on releases, handed leases back for re-claim, and refunded the tails.

## 3. Change (proved semantics)

- **`hostWalletDecision`:**
  - It uses the shared admission's `decision()` and returns `{refusal}`, `{unknown}`, or allowed until `validUntil`
    (the decision's own chain deadline, never extended).
  - The classification is the Windows one (`host.mjs #walletPolicyState`): "catalog app reference required" is the
    policy's own refusal; every other exception is unknown.
  - A bundle without `decision()` is unknown, with the explicit message "has no decision() (an older bundle…)". It is
    never read as allowed.
- **Definite refusal** (the host owner's policy, or platform moderation such as a catalog yank): **unchanged**, i.e.
  stop + prove + release (`retireForPlacement`). Administrator and owner bans keep their effect.
- **Unknown** (`walletHoldLocal`):
  - The tenant is stopped here exactly as a retire stops it (`stopContainer`, GPU slice freed). Linux has no Windows
    hold acknowledgement, so no VM is kept serving.
  - The record goes `terminated` with `walletHeld {since, why, stopConfirmed}`; `walletHeld` is set first, so any
    queued send sees it.
  - The lease is **kept**: no release, no renewal, no re-claim.
  - A held id is **excluded from `unresumedOwnLeases`**, which feeds both the guestd vouch beat and the reaper. An
    unconfirmed stop is therefore finished by the reconciler, never kept alive as "an unresumed own lease".
- **Held records** (`walletHeldReview`, every audit pass):
  - lease no longer ours or lapsed: the hold is dropped and nothing is sent;
  - owner `setActive(false)`, a pin elsewhere, or a definite refusal: `releaseLease`. There is **no final proof**:
    `proveFinalPeriod` proves "up to now" and nothing was served while held, so the pre-hold tail is forfeit (our cost);
  - unknown: stays held, and an unconfirmed stop is retried;
  - allowed: the hold clears, and the claim sweep's **existing resume path** serves it. That path runs every claim gate
    (wallet decision, catalog, isolation verdicts, capacity, boot fence, release holds) and sends no transaction.
- **`gateAppReference`:** unknown returns 503 `wallet_policy_unavailable`. The version switch therefore *defers*
  instead of evicting, and the direct deploy says "try again".
- **`tryClaim`:** a FRESH wallet decision after the prefetch, for claims and resumes. A refusal or unknown claims and
  resumes nothing.
- **Send-time gate:**
  - It covers every lease send on a wallet decision: renew, the lapsed re-claim in `renewLeases`, the audit's in-place
    re-acquire, and the `tryClaim` claim.
  - It is passed through `sendLeaseTx`/`sendOperatorTx` `opts.gate` and re-checked when the operator queue reaches the
    job, before anything is signed (operator-paid) or relayed (app-funded).
  - If the record was held meanwhile, or the decision passed its deadline, the send is rejected as `superseded`.
    `renewLeases` treats that as "decide afresh next round", with no 60-s failure backoff.
- **Unchanged:**
  - hosts without wallet policy: `validUntil = Infinity`, so the gate is a no-op;
  - the platform host-policy gate, floors, placement, owner and admin gates, and proofs of served time;
  - off-chain liveness (no new chain write), app-funded senders, contracts.

## 4. Tests (queue; offline: ssh/scp/sftp deny stubs, `unshare -rn --pid --fork --kill-child`, `--test-timeout`, `timeout -k`)

**How the new suite works:**
- It runs the REAL `supervisor.js` bodies of `renewLeases`, `auditClaims`, `switchTenantVersion`, `tryClaim`,
  `gateAppReference`, `retireForPlacement`, `sendLeaseTx`/`sendOperatorTx` and `unresumedOwnLeases`, in a vm.
- Behind them is the REAL shipped admission bundle (`createHostAdmission` on a scripted agreeing reader).
- Only chain and manager I/O at the edges is scripted.
- `SUPERVISOR_JS` points the same suite at another supervisor (the base, and the mutants).

| run | cap | result |
|---|---|---|
| `l1-512` (1) candidate (1a805a22): new suite + adapted suite | 512 | 11/13. Both failures were the TEST comparing vm-realm arrays (`[]` vs `[]`, same values); fixed with a spread |
| `l1-512` (2) **BASE CONTROL**: new suite on base supervisor 89ebb50a | 512 | **2/9: 7 FAIL** for the defect itself: `['stop','prove+release']` on unknown (audit, resize eviction), a `renew` signed past the decision deadline, no hold, no gate |
| `l1-512` (3) base: existing wallet-policy suite on the unmodified tree | 512 | 3/4: its pre-existing `HOST_POLICY_GATE is not defined` |
| `l1b-256` candidate: new suite | 256 | **9/9** |
| `l2-768` **mutants** of the fix, new suite against each | 768 | **5/5 killed**: M1 held id vouched (1 fail), M2 send gate `()=>null` (2), M3 unknown→403 (2), M4 held release proves (1), M5 no fresh claim re-check (1) |
| `l2-768` regression: 19 suites executing the changed code | 768 | **145/149**, peak 545 MiB. Suites: approval-gate, catalog-platform-enforcement, claim-open-for-us, claim-sweep, host-admission-retry, host-policy-callsites, instance-reconcile, instance-sweep, isolation-claim-gate, isolation-guest-pool, isolation-post-adoption-lease, isolation-release-ticket, ledger-move, owner-nomination (anvil, real `sendOperatorTx`), rate-cap, registry-advertise-retry, registry-reconcile, tenant-lease, tenant-provision-race. The 4 failures are all pre-existing (below) |
| `l3-768` (1) candidate FINAL bytes 2742f535 | 768 | **14/14** = the new suite 10/10 (including the older-bundle case) + the adapted suite 4/4 |
| `l3-768` (2) base: owner-nomination + tenant-provision-race | 768 | the SAME 2 failures, so they are pre-existing |
| `l4-scan-256` | 256 | `scan-crypto-keys --range 2bbea898..HEAD` 0; gitleaks 1 commit, no leaks |

**Pre-existing regression failures** (identical on the unmodified base, or already recorded on f58e03e):
- catalog-platform-enforcement: a Windows vm-slice SyntaxError;
- registry-reconcile: a "supervisor sends no heartbeat" source pin;
- tenant-provision-race "a delayed second claim": its harness lacks `releaseHold` for the unchanged `adopt()`;
- owner-nomination "a state file that cannot be written": chmod 0500 is not enforced for a mapped root under `unshare -r`.

**The 10 new cases:**
1. **Known allow:** the audit keeps serving; exactly one `renew` is sent.
2. **Explicit refusal**, by an administrator catalog yank and by a host-owner deny, on both audit and renewal: stop +
   prove + release, no hold, nothing renewed; the gate answers 403.
3. **Unknown transport failure** (reader "chain quorum unavailable"), on audit and renewal: `['stop']` only, nothing
   sent, terminated + `walletHeld`; the gate answers 503.
4. **Unknown never releases** through the resize eviction (deferred instead), and claims/resumes nothing in `tryClaim`.
   Control: allowed sends one claim.
5. **Repeated unknown passes** (6 audits, 5 renew rounds, unconfirmed stop): 0 releases, 0 sends, the stop retried every
   pass, the held id not vouched for.
6. **Expiry:**
   - a decision that lives about 200 ms, queued behind an in-flight transaction, is superseded with nothing signed and
     no backoff;
   - a held lease that lapses is dropped, nothing released, never re-claimed by the renewal path.
7. **Recovery:**
   - known-allowed: the hold clears, the id is vouched again, the resume gate passes, and `tryClaim(resume)` adopts
     with no transaction;
   - known-refused after the hold: `['stop','release']` (no proof), with the moderation refusal verbatim on the record.
8. **In-flight race** (app-funded and operator-paid senders): a renewal decided allowed waits in the queue, the audit
   then finds unknown and holds, and the renewal is superseded: 0 sends. Control: the same sponsored sender renews when
   nothing intervenes.
9. **Older bundle** (`refusal()` only): held as unknown with the explicit message, nothing sent or released, the gate
   answers 503.
10. **Source pins:** no `hostWalletRefusal` left; exactly 4 claim/renew sends, each with its gate; 6 `hostWalletDecision(`
    uses.

**Note on the final bytes:** the guard line for an older bundle (no `decision()`) was added after l2. The 19-suite
regression ran on 1a805a22, which differs from the final 2742f535 only by that guard. The guard runs only when
`decision()` is absent; the new and adapted suites were re-run on the final bytes (l3).

## 5. Limits (stated plainly)

- **No process-level run:** no Linux supervisor process on a real chain, no guestd, no metal image. The `sendLeaseTx`
  app-funded branch is tested with a stub sponsored sender.
- **Supervisor restart while held:** the terminal record and its `walletHeld` are restored as-is (records are persisted
  whole), but this was not run.
- **Residual race:** a renewal or claim already signed and broadcast before the hold cannot be recalled. The gate covers
  sends still in the queue.
- **New claims are held** while an own lease waits unresumed (the sweep's existing resume-first rule), for at most one
  unrenewed lease quantum.
- **Availability trade-off:** each unknown episode stops the tenant, and the resume relaunches it (for isolation
  guests, a fresh guest), so a flaky RPC set now causes downtime instead of releases. There is no grace period (as on
  Windows, where root rejects grace).
- **Not changed:**
  - Windows (the parity target);
  - the Windows/Linux difference that Linux has no network-side allow channel;
  - the live lineage's other differences.

## 6. Activation prerequisites and regression risks (root)

**Prerequisites:**
- **Ship the pair:** this `supervisor.js` with a bundle that has `decision()`.
  - **The live metal lineage `metal-deabf8f90` carries bundle `e83515fc` WITHOUT `decision()`** (read-only check), as does
    `work/enclave` (`7aeb5de9`).
  - Swapping only the supervisor there would hold EVERY wallet-gated tenant: fail-closed, but an outage.
  - `3438cdf2` (this tree) adds the 4 DigitalOcean mirror URLs; the installed Windows `6bef372d` has 0. Root picks the
    recipe.
- `supervisor.js` is a measured-image input, so activation means a rebuild and a new measurement (root's).
- Only hosts with wallet policy configured (`ENCLAVE_HOST_*`) change behaviour.

**Regression risks:**
- the 503 code for unknown at the gate; any client that keyed on 403 now sees 503;
- terminated + `walletHeld` records are visible in the deployment status (`error` text);
- the extra fresh wallet read in `tryClaim` (one admission decision per claim attempt).

## 7. Files

- `candidate/` (repo; untracked real node_modules copies for tests).
- `linux-wallet-unknown.patch`.
- `job.sh`, `job1.sh`–`job4.sh`, `q.sh`, `stubs/`.
- `tmp/mut/` (the 5 mutants), `tmp/base` (the unmodified 2bbea898 control copy).
- `logs/`.
- Progress: `../linux-wallet-unknown-progress.txt`.
