# REPORT-WINDOWS-PERMIT-R7 (source only: AUTHORED, NOT RUN)

This was one bounded invocation using only Read/Grep/Edit/Write. I executed nothing: no tests, builds, installs, network calls, Git operations or hashing. Every test below is **AUTHORED NOT RUN**. **Nothing here is Windows, Hyper-V, Base or full-workload qualification.**

The baseline is the exact root r6 seed of 165 files. Both root product fixes are preserved and their tests are untouched:
- the compose `routerAttestKeyFile` config fix;
- the router cancellation fix that requires the exact saved `managerEpoch`.

## 1. Actual root evidence this pass targets (unchanged historical results)

- **Focused root run:** 28 tests, 26 PASS, 2 FAIL.
  - #25 (late spawn): `runtime boundary withdrawal not acknowledged`.
  - #28 (supervisor stopped): the VM stayed `staged`.
- **Root actual-HTTP owner-release run:** 0 PASS, 1 FAIL. The stage returned a successful binding after the physical owner was released.
- Neither failure is evidence of a duplicate VM, a duplicate payment or a production exploit.

## 2. Positive composite: written first (`test/windows-permit/r7-composite.test.mjs`)

**Chain it drives.** Nothing in the router is overridden:
1. `isolation-lifecycle.reconcile`
2. `protectedSupervisorFor`. The enrollment's manager origin is the **router**.
3. `ProtectedSupervisor`
4. The candidate r18 runtime
5. `DeploymentPermitGate`
6. `ProtectedIsolationClient`
7. `GuestdControl` (real MAC/TCP)
8. The router's `controlServer` / `CompositeManager`, using the shipped snapshot, precheck, admission, attest, `LaunchJournal` pending latch and `observePending` same-epoch accounting.
9. `makeRequest`, out to **both real manager servers**:
   - the legacy `ProtectedManager`, via `composeProtected` with the router key;
   - a second real `Manager` via `createServer`, with `applyNativeRole`.
   - Both share identical RAM, physical and CPU pools.
10. The real guard process.
11. The real data-plane splice.

**Steps it asserts:**
- An ordinary unenrolled neighbour (`hv…`) is spawned through the same router.
- Queued protected stage:
  - the pending cost is cleared only by `observePending`;
  - router `allocatedMiB` equals the sum of both instances.
- Three repeated readiness passes keep the same instance.
- Running: permit, then a renewal with a second collected envelope and a new digest, with the instance still `serving`.
- TCP echo I/O.
- Stop is observed by the supervisor. Then:
  - the stream is closed;
  - the instance is `removed`;
  - only the neighbour remains;
  - the allocation is back to the neighbour's.
- Memory floor: with TEST headroom of 1024 MiB, the stage is held, nothing is latched and nothing is staged.

**TEST-labelled inputs:**
- JSON inventories.
- A launcher that confirms the type-1 physical allocation.
- The authority snapshot and witnesses.
- An in-memory lifecycle journal.
- In-process exclusion.
- A **TEST native desktop descriptor** on the native `/health` (pins only, `ready:false`). The KVM Box platform/profile cannot be built here.

**Composition gaps this exposes (unfinished, not excluded):**
- **No running native neighbour and no native protected stage.** `routeFor(pp…)` always goes to legacy, and `stageProtected` refuses V8. Explicit role-bound pp routing and ownership is **not implemented**.
- **Router refusals are not MAC'd.** A refusal before forwarding (for example the 507 floor) carries no manager MAC, so the node keeps an unknown obligation until `resolveUnknown` sees `unseen`, then `cancel`, then `cancelled`. That is safe but costs a round trip. The test asserts only the held, nothing-latched and nothing-staged outcome.
- Row fields the router's real accounting requires (`gpuMilli`, `cpu.grantedUnits`, `physicalMemoryMiB`) are produced by the manager. If the run fails on them, that is a real composition gap, not a fixture to stub.

## 3. Real supervisor Stop/Offline and late-operation withdrawal (DONE in source)

**`control/windows/node/protected-supervisor.mjs` — `reconcile` order is now:**
1. Owner-loss latch.
2. Owned runtime.
3. Authenticated snapshot.
4. **Existing-authority decision.**
5. Capability.
6. `resolveUnknown`.
7. New work.

**`#withdrawalOf` outcomes:**

| Snapshot says | What happens |
|---|---|
| Proof-verified Offline for this host | `runtime.revokeHostAuthority` |
| Verified assignment for this deployment, state not queued/running, or assigned to another host | `runtime.revokeAuthority` |
| Snapshot throws, or has no verified assignment for this deployment | `runtime.fence` only: serving withdrawn, staged compute and obligations kept, no invented Stop |

- On a v1 runtime the withdrawal falls back to `runtime.stop`.
- The withdrawal result is `withdrawn:true` only on `{absent:true, held:true}`. Otherwise it is held and retried.
- A verified Online is never a veto.

