# REPORT-WINDOWS-PERMIT-R6 (source only: AUTHORED, NOT RUN)

I wrote this in one bounded invocation using only Read/Grep/Edit/Write. I executed no tests, builds, installs, network calls, Git operations or hashing. Every test below is **AUTHORED NOT RUN**. The invocation reached its turn budget before Priority 4 and the release work, and this report marks exactly what is still unfinished. **Nothing here is Windows, Hyper-V, Base or full-workload qualification.**

## 1. Priority 1: a routine fence is now distinct from authority withdrawal (DONE in source)

**Consumers.** The real host path is host.mjs → isolation-lifecycle → protected-supervisor → r18 `createIsolationLifecycleRuntime` (the candidate copy) → `DeploymentPermitGate` → ProtectedIsolationClient → manager.

- **`control/network/deployment-permit-gate.mjs`**
  - `hold()` is unchanged and nondestructive. It is still the routine fence.
  - New `revoke(id, reason)`: it runs `hold()`, then *synchronously* starts exact retirement of this app's staged compute through its owned staged callback. That retirement is tracked in `#withdrawal`, so `close()` waits for it and a failure is recorded. A failed retirement is re-staged so it can be retried.
  - `stage(id, withdraw, {host})` now records the host. New `stagedOn(hostId)` lists that host's staged apps.
  - Offline denial (`observeHostEvidence` returning `recorded` or `already`) now also calls `revoke()` on that host's staged apps, and only that host's.
  - An unknown or released authority journal now revokes held, tracked **and** staged apps.
  - `close()` is adapted to the `{withdraw, host}` entries.
- **`control/network/deployment-isolation-runtime.mjs`**
  - `fence()` is still the routine path: `gate.hold` plus `acknowledgeHold`. The staged instance is kept and its absolute stage deadline is unchanged.
  - New internal `withdrawAuthority(id, retiring)`. It runs the boundary acknowledgment **in parallel** with retirement, waits for the owned in-flight operations of that app (a late spawn is withdrawn by `op.spawn` because the epoch changed), then confirms absence by exact name.
    - It resolves `{absent:true, held:true}` only after confirmed absence **and** an acknowledged hold.
    - Otherwise it rejects. Compute may already be gone while the boundary is unacknowledged; the owner stays fenced.
  - `revokeHostAuthority` now starts with `gate.revoke` before any await.
  - New `revokeAuthority(id)` handles per-app explicit revocation.
  - In-flight owned operations are tracked per app.
  - A V2 gate must now provide `revoke`.
- **Unchanged:**
  - `stop()` already removes compute concurrently with the fence.
  - Expiry uses the manager's absolute deadline plus the runtime's startup deadline.
  - Owner release or a lost lock uses `gate.close()`, which retires staged compute.
  - Newer Online authority is still not a veto, and the handoff/adoption rules are untouched.
- **Not yet wired.** `ProtectedSupervisor` does not call `revokeAuthority`. The r18 dispatch's own revocation calls do not exist in this candidate. Wiring the supervisor's Offline/revoked snapshot branch to `revokeAuthority` is the next edit.

## 2. Priority 2: the router authenticates before it takes ownership (DONE in source; full composite NOT done)

The router still holds **no pairing key** and verifies no client MAC itself. The new trust path is explicit and owner-selected:

- **New `control/windows/vbslike/router/attest.mjs`** (protocol `enclave-router-attest/1`):
  - Uses a separate 32-byte router key K_r from an absolute 64-hex file. It is never the pairing key and never taken from a request.
  - Both the request and the answer carry an HMAC under K_r, bound to a fresh nonce.
- **`manager/control.mjs`:** new `ControlServer.attest()`. It makes the same session, sequence and MAC checks as `call()`, but **does not consume the sequence**. It calls no handler.
- **`manager/protected-manager.mjs`:** new `POST /router/attest` route, answered only under K_r. It creates, cancels and consumes nothing.
  - `stage` purpose: verifies the exact signed `POST /protected/vms` and returns the request sha256, deployment, operation, the operation's durable outcome and the manager epoch.
  - `operation` purpose: returns the operation's durable outcome.
  - `createProtectedServer` accepts `{routerKey, enforcement}`.
  - `compose.mjs` passes `routerKey` through. `manager/main.mjs` reads `permitConfig.routerAttestKeyFile`.
- **`router/control.mjs`:**
  - **Stage admission order:**
    1. Validate the body and require `op` + 32 hex.
    2. **Attest.** An invalid session gets 401 with nothing latched and nothing forwarded.
    3. If the operation has any outcome other than `unseen`, return 409 with no latch.
    4. Run the real snapshot, precheck, admission and capacity checks.
    5. `journal.begin` records the operation, deployment, request sha, manager epoch and expected resources.
    6. Forward the raw stage.
  - Capacity is still reserved before the raw spawn.
  - New `resolveOperation(op)` clears only this router's pending record, and only from a verified outcome:
    - `cancelled` with no instance clears the latch. The manager writes `executed` before its staging intent and each outcome is written once.
    - `executed` clears only through the exact same-epoch reservation check in `observePending`.
    - Anything else keeps the reservation charged.
  - Cancel passthrough returns the manager's exact MAC'd answer, then joins `resolveOperation` under `serial`.
  - `reconcile()` uses the operation path for protected records.
  - A client-supplied `x-router-mac` is stripped.
  - With no key, health removes the protected capability and a stage is refused with no latch.
  - **Known limitation:** the cancel join waits on `serial`, so it waits for any in-flight forwarded stage (bounded by the 125 s exchange deadline).
