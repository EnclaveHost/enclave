# Operator durability repair r2 (source only, authored, NOT RUN)

Baseline: the exact frozen operator-durability r1 candidate (manifest `2ab1b702…f24c`, 238 files). Root's corrected boundary-v2 evidence (`evidence/root-operator-r1/root-boundary-v2.test.mjs`, 3 cases, 0 PASS / 3 FAIL) is the defect input. `REPORT-OPERATOR-DURABILITY-R1.md` and `RELEASE-CLOSURE-OPERATOR-DURABILITY-R1.json` stay unchanged as historical evidence.

**Nothing in this package was executed.** No tests, builds, module evaluation, shell, network, Git, signing or funds. Every test below is **authored, NOT RUN**. Root owns all hashes, runs, Windows/Base qualification and any production or financial action. This is source for review. It does not permit installation and does not claim the migration is complete.

## Mutation chronology (accurate order)

1. `control/windows/node/operator-effects.mjs`: header note, entry states, optional `leaseOutcome`, Windows path check, Linux continuity check.
2. `control/windows/node/chain.mjs`: `durableBlock` split into `writeBlock` plus the authorization part (`authTuple`, `authorizationObligations`, `authorizationsFenced`), then `releaseHold`, `leaseFinal` (owner/continuity/direct-write), `dischargeEntry`, `accountNonceGate`, `gatedLeaseAccount`, `gatedLeaseFetch`, `retained`/`retainedLease`, the `leaseSend` admission/op/`settleLease` changes, and `resolvePendingSponsored`.
3. `test/windows-permit/od-r1-sponsored.test.mjs`: fixture-input adaptation only (see §5).
4. New `test/windows-permit/od-r2-direct-continuity.test.mjs`.
5. New `test/windows-permit/helpers/od-r2-inert-chain.mjs`, then new `test/windows-permit/od-r2-shipped-client.test.mjs`.
6. This report and `RELEASE-CLOSURE-OPERATOR-DURABILITY-R2.json`.

Tests were written **after** the source. They were not authored first.

## 1. Final store continuity (not only lock liveness)

**Defect.** In r1, Linux `io.assertLive` called `h.assertLive()` plus `h.failed()`. In `owned-durable-state.mjs`, `assertLive` checks only release and the lock inode. The state-file identity check (inode/size/mtime against our last durable write) and the marker-presence check live in `check()`. `check()` was reached only through `h.store`/`h.state`. So `records()`, `get()` and the final `j.assertLive()` used cached memory and did not see deletion or replacement of the state or marker while the lock stayed held. That is root boundary-v2 cases 1–2: one inert write each.

**Fix (using the existing primitive, not a new weaker Boolean).**
- Linux `io.assertLive` is now `void h.state`. The getter runs the primitive's own `check()`: lock, durability latch, same state file as last written, marker present. A loss latches inside the primitive. `live()` then latches the store (`OperatorEffectsUncertain`, `uncertain:true`).
- `records()`, `get()`, `put()`, `remove()`, `status()` and the direct sender's final `check(); j.assertLive()` all go through `live()`. So every observable read or change, and the moment immediately before the wallet call, now checks continuity.
- Windows log backend: the held handle (`fstat`) cannot see path deletion or replacement under a TEST exclusion. `io.assertLive` now also requires the path to exist and to keep the inode/device it had at open (when the platform reports them). Under production `WINDOWS_EXCLUSION` (share mode 0), deletion and replacement are denied by the handle itself. Target qualification is pending. If attribute-only `stat` were refused on the target, the store refuses: it fails closed, never open.
- Nothing is rebuilt from process memory. A lost store stays refused after restart: a normal open refuses a missing state, a missing marker, or a marker without state, and creates nothing.
- **Exact known-unsent discharge is unchanged.** When storage is intact, the final-boundary refusal removes exactly that attempt. When storage was lost, the removal fails. The attempt stays recorded and the error says `notSent:true, pending:true, unsentRetained:true`, never cleared.

## 2. Account-nonce fencing in both directions

