# Operator durability repair r1 — SOURCE ONLY, AUTHORED, NOT RUN

Nothing here was executed: no tests, builds, module evaluation, shell, network, Git, signing, Windows or production action. All claims below are about authored source and authored tests. Root owns hashes, test runs, builds, Windows/Base qualification and any production or financial action.

## Scope

This is a narrow repair. It covers operator-effect durability and the direct and sponsored paths in `chain.mjs` that consume it, plus their Host callers. It does not touch root's three repairs (`protected-supervisor.mjs` appId/index projection, `control-client.mjs` `beforeSend`, `protected-isolation.mjs` last-send owner/policy check). None of those files were edited. Native and full-workload work, platform migration, and other unrelated items are still unfinished (see the last section).

## 1. Owned platform storage and explicit establishment

**New `control/windows/node/operator-effects.mjs`.** It replaces `operator-obligations.mjs` for `chain.mjs`. That file is no longer imported but is left unchanged. The new module provides one store per operator domain `{account, chainId}`. Direct writes and sponsored claim/renew/release obligations share it, under one physical owner. It is built on the reviewed primitives:

- **`windows-owned-log`** (win32): `win-durable.mjs` `openOwnedLog` with purpose `enclave-operator-effects/1`.
  - Default exclusion is `WINDOWS_EXCLUSION`. A root-qualified `windowsNumericExclusion` can be passed via `cfg.operatorEffects.exclusion`.
  - `checkWindowsStorage` (ACL/NTFS/fixed volume) is required before the open. A missing storage context refuses.
  - Writes are append-only hash-chained `operator-effect` events (put/remove). They use win-durable's full-write loop, flush and failure latch.
  - No rename or directory-sync guarantee is assumed on Windows.
- **`linux-owned-state`** (linux): `owned-durable-state.mjs` `openOwnedLock` (a genuine flock on `<file>.lock`) plus `openDurableState`.
  - Uses `established:true, expectExisting:true` with retained intent/commit/marker/history.
  - Owned boot verification is required (`verification()` must be non-null). `owner:null` is never used.
- **`TEST_inProcessExclusion`** is accepted only as an injected option. `status()` then reports `production:false` and "NOT production, NOT cross-process".
- Any other platform refuses. It is never treated as success.

**Explicit establishment.**
- `initializeOperatorEffects()` and the CLI `control/windows/node/initialize-operator-effects.mjs` are a separate install/migration step. The Host never runs them.
- They refuse an existing store or leftover evidence. They also refuse while r12 legacy `operator-writes.json` / `sponsored-obligations.json` still hold records, so nothing is migrated silently.
- A normal open refuses a store that is absent, foreign-purpose, foreign-domain, torn, quarantined, uncertain (intent without matching ack, or an unproven final sync) or malformed. This applies after restart too.
- An open is attempted once per process. A refused open stays refused, and nothing is re-created.

**Ownership on every use.**
- `records/get/put/remove` call `assertLive` (win-durable handle `fstat` / torn check; flock capability and lock-inode check).
- Any loss or I/O failure latches the store with code `OperatorEffectsUncertain`. After that, every read and change refuses, and on-disk records stay for the next owner.
- `releaseOperatorEffects()` fences new effects, waits for the serialized queue, then releases ownership. It never deletes records.

**Records.**
- Records are strictly validated: exact domain (no current-account fallback), exact key, safe integers, enumerated states, and only the allowed fields.
- A direct record holds the **complete** canonical request plus its sha256. The bound is 16 KiB; a larger request is refused before any effect and never truncated (the r12 2048-char truncation is gone).
- A sponsored record holds recorded bindings, authorization/signing entries (canonical exact request, signer, state, signature), canonical signed intents, and a POST count.
- Bounds: 64 unresolved records, 6 entries per list, 48 KiB per record, 7 MiB admission and 8 MiB hard, with 2 KiB of settlement space reserved per open record.
- A full store refuses new records, but settlement still works. Nothing unresolved is deleted to make room, a torn log is never truncated, and there is no automatic compaction.

## 2. Direct path: when an effect is known-unsent and when it is unknown

`send()` works as follows:

1. Gate check.
2. Owned open, with every reconcilable prior write settled from the chain (a receipt, or a mined nonce used as a fence that is never claimed as success).
3. Simulate, then read the nonce.
4. Persist the exact `sending` record (owned and flushed).
5. **Final boundary:** live gate plus live owner.
6. `writeContract`.