**`control/network/deployment-isolation-runtime.mjs` — `withdrawAuthority`:**
- Retirement still starts at once.
- The boundary is now asked **after** this app's owned in-flight operations settle; a late spawn is withdrawn by `op.spawn`. This addresses root #25.
- A stage that stays unknown keeps the acknowledgment false, so the owner stays fenced.
- A hung boundary still cannot delay retirement.

**Tests (`test/windows-permit/r7-supervisor-withdrawal.test.mjs`).** These use the root r6 corrected world with portable imports and full-inventory `live()`:
- ROOT stopped (carried).
- Stop while capability is 503 (TEST interposition on GET /health only).
- Canonical Offline.
- Unknown authority fences, then the same instance continues.
- Late raw stage with Stop through the supervisor.
- ROOT r6 late spawn (carried).

## 4. Physical obligation-owner lifetime (DONE in source for the client and supervisor)

**`control/windows/node/protected-isolation.mjs`:**
- `ownedObligationStore.replay` now calls the physical `log.assertLive()`. A released, failed or lost descriptor never yields cached rows.
- `#save` calls `store.assertLive()` before every write. Any failure **latches** `ownerLost` and calls `onOwnerLost`. After the latch, stage and permit send nothing.
- **Stage after a 202.** The binding becomes usable only after a durable save. If the save fails (owner released before the 202 or while the stage was pending):
  - the binding is dropped;
  - the raw operation stays owned in memory with `instanceId`;
  - `#retireAccepted` starts an exact-id DELETE and a complete MAC'd inventory confirmation;
  - the caller gets an error. A late 202 never recreates ownership.
- The pre-send record now binds operation, deployment, `stagingMs` and `spawnSha256`.
- If a discharge or binding in `resolveUnknown` cannot be persisted, the operation is restored in memory. It is never forgotten.
- `permit()` refuses after the latch and asserts the physical owner first.
- New `reconcileOrphans()` retries unconfirmed retirements.

**`protected-supervisor.mjs`:**
- `onOwnerLost` closes the owned gate. That retires staged compute and holds every grant.
- While the latch is set, `reconcile` retries the orphan retirement and returns held.

**Tests (`test/windows-permit/r7-owner-lifetime.test.mjs`), all over actual MAC/HTTP with `rig()`:**
- The ROOT owner-release case, extended:
  - latch;
  - no usable binding;
  - exact retirement proven, with the instance `removed` and no VM left;
  - nothing sent afterwards;
  - a released store refuses `load`;
  - **cold recovery**: a new owner replays the pre-send operation, resolves it as executed/terminal/absent, and the discharge is durable.
- Owner lost while the raw stage is pending.
- Failed write (TEST fs EIO):
  - latched and reported;
  - the discharge is not reported and the operation is kept;
  - no permit is sent;
  - a failed log refuses `load`.

**Limit:** `TEST_inProcessExclusion` is logic evidence only, not Windows share-mode or EXLOCK qualification.

## 5. NOT DONE (unfinished work, not scope exclusions)

- **Production authority factory.** Node entry `composition.openRuntime` / `collect` and `host.isolationVerdict` are not wired to the owned R18 factories (`lifecycle-host-owned-authority`, `deployment-chain-adapter`, `deployment-permit-collector`, `lifecycle-finality-bridge`, `servingContextOf`). `composition.openRuntime` is still an entry/TEST hook, so production enrolled deployments are held as "protected authority unavailable".
- **Per-workload progress (A/B/C/D):** none this pass. That covers desktop, GPU, worker, egress, secrets, volumes, storage, ports and command sockets across V6/V7/native.
- **Native protected routing** (see §2).
- **Older regressions** still open: retry of the boundary close callback, durable withdrawal on a backward wall clock, revival of an expired old guard, exact positive identity fixtures, and refusing lower-sequence replay without killing a newer permit.
- **Release closure:**
  - Not updated, and no hashes were computed.
  - Mapped/manifest hashes are **stale** for every changed file: `deployment-isolation-runtime.mjs`, `protected-isolation.mjs` and `protected-supervisor.mjs`, plus the r6-changed gate, router, attest, manager and compose files.
  - The three new r7 tests must be added.
  - The viem 2.53.1 lock reconciliation has not been done.
- **Windows Job/EXLOCK:** coordinator-owned; nothing here claims it.

## 6. Files changed in this pass (candidate only)

- `control/network/deployment-isolation-runtime.mjs`
- `control/windows/node/protected-supervisor.mjs`
- `control/windows/node/protected-isolation.mjs`
- New: `test/windows-permit/r7-composite.test.mjs`
- New: `test/windows-permit/r7-supervisor-withdrawal.test.mjs`
- New: `test/windows-permit/r7-owner-lifetime.test.mjs`
- New: `REPORT-WINDOWS-PERMIT-R7.md`

The coordinator owns all execution, qualification, deployment and funding.