**Semantics.**
- **Account nonce vs lease nonce.** An EIP-7702 authorization signs `{chainId, delegate, nonce}`, and that `nonce` is the operator **account** nonce. The lease signature's `nonce` is the executor's per-deployment **lease** nonce lane. Lease signatures and POSTs without an authorization consume no account nonce. The relay is the transaction sender.
- **Obligations.** Direct `w:<nonce>` records (as in r1). Every sponsored authorization entry in state `signing`, `returned` or `withheld`, from **any** deployment id and any earlier process. `sign-threw` and `unsent` entries never produced a signature and are not exposures.
- **Unknown identity is held, never assigned.** An authorization whose recorded request lacks an exact integer nonce, names another chain (including `0`), was signed by another signer, or has no delegate address is UNKNOWN. It blocks every new direct send, and every new sponsored authorization, until settled by hand. It is never given the current identity or an invented expiry.
- **Fence.** Only the chain's **mined** (`latest`) account count passing the nonce fences an obligation. A pending count is never a fence. A mined nonce is never proof our operation succeeded. A lease deadline, a lease receipt, or the absence of lease signatures is never an authorization's expiry.

**Direct direction** (`durableBlock` → `writeBlock` + authorizations). After the r1/r12 write reconciliation, every known authorization with `nonce >= mined` blocks (`AmbiguousPriorWrite`, `notSent`, `pending`). Unknown ones block unconditionally. This is root boundary-v2 case 3.

**Sponsored direction.**
- **Admission.** Before any record or signature, `writeBlock` reconciles read-only. Any unresolved direct write refuses the whole operation (`AccountNoncePending`, `pending`, `notSent`): zero signatures, zero relay contact. The mined count is read when other authorizations exist.
- **`leaseFinal`, at every boundary.** Any direct write record refuses.
- **`accountNonceGate`, immediately before an authorization is signed.** It refuses unless the request names an exact tuple of this signer and no OTHER unresolved authorization of a DIFFERENT tuple holds a nonce `>=` the admitted mined count. An **identical** tuple is allowed. EIP-7702 signs exactly `{chainId, delegate, nonce}`, so it is the same account-nonce effect with no new exposure. It is also how the next sponsored operation consumes a held nonce. Without it, one withheld first-delegation authorization would stall every operator effect indefinitely.

**Records and resolution.**
- `retained()` now includes live authorizations. `resolvePendingSponsored` no longer settles an authorization-only record as `unsent` (r1 did).
- The lease part (receipt / lease-nonce fence / deadline) and the authorization part (mined account nonce) settle separately. A record is removed only when both are settled. If the lease part settles first, the record is kept with the new optional `leaseOutcome`. It then no longer holds the deployment id (`releaseHold`, same-id admission), but its authorization still fences the account nonce.
- The same rule applies to `leaseSend`'s own success (`settleLease("landed")`) and `NonceConsumed` paths.
- Read-only reconciliation runs while new effects are held. Records with confirmed evidence are settled, not stranded.
- Root's established `returned` authorization (posts 0, unknown external outcome) is held until the mined fence. It is never assumed undisclosed.

## 3. Sponsored final boundaries after durable recording

`leaseFinal(stage)` checks:
- latched refusal;
- live permission;
- (r2) `store.assertLive()`, i.e. owner + continuity;
- (r2) no direct write.

Every refusal is latched in `op.refused`. A restored Boolean never revives the operation or moves it to another relay. GETs to further relays are refused too. There is no operator-funds fallback.

| Boundary | Before | Durable plan | Re-check AFTER persistence (immediately before invocation) | After invocation |
|---|---|---|---|---|
| EIP-7702 authorization | `leaseFinal`, `accountNonceGate` | entry `signing` | refusal → **exactly this entry** → `unsent` (signer never invoked); failed mark → stays `signing`, `unsentRetained` | `leaseFinal` → record `returned` → `leaseFinal` again; a refusal at either point → `withheld` (never returned, so never POSTed); failed record → `signing` entry still holds the account nonce |
| lease signature | `leaseFinal` | entry `signing` | same → `unsent` | `leaseFinal` → record `returned`+signature → `leaseFinal` (handoff); refusal → `withheld` with the signature, `signedWithheld`; failed record → `signing`/`returned` entry still holds it |
| relay POST | `leaseFinal` | `posts++` (planned; a crash from here is an unknown outcome) | refusal → **exactly this** planned POST discharged (`posts--`, `refused` text); failed discharge → stays counted as possibly posted, `unsentRetained` | `op.posted = true`, the transport is invoked |