- **`router/io.mjs`:** forwards `x-router-mac` and returns `routerMac` to the router only.
- **`router/main.mjs`:** accepts an optional absolute `attestKeyFile` in the router config.
- **Behaviour change:** an invalid MAC on a stage is now answered with a 401 response instead of a thrown error. The ROOT test was adapted to this.

## 3. Priority 3: owned durable obligations (DONE in source)

- **`node/protected-isolation.mjs`:** new `ownedObligationStore(log)`, built on the existing `win-durable` `openOwnedLog` (append-only, hash-chained, failure latch, exclusion is the handle).
  - Replay: a genesis-only log is the empty state. Otherwise the last complete snapshot is used.
  - A torn, quarantined, failed, released or malformed log refuses. It is never treated as fresh state and never recreated.
  - `save` replays first, so a released owner means **nothing is sent**.
  - `fileObligationStore` is kept but relabelled TEST / ordinary persistence only.
- **`node/protected-supervisor.mjs`:** the default store is now `ownedObligationStore(openOwnedLog(<controlKeyDir>/protected-obligations.log, {purpose}))` using `WINDOWS_EXCLUSION`.
  - On non-Windows systems, or when the log is missing, supervisor creation rejects and every enrolled deployment is held.
  - That is the truthful platform boundary: Windows EXLOCK qualification is still pending and nothing here claims it.
- **Not done:** binding obligations to request sha / manager epoch / launch epoch beyond the 128-bit operation id. Today the stage record binds deployment, instance and epochs, and the operation id carries the binding.

## 4. Tests (AUTHORED NOT RUN; TEST labels are in each file header)

- **`test/windows-permit/r6-stage-revocation.test.mjs`**
  - Carries the ROOT r5 revocation test (r5 evidence: 0/1), now asserting the confirmed-absence result.
  - Positive test: repeated readiness keeps one staged VM.
  - Hung-boundary test: retirement happens before the boundary timeout and the revocation still rejects.
  - Late-spawn test: the late instance is withdrawn before absence is confirmed.
  - The owned obligation store is used there too.
  - One assertion in it (`withdrawalFailures().length >= 0`) checks nothing and should be removed.
  - **Not covered:** a Running permit/renewal/TCP I/O positive in this file.
- **`test/windows-permit/r6-router-ownership.test.mjs`**
  - The two ROOT router tests, repaired, plus: late original gets 409; wrong-operation, replayed and in-progress cancels do not clear; health is not 200 while uncertain; a missing key refuses with no latch.
  - Owned-obligation tests: cold replay, concurrent owner refused, missing log, torn tail, released owner, in-progress kept, durable cancel discharge.
  - Snapshot, precheck and admission are **DIAGNOSTIC TEST stubs**.
  - The "accounted successful stage" test is **weak**: its assertion is conditional. It must be replaced by the real composite test.
- **`helpers/world.mjs`:** `rig()` takes `routerKey` and exposes `control` and `routerKey`.
- I did not copy the root r4/r5 fixture corrections (the 11 PASS set) into the candidate tests this pass. The coordinator should apply them as listed in the evidence.

## 5. NOT DONE in this invocation (stated plainly)

- **Priority 4 full composite test** is not written. It needs both real manager servers, a real snapshot/precheck/admission, neighbour workloads, the memory floor, and native protected routing (allpp→legacy and the V8/native stage refusal are still incomplete for the KVM Box).
- Host `isolationVerdict` / factory composition from the R18 `lifecycle-host-owned-authority`, chain-adapter, collector and finality-bridge files is not wired by a production entry. `composition.openRuntime` is still an entry/TEST hook.
- No per-workload progress this pass: desktop, GPU, worker, egress, secrets, volumes, ports and command sockets. A/B/C/D remain open.
- The older regressions (backward clock, retryable boundary close, expired guard revival, `confirmed.vmId` Notes fixtures) were not revisited.
- **Release closure:**
  - I changed the gate and runtime, which are r18-mapped files, so their mapped hashes (`6309c386…` and `2ee846d4…`) are now **stale**. The root must recompute the deterministic mapping and manifest. I computed no hashes.
  - The closure must add `router/attest.mjs` and the modified router files.
  - The viem 2.53.1 lock reconciliation from `evidence/dependency-locks` was not done.

## 6. Every file changed (candidate only)

- `control/network/deployment-permit-gate.mjs`
- `control/network/deployment-isolation-runtime.mjs`
- `control/windows/vbslike/manager/{control,protected-manager,compose,main}.mjs`
- `control/windows/vbslike/router/{control,io,main}.mjs`, plus new `router/attest.mjs`
- `control/windows/node/{protected-isolation,protected-supervisor}.mjs`
- `test/windows-permit/helpers/world.mjs`
- New tests: `test/windows-permit/r6-stage-revocation.test.mjs` and `test/windows-permit/r6-router-ownership.test.mjs`

The coordinator owns all execution and qualification.
