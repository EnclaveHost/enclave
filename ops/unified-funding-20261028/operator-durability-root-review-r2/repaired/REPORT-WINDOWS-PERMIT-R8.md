# Windows permit r8: owner-loss completion and production authority entry

SOURCE ONLY. **Nothing was executed:** no tests, builds, network, Git, hosts or financial actions. Every test below was written but not run. The
root executed evidence (evidence/root-r7) is quoted only as the record of past failures. None of it covers r8 code.

## 0. Separation of evidence

| Kind | What |
|---|---|
| Root executed (r7, unchanged, read-only) | focused 38/39 PASS; corrected composite PASS; permit owner-release 2 FAIL (delivered, lost+reconciled); unknown-stage owner-loss 1 FAIL (`staged`, not `removed`) |
| r8 source (this pass) | sections 1-4 |
| r8 tests (written, not run) | section 5 |
| Unfinished | section 6 |

## 1. Priority 1: permit owner loss on every return path (`control/windows/node/protected-isolation.mjs`)

- **The failure.** `permit()` checked `store.assertLive` only before the awaited POST. Both usable exits (delivered 200, and the lost reply reconciled from the MAC'd view) returned `serving` after the root released the obligation log.
- **The fix.** A new `#ownerAfterAwait()` re-proves the physical owner after each await:
  - after the POST, whatever its status;
  - after a lost outcome;
  - after the reconciling `view()`.
- **What happens on loss.** The client latches `ownerLost` and calls `onOwnerLost`, which makes the supervisor run `gate.close()`. If the permit may have executed, the client starts `#retireExact` for the exact deployment, instance and manager/launch epochs. The caller gets `unavailable` with `ownerLost:true`, never `serving`.
- **How `#retireExact` retires an instance:**
  - It checks the MAC'd view first and never removes a record that is not exactly ours.
  - It sends a bounded destructive `hold`, which withdraws ingress, streams and secrets at the manager.
  - It sends the exact-id `DELETE` whatever the hold answered, so a hung relay or boundary acknowledgment cannot delay compute removal.
  - Only a complete MAC'd inventory with no live record counts as absence.
  - The entry stays in `this.retirements` until absence is confirmed. Each step is bounded (`cleanupStepMs`). Retries come from `reconcileOrphans()` and from the client's own unref'd timer (`cleanupRetryMs`), so cleanup does not depend on new-work admission or on someone calling reconcile.
- **Two distinct owners.** The node obligation owner (`protected-obligations.log`) and the serving-permit owner (the gate's permit journal on the node, or the manager's permit journal) are different handles. Losing the obligation owner is enough to withdraw. The regression test asserts that the manager's permit log is still live while withdrawal happens.
- **Preserved behaviour:**
  - A valid owner still gets a delivered or reconciled `serving` result. Positive control tests cover this.
  - Exact identity, digest, epoch and deadline checks are unchanged (`servingMatches`, the 200-body binding).
  - Lower-sequence replay handling is unchanged (gate and enforcement untouched).
  - No caller-supplied "qualified" flag was added.
- **Late completion.** A permit whose owner was lost elsewhere while it was in flight hits the same post-await check.

## 2. Priority 2: unknown raw stage during owner loss

- **The failure.** A stage whose reply was lost has no `instanceId`, so it never entered `retirements`. After owner loss the supervisor only called `reconcileOrphans`, which skipped it.
- **The fix.** `reconcileOrphans()` now also walks every `unknownStages` entry that has neither a retirement nor a terminal proof:
  - It reads the exact authenticated operation outcome (`GET /protected/operations/:op`) and checks that the deployment matches.
  - `unseen` → durable manager-side `cancel`. The router and manager then refuse the late original (r5 semantics).
  - `executed` → `#retireExact` of the exact instance, cross-checked against any recorded `instanceId`.
  - `in-progress` or unreadable → kept and retried.
- **No shortcuts.** There is no blind resend, no "absent because time passed", and no empty-inventory discharge.
- **Terminal proofs stay in memory.** They go into `ownerLossProofs`. The durable pre-send record is not discharged, because the handle is no longer the owner. `outstanding()` reports:
  - `retiring`: instances not yet confirmed absent;
  - `unresolved`: unknown operations without terminal proof;
  - `durableUndischarged`: records only a cold owner can discharge.
- **Supervisor output.** The supervisor prints these three counts in its `held` reason. It never reports zero outstanding work while any remain.
- **Cold reopen.** The existing owner-live `resolveUnknown()` re-resolves the pre-send record from the manager and discharges it durably. After owner loss, `resolveUnknown()` hands off to cleanup instead of failing a `#save`.
- **Other paths now covered:** transport failure, malformed 202 (the pre-send record remains), and a late 202 after loss (now goes through `#retireExact`).
- **Unchanged:** the accepted-202 owner-loss and cold-recovery paths.
- **Supervisor change (`protected-supervisor.mjs`).** The owner-loss branch runs cleanup first and waits on `gate.close()` for at most 1 s, so a hung withdrawal reports "in progress" instead of blocking the pass.

## 3. Production authority factory and entry (new `control/windows/node/protected-authority-factory.mjs`, edited `agent.mjs`)

**Before r8**, nothing in production set `composition.hostId`, `composition.openRuntime` or `composition.collect`.

**Now**, the node entry `agent.mjs` calls `composeProtectedAuthority({ hostId: host.enclaveId })` right after `new Host`. The chain from there:

1. **Pinned config.** `ENCLAVE_PROTECTED_AUTHORITY` + `_SHA256` (absolute path).
   - Exact keys only.
   - Forbidden capability names are refused at any depth: signer, relay, approvals, funding, payee, `enclaveEndpoint`, administrator, `catalogVeto`.
   - The config's host must equal the verified `enclaveId`.
   - Pins and adapter pins are hash-pinned JSON. Base 8453 and v2 host-authority permit pins are required.
2. **Authentic read-only chain evidence.**
   - r18 `createLifecycleChainAdapter` is built with no `actorSigner`, `approvals` or `relay`, and with refusing receipt sources. Its `submit` refuses before any signing.
   - It sits on r18 `createLifecycleFinalitySnapshot`, which takes:
     - the owner-selected derived-proof anchor reader: a self-contained module verified by sha256 and imported from its exact bytes;
     - the configured local verifier;
     - the owned anchor journal (`readAnchor`/`acceptAnchor` of the owned lifecycle journal, bound late, refusing until owned).
   - The supervisor only ever sees `readOnlyChainReader(adapter)`, which exposes just `{read}`.
3. **Owned factory.** r18 `openOwnedHostRegistryLifecycle` opens:
   - the parent journal flock and the incarnation and permit sidecars;
   - the v2 gate and runtime (candidate copies);
   - the bindings to the client's `runtimeAdapters`, through a late-bound gate view.

   It refuses to open a second owner in the same process. The r18 dispatch cadence is stopped at once: this node never submits transitions, and the supervisor is the single driver. The owner lifecycle (`release`, lock-loss withdrawal) is the r18 one and is returned to the caller.
4. **Witnesses.** r18 `createPermitCollector` uses the host operator's permit key. It refuses if that key's address equals the adapter's payee.
5. **Snapshot.** `protectedSnapshotOf()` sets:
   - `assignment.deployment` from the authenticated snapshot id;
   - `assignment.proofVerified` only when the adapter's own `verified`, `proofVerified` and tier `l1-finalized-derived` all hold;
   - `servingContext` from r18 `servingContextOf`.

   The existing supervisor `#withdrawalOf` then applies:
   - independent Online is not vetoed by Enclave catalog or administrator signals;
   - canonical Offline revokes;
   - an assignment moved to another host withdraws;
   - unverified or stale evidence fences and never invents Offline;
   - Stop and Offline bypass the capability and new-work admission.

**Failure modes.**
- No enrollment: legacy everywhere, unchanged.
- Enrollment without authority config: `hostId` is set and enrolled deployments are held.
- Missing r18 modules or owned locks: held. There is no legacy fallback.

**Not wired.** No signal hook was added. The existing SIGINT handler exits immediately, and a SIGTERM listener would suppress default termination. Graceful `release()` on shutdown is therefore not wired. On process exit the OS drops the flocks, and serving stops at the manager-enforced permit deadline.

## 4. Provenance correction

The r7 composite header and REPORT-R7 §2 said the composite was "written first". The root mutation audit contradicts this: the runtime, supervisor and client edits came first, then the withdrawal and owner tests, then the composite.
- The candidate test header is corrected.
- REPORT-R7 §2 now carries a correction note.
- The immutable evidence is untouched.

## 5. Tests (written, not run)

- **`r8-permit-owner-loss.test.mjs`**
  - The root actual-HTTP regression is carried verbatim: delivered and lost+reconciled, with the release after the manager processed the permit.
  - Added checks:
    - the client latches the loss;
    - the manager's permit owner is still live (a distinct handle);
    - the retirement entry is exact;
    - the manager journal shows `removed`, and the TEST inventory and manager both show the instance absent;
    - a splice with the retained identity gets no `OK`;
    - no new stage or permit is accepted.
  - Plus two positive controls with the owner kept: delivered, and reconciled serving with no extended deadline.
- **`r8-unknown-owner-loss.test.mjs`** (root world verbatim apart from imports)
  - A. The root case is carried verbatim, then strengthened: outstanding accounting, the `held` reason, and a cold owner discharging the record durably from the manager outcome.
  - B. Unseen operation: cancelled after owner loss; the late original is not 202; nothing staged.
  - C. Hung boundary `hold` during retirement: compute is still removed.
- **`r7-composite.test.mjs`**: now the root-corrected composite (gate-journal sequence, router `dataServer` TCP) with portable imports. Positive assertions are unchanged.
- **`r8-authority-factory.test.mjs`** (TEST r18 module doubles, labelled)
  - config refusals: unknown fields, forbidden capability, wrong host, hash drift;
  - the reader is read-only;
  - proof qualification comes only from adapter fields, and RPC tiers are not qualified;
  - entry composition: adapter built with no signer/approvals/relay, the owned lifecycle bound to the client adapters, dispatch stopped, no second owner, wrong host refused;
  - the actual `ProtectedSupervisor` over factory snapshots: Online despite an Enclave catalog refusal, Offline revokes without `/health`, unverified fences only, wrong host withdraws, Stop bypasses admission.

  These tests prove source composition, not chain, Windows or Base behaviour.

## 6. Remaining work

1. **Native protected routing: NOT implemented in r8.**
   - Router `routePath` still sends every `pp` id and every `/protected/*` route to `role:'legacy'`.
   - `stageProtected` still refuses V8, desktop and native-deployment bodies.
   - The native-role manager (`applyNativeRole` in `main`/`compose`) still has no `PermitEnforcement`/`ControlServer` composition.
   - Doing this properly needs four pieces together:
     - the native manager's protected composition, with its own permit journal and guard;
     - a router ownership table mapping `pp` id → role and manager epoch, written from the attested stage response;
     - native attestation in `stageProtected`, with the pinned image/config/CPU/GPU checks;
     - `dataServer` routing by that table.
   - A router-only change would be a disconnected helper, so none was made. The composite still has no running native neighbour and no protected native stage.
2. **Full workload boundaries: NOT changed in r8.** There are no per-workload changes this round to desktop, GPU, worker, egress, secrets, volumes, storage, ports or command sockets beyond the r7 state. The r7 reports describe what is and isn't covered there.
3. **Release closure.**
   - The r18 modules the factory imports are not in the candidate. `RELEASE-CLOSURE-R8.json` lists them with pinned hashes where the evidence had them.
   - Three are `UNRESOLVED` (`owned-durable-state`, `deployment-lifecycle-journal`, `verified-chain`), and the chain adapter's full transitive graph was not enumerated. Root must fail on any of these.
   - No hashes are given for r8-changed files.
4. **Dependency lock.** `package-lock.json` reproduces the pinned `ws` 8.21.1 resolution, while viem declares `ws` 8.20.1. Root decides how to resolve this.
5. **Older regressions.** Nothing changed in the gate, enforcement or replay code, so their r7 state carries over and nothing new was verified here. This covers boundary-close retries, backward wall clock, delayed expired guard, and lower-sequence replay.
6. **Owner-loss timer interaction.** The client's retry timer and supervisor passes can run `reconcileOrphans` at the same time. All requests are exact-id and idempotent (GET, cancel, hold, DELETE), but root should watch for duplicate-request noise.
7. **Qualification.** Windows Job/EXLOCK/flock and owned-durable-state qualification remain root-owned and pending. Execution, deployment and funding remain coordinator-owned.