- Earlier POSTs, authorizations and signatures are never cleared.
- A signature returned while permission changes is withheld, with its complete identity: recorded signing domain, typed data, signer and signature.
- If persistence fails after signing, the signature is not returned and the intent stays.

`error.pending`, `notSent` and `unknownOutcome` are computed from the retained record, or `pending:true` when the store is unreadable. After a real POST: `notSent:false, unknownOutcome:true, pending:true`. Before any POST: `notSent:true` with `pending` from the record. `unsentRetained` is set when a discharge could not be recorded.

The r1 Host `#renewSend` pending-before-superseded order is unchanged (`host.mjs` not edited). No new Host caller assertion was authored in r2. That remains an open test gap from r1.

## 4. Actual shipped-client fixture

`od-r2-shipped-client.test.mjs` runs the actual `chain.mjs` → `configuredLeaseSender` from the **exact shipped** `lease-gas-runtime.bundle.mjs` (sha256 `159108d171e49cadf8a75dc8081df9e7213257e6f7930ac8b0f4f6e6e43b829d`, **not edited, not hooked, not wrapped**) → its real `createLeaseClient` → the actual owned store (genuine flock).

**Injected (external only):**
- the reviewed deployment record + digest via `ENCLAVE_LEASE_GAS_*`;
- `globalThis.fetch` = an in-memory dispatcher for three TEST RPC hosts and two TEST relays (`*.od-r2.test`). **Every other URL is refused: no live network by default.**
- chain.mjs's own `viem` imports = an inert TEST account (deterministic 65-byte signature bytes and an inert authorization object; no key) and inert direct-path public/wallet clients;
- a filesystem wrapper on the store that triggers a TEST revocation or marker loss **during the store's own write**.

Unrelated `host-admission.bundle.mjs`/`waf.mjs`/`verification-checkpoints.mjs` are stubbed as in root boundary-v2. No source seam was needed: chain.mjs already passes `fetchImpl` and `account` through `configuredLeaseSender`, and the bundle's RPC clients use the global `fetch`.

**Cases.** Each asserts exact signature, relay GET/POST and direct-write counts.
- Unchanged positive. `onSigned` and the planned POST are durable when the relay sees the POST: asserted from the relay side, with no fabricated callbacks.
- Permission revoked during the POST plan's persistence.
- Owner/marker lost during that persistence, then restart.
- Returned lease signature withheld when revoked during its result's persistence, then restart. A different deployment id re-signs the identical authorization tuple, lands, and is fenced. Then the direct positive. Then the deadline settles the withheld lease.
- An earlier POST (answer lost), then refusal. Then restart reconciliation by recorded identity (`resolveSigned` → `landed`).
- An unresolved direct write refuses a sponsored claim of another deployment before any contact, also after restart. A pending count is not a fence. The exact mined fence then admits it.

**Caveat.** The in-memory chain follows the **readonly reference** client (sha256 `21fece1f…`, a newer build; `provenance.json` lists the conflicts). Count probes confirm that the shipped bundle contains the same structural features (`nonceSettleMs`, `delegationCodeHash`, `admitPinnedRelay`, `consumedRecheckMs`, `enclave-lease-gas-deployment/v1`). That is not version equivalence. A shape difference will appear as a fixture failure, to be adapted in the helper, never in the bundle. Runtime dependency: npm `viem` (helper only) and Node's global `Response`.

## 5. Tests (all authored, NOT RUN)