| Situation | Classification | Record |
|---|---|---|
| Refused at the queue, simulation, nonce read or reconciliation | unsent | none |
| Record write failed before landing | unsent (`NotPersisted`) | none |
| Record write failed with an uncertain landing | unsent this time, store latched, `pending:true` | possibly landed: fences that nonce after restart |
| **Final-boundary refusal after the record was persisted** (gate or owner) | **provably unsent** | **only this exact attempt is removed** (`unsent: refused at the final boundary`). If the removal fails, the record is kept as `unsentRetained`, never as an unknown broadcast. Earlier records are never touched. |
| `writeContract` threw, response lost, process died, or durability ack failed after the effect | **unknown** | kept (`unknown`/`sending`/`sent`). Never resent, replaced or re-nonced. |

An unchanged pending count is not treated as absence. The transient retry happens only before the write, and only after re-checking the gate.

## 3. Sponsored obligations and pending status

**Recorded before each step.** In the gated account and fetch, every step of an admitted operation is recorded before it happens:
- the EIP-7702 authorization request;
- the exact lease typed data (domain name/version/chainId/verifyingContract, primaryType, types, message: reserve/nonce/deadline/…) and the signer;
- each POST (`posts++`).

**What happens to results:**
- A signature is recorded as `returned` before it is handed to the client.
- If permission ends during signing, it is recorded `withheld` with the signature, and the refusal is latched. A later restored Boolean permission cannot revive it, and it falls through to no other relay.
- If a record write fails, that step is refused and the refusal latched (no signature or POST follows).
- If the withheld-result write itself fails, the earlier `signing` entry still holds the operation to its recorded deadline.

**`error.pending`** is computed from the owned record (signing/withheld/signed/posted). It is no longer computed only from old release-journal intents.

**Old/new journal reconciliation (explicit):**
- No `onSigned` call or legacy intent is fabricated.
- A legacy release entry is settled `unsent` only once the owned store is readable and holds no unresolved release of that id.
- Otherwise the legacy entry stays open, so `releaseHold` keeps holding.

**Resolution, read-only, using recorded identity:**
- Intents go through `resolveSigned` with the intent's recorded operator/chain/reserve/executor/ledger. If the recorded identity is incomplete, the record is held.
- Signatures that were never disclosed are fenced only when the chain head on the recorded signing-domain chain is past every recorded message deadline.
- A record that was POSTed but has no intent is held.
- The record of the operation in flight is never touched. This fixes a race in r12, whose resolver could remove an in-flight `begun` record.

**`releaseHold`** also covers unresolved owned records. With sponsorship configured, an owner that is not open or live also holds (and starts the open).

**Host callers:**
- `#renewSend`: pending, unknown, `notSent:false` and `sent` now take precedence over `superseded`. Only a provably-unsent superseded refusal returns `{superseded}`; everything else is recorded and rethrown.
- Claim failure: a possibly-executed claim is labelled "outcome unresolved".
- Release: the caller is unchanged; it already holds on `pending`.
- No operator-funds fallback was added.

## 4. Wiring

- `chain.mjs` imports `./operator-effects.mjs`, which imports `../vbslike/manager/win-durable.mjs` and `../../network/owned-durable-state.mjs` (→ `runtime-lock.mjs`). `chain.mjs` no longer imports `operator-obligations.mjs`.
- New `chain.mjs` exports: `setOperatorEffects`, `operatorEffectsStatus`, `releaseOperatorEffects`.
- Removed: `setOperatorWriteJournal`, `setSponsoredObligations`, and the env vars `ENCLAVE_OPERATOR_WRITE_JOURNAL` / `ENCLAVE_SPONSORED_OBLIGATIONS`. The new env var is `ENCLAVE_OPERATOR_EFFECTS`.
- `ambiguousOperatorWrite`, `sponsoredObligations` and `withheldLeaseSignatures` now read the open owned store, and throw when it is not open.
- `host.mjs` constructor: `chain.setOperatorEffects?.(<dir>/operator-effects.journal, cfg.operatorEffects ?? {})`.
- `agent.mjs` was **not** changed. It passes no `operatorEffects` storage context, so on win32 every operator effect refuses until root wires storage/SDDL and installs the store. Separately, `WINDOWS_EXCLUSION` refuses on the pinned deployed runtime (`UV_FS_O_EXLOCK` is absent, per `win-exclusion.mjs`). **Result: as authored, a deployed Windows node makes no operator writes or sponsored lease operations.** This is fail-closed and is a deployment blocker until root qualifies EXLOCK and installs the store.

## 5. Authored tests (NOT RUN)