- `od-r2-direct-continuity.test.mjs` covers:
  - root boundary-v2 cases 1–2 (state/marker deleted at the final gate → 0 writes, latched, retained, restart refuses, nothing re-created);
  - state file replaced (same bytes, new inode);
  - store-level cached `records`/`get`/`assertLive`/`remove` after loss;
  - exact discharge with intact storage and an unchanged positive at the same nonce;
  - root case 3 (held authorization at account nonce 70 after owner release + fresh process; another deployment id and another function; pending 71 ≠ fence; restart; mined 71 → unchanged positive; resolver settles only after the fence);
  - unknown chain/signer → held past its nonce; `sign-threw`/`unsent` → no exposure.
- `od-r2-shipped-client.test.mjs`: the six cases in §4.
- **r1 preservation.** All 18 r1 tests are kept. No case was deleted or skipped, and no assertion was weakened or replaced.
  - `od-r1-sponsored.test.mjs` needed one **fixture-input** adaptation. Its emulator signs a constant authorization at account nonce 3, while its TEST RPC answered a mined count of 0 (r1 never read it). Under the required r2 semantics, that authorization would hold the account nonce, so the r1 "deadline settles", "landed settles" and "positive settles" assertions would fail for an inconsistent TEST chain, not for the behaviour they test. The TEST RPC now answers `S.mined` (rig default 4), and every r1 assertion is byte-unchanged. The authorization-holding semantics are asserted in the r2 files.
  - The other r1 files are untouched. Read statically, their expectations still hold: `od-r1-direct-sender` has no sponsored records, and the store tests delete files only after release. Root must confirm by running them.
- Earlier consuming/Stop/transport tests are untouched (they stub `chain.mjs`).

## 6. Preserved root repairs (not edited)

- `control/isolation/m4/guestd/control-client.mjs` `beforeSend` at the actual transport, including reauth/reconciliation;
- `control/windows/node/protected-isolation.mjs` owner/policy last-send checks;
- `control/windows/node/protected-supervisor.mjs` appId/index projection.

Their closure hashes (`df77d6db…`, `bfbab051…`, `1cd9be05…`) are expected unchanged. Root verifies them.

## 7. Dependencies and closure

- Static import edges are unchanged: `chain.mjs` and `operator-effects.mjs` gained no imports, and the bundle is untouched.
- New test-only files: `helpers/od-r2-inert-chain.mjs` (imports npm `viem`; ABI fragments transcribed from the readonly reference with provenance in its header). The tests import only candidate files, `node:*` and npm `viem` (via the helper).
- Root's former npm input-hash match is not a full build/lock qualification. `npm ci` against `package-lock.json` remains root's.

## 8. Remaining gates: explicit blockers, not this pass

**Windows installation/runtime.** Not solved here, and nothing was executed or installed:
- `agent.mjs` does not pass `operatorEffects` storage/SDDL context to the Host, and there is no explicit installer step that runs `initialize-operator-effects.mjs` for the deployed store.
- The pinned Windows Node runtime lacks a default `UV_FS_O_EXLOCK` exclusive open. `WINDOWS_EXCLUSION` needs a supported, reviewed exclusion and its qualification. No in-process substitute lock is production.

**Minimal wiring still required (later, reviewed):**
- (a) installer: create the store directory with the reviewed SDDL, then run the explicit initializer once (never on a missing-file open);
- (b) `agent.mjs` → Host `cfg.operatorEffects = { storage: { run, sddl, parentSddl }, exclusion }`;
- (c) the qualified exclusion in the runtime.

**Target validation still required:**
- Native ACL/fixed-NTFS checks; cross-process exclusion; power loss; deletion/replacement denial under share mode 0; attribute-only `stat` under the held handle.
- Guard/restart; useful-workload acceptance.
- Base/mainnet qualification of the shipped client against real relays.

**Also still open:**
- Explicit store maintenance/compaction.
- Manual settlement of UNKNOWN authorizations or posted-without-intent records.
- Host `#renewSend` caller assertions.
- Native/full-workload items.

Production frontend Top-up, edges, site and funding were not touched. Deployment/production configs were not modified.