All tests are under `test/windows-permit/`. They use inert TEST account/RPC/wallet/HTTP only. Failures are injected through external TEST `fsImpl` wrappers (the primitives' own injection point) and TEST file operations. No function under test is patched.

- **`od-r1-operator-effects-store.test.mjs`**
  - Windows-log logic under the TEST exclusion (labelled): explicit init, absent-is-not-first-use, re-init refusal, second owner, reopen replay, foreign domain/chain, foreign record event, torn tail kept byte-exact, legacy-records init refusal, short-write latch, full-store/settlement, oversized request.
  - Linux genuine flock: in-process second owner, and a **separate child process** (`helpers/od-r1-owner-child.mjs`) refused while held then succeeding after release; re-init refusal; foreign domain; fsync failure after the intent landed → latched → refuses on reopen (uncertain); deleted state, and deleted state plus evidence, refuse and are not re-created.
- **`od-r1-direct-sender.test.mjs`** (actual `chain.mjs` with the Linux owner)
  - Unconfigured store; never-initialized store (nothing created).
  - Uncertain write → same module refuses → second owner refused → restart refuses → full request recorded → mined fence → new nonce.
  - **Root gap 1:** deleting the established store → a fresh process refuses with no second write.
  - **Root gap 2:** final post-persist refusal → 0 writes, durable exact discharge, then an unchanged-permission positive at the same nonce after restart.
  - A later refusal does not discharge an earlier record.
  - Lock-inode replacement latches with the record kept.
  - Foreign-domain store; fsync failure before the effect → latched → no write, also after restart.
- **`od-r1-sponsored.test.mjs`** (actual `chain.mjs` and owned store, with a **TEST lease-client emulator**; this is not exact-client qualification)
  - Release signature-time refusal → `pending:true` from the owned record with the recorded domain and signature, the legacy entry kept (not settled unsent), the hold present, and a deadline fence that settles both.
  - Latched supersession.
  - Earlier POST then refusal → unknown; it survives restart and holds the id; it resolves by recorded identity.
  - Queue-entry refusal signs nothing; a positive operation settles its record; an uninitialized store refuses before signing.

**Superseded fixtures.** These target the removed JSON store or setters and are expected to fail against this source. They are retained unchanged as historical evidence, and root decides on retirement:
- `test/windows-permit/r12-durable-send-restart.test.mjs`
- `evidence/root-r12/root-durable-gaps.test.mjs`
- the r11 direct/sponsored sections of `r11-policy-send-boundary.test.mjs` and `evidence/root-r12/root-r11-fixture.test.mjs`

The root fixtureclosure assertion (legacy intent length 1) stays **unresolved**. The intended behaviour is now asserted differently (pending from the owned record, legacy entry kept) and needs root qualification. It is not converted into a pass.

**Unchanged successful scope.** Neither consumer test (`r12-real-consumer`, `r10-host-independence`) loads the real `chain.mjs` (both stub it), and Host uses optional `setOperatorEffects?.`. So the passing consumer/transport/Stop runs are not expected to change. Root must re-run them to confirm.

## 6. Remaining and unfinished

- **Exact client:** the sponsored claims need the shipped `lease-gas-runtime.bundle.mjs` (or the regenerated namespaced source closure) driven with external TEST account/RPC/HTTP. No bundle or client source was edited, and no source-equivalence is claimed.
- **Platform qualification:**
  - Windows EXLOCK cross-process behaviour and power loss on the pinned runtime.
  - `checkWindowsStorage` SDDL configuration and install-script integration for this store.
  - Linux flock tests are authored but not run.
- **Not implemented:**
  - Explicit owned recovery of an uncertain Linux store (`openDurableState().recover()` exists but is not wired).
  - Windows torn-tail quarantine/reconciliation for this store.
  - Explicit capacity maintenance/compaction. The 7 MiB admission bound will eventually refuse new effects on a long-running node.
- **Not handled:** interplay between operator nonces consumed by EIP-7702 authorizations and direct writes.
- **No test written:** Host `#renewSend` and claim diagnostics.
- **Unrelated work still open:** native/full workloads, neighbor qualification, config/version closure, independent live authority, zero-gas bootstrap, Offline/independent submitter, refill/Top-up, production migration.

## Chronology (actual mutation order)

1. Source: new `operator-effects.mjs`, then `chain.mjs` edits (import, owned accessor, direct sender, sponsored signer/fetch, `leaseSend`, resolvers, `releaseHold`), then `host.mjs` (wiring, `#renewSend`, claim reason), then `initialize-operator-effects.mjs`.
2. Tests: child helper, store test (plus two fsync-injection corrections), direct-sender test (plus a title correction), sponsored test.
3. Late source corrections: the `leaseSend` open-failure `pending` flag, and `MAX_REQUEST_BYTES` 4096 → 16384 (with the matching store-test bound).
4. This report and the closure manifest.

Tests were **not** authored first.
