# REPORT — Windows manager permit r4 (supervisor / manager integration)

**Status:** SOURCE ONLY. Every test listed here was AUTHORED, NOT RUN. Nothing was executed, built, installed, deployed or signed. I only wrote inside `candidate/`. Tools used: Read, Grep and Write. There was no Edit tool, so every changed file was rewritten whole. That is also why `host.mjs` (4410 lines) and `router/control.mjs` were not rewritten (see Blockers).

## 1. Actual consumer / entry changes (Milestone 1)

### Node call chain (the real host path now consumes the protected client)
`host.mjs #isolationReconcile` calls `reconcile()` from `isolation-lifecycle.mjs` (host.mjs:1301), unchanged. It also calls `retire()` through `#retireIsolated`. **`isolation-lifecycle.mjs` (modified)** now calls `protectedSupervisorFor(client)` before any legacy lookup or spawn:
- When the host's **pinned enrollment policy** (`ENCLAVE_PROTECTED_ENROLLMENT` plus `_SHA256`; exact keys; this host; an explicit deployment list; a loopback manager origin; the control key file) enrolls the deployment for this client's manager origin, `ProtectedSupervisor.reconcile/stop` handles it. It never falls back to legacy.
- A broken policy gives `held`, never legacy.
- With no policy, or for an unenrolled deployment, the legacy code runs byte-for-byte as before.
- No request field or envelope boolean can opt a deployment in.

**`node/protected-supervisor.mjs` (new)** drives the **R18 `createIsolationLifecycleRuntime`** (`ensureStaged` while the assignment is `queued`; `health` then `serve` while `running`; `stop`). It gets the runtime from `openRuntime` (the owned r18 authority) and uses the adapters returned by `ProtectedIsolationClient.runtimeAdapters()`. If no qualified owned runtime or collector is composed, the answer is `held: protected authority unavailable`.

**`node/protected-isolation.mjs` (rewritten)** provides the r18 adapters with the real signatures:
- `client.findByName/spawn/remove`; `spawn` returns `{view}`.
- `plans.read`, `readiness.verify` (MAC'd view: running, staged/serving, exact generation, launch and manager epoch, VM GUID).
- `collectPermit` and `boundaries.allow/hold`.

**Envelope carriage:** `collectPermit` wraps the owner-selected collector. It records the envelope it returned, bound to deployment, generation, sequence, host-authority digest and typed-data digest. `boundaries.allow(id, grant)` uses that envelope once, and only if:
- the supervisor gate's current entry digest equals the carried digest, and
- the grant's generation, hostAuthority and validUntil fit it.

Nothing is reconstructed from the grant, and there is no mutable "last envelope". The attachment is built only from the MAC'd protected view plus `validUntil = grant.validUntil`. The ack returns the manager's own `validUntil` and `hostAuthority`. If the manager's deadline differs from the grant's, the runtime's equality check fences the deployment (conservative). Unsigned fields are never called witness-signed.

### Manager entry
**`manager/compose.mjs` (new)** holds the shared, import-safe construction. **`manager/main.mjs`** (the real entry) now calls it:
- **Explicit role:** `ENCLAVE_MANAGER_ROLE` = `general` | `native`. Without a permit config and without the variable, the r3 file's native behaviour is unchanged. A protected configuration requires the role to be set.
- `validatePermitConfig`: the general role refuses 8095/8096; the native role requires exactly 8095/8096. The r3 refusal of native/desktop when protected is removed. The desktop config is refused in the general role.
- `applyNativeRole` is applied **whenever the role is native, protected or not**. It keeps the r3 predicate unchanged (`nativeRefusal`), and it also wraps `spawnProtectedInternal` (pp namespace), so a protected native stage cannot drop the pins. The general role never gets the wrapper.
- `composeProtected` builds PermitEnforcement with journal, guard, authority, data plane, **independent `computeRemover` = guard-main `windowsBackend`** over its own bounded runner (in r3 this parameter was never passed), and adapters. It then runs `verifyGuard`, `recoverAtStartup`, ControlServer and createProtectedServer. `dataLookup` is the pp-gated data-plane lookup.

## 2. Milestone 2 fixes in source
| Defect | Fix | File |
|---|---|---|
| Authenticated DELETE read the journal before withdrawing (root actual MAC/TCP FAIL #4) | Ownership is decided without trusting the read; `withdraw` starts first; the answer stays 500 until absence is durable | protected-manager.mjs `remove` |
| `#findStaged` used GET /vms | New strict authenticated route `GET /protected/deployments/<bytes32>/instances` (schema, complete, managerEpoch, every record incl. non-terminal; 503 on journal fault or unattributed VM) | protected-manager.mjs, protected-isolation.mjs `inventory` |
| Unsigned-401 null-reconcile resent a stage | stage/permit are sent with **no** `reconcile`, so GuestdControl throws `outcome-unknown` and never resends. GuestdControl itself is unchanged. | protected-isolation.mjs |
| `resolveUnknown` dropped obligations on empty inventory or failed hold | Kept until the strict inventory shows no live record **after** the horizon (`stagingMs + replayWindowMs`) and every hold succeeded. `findByName` refuses to report absence while an obligation exists, and refuses to adopt any record this supervisor did not stage, or more than one record. | protected-isolation.mjs |
| Permit reconciled on digest alone | `servingMatches` requires serving:true, state serving, all exact identity fields, the digest, `validUntil <= attachment` and still future. Stage, permit and hold answers are shape-validated. | protected-isolation.mjs |

**Not done in this pass:**
- backward-wall-clock `checkInst`
- boundary close retention / `retryRelease` close retry
- guard renew of an already-expired permit
- the candidate replacement of authored test 19 (stale-sequence invariance + 3 s expiry)
- the fixture corrections for 32 (`confirmed.vmId`, independent-remover Notes)
- router composite route

The root's reviewed policy is unchanged in product (no product edit was justified). Historical failing results remain under `evidence/`.

## 3. Tests (AUTHORED NOT RUN)
`candidate/test/windows-permit/r4-supervisor-chain.test.mjs`:
- **DIRECT:** `reconcile` → supervisor → R18 runtime (imported from the pinned frozen R18 path) → GuestdControl → manager composed by `composeProtected`, with the real guard process and real splice. It covers staged boot, verified readiness, the Running permit (it asserts the manager's accepted digest equals the supervisor gate's entry), OK I/O, Stop through `retire`, the stream closed, the inventory absent, and the journal reaching `removed`.
- Legacy neighbour: an unenrolled deployment creates no protected record.
- Native-role pins: role selection and port rules; `applyNativeRole` refuses a protected stage that differs from the pins; the scope marker is applied.
- DELETE journal fault through actual MAC/TCP: 500 and `closeInstance` called.

TEST labels:
- the TEST in-memory r18 lifecycle journal (not the owned r18 journal);
- the TEST authority snapshot: its `assignment.revision`, `hostAuthorityEvidence` and `servingContextOf` shape may need fixture adjustment by root;
- JSON Hyper-V and launcher doubles.

The root scripted tests 1–3 in `root-client-route.test.mjs` should now pass against this client, and test 4 against the manager (not run).

**Composite route test: NOT written.** The router does not yet forward the new inventory route.

## 4. Workload / authority / platform / closure status
- **Workloads:** none newly wired. desktop/GPU/worker/egress/secrets/volumes/ports/command stay REFUSED at stage unless a composed adapter exists. UNFINISHED, not accepted.
- **Authority:** no genuine pinned read-only chain adapter was built this pass. Production `openRuntime`/`collect` are not composed in the node entry, so enrolled deployments are **held, capability unavailable**. Caller JSON never qualifies.
- **Platform:** Node 24.16.0 named EXLOCK is still unqualified; the Windows Job/EXLOCK proposal was not executed. No installed state or keys were touched.
- **Release closure:** NOT updated. New and modified files:
  - node/protected-isolation.mjs
  - node/protected-supervisor.mjs
  - node/isolation-lifecycle.mjs
  - manager/protected-manager.mjs
  - manager/compose.mjs
  - manager/main.mjs
  - test/windows-permit/r4-supervisor-chain.test.mjs

  `deployment-isolation-runtime.mjs` must be added to `candidate/control/network/` and mapped before production use (it is currently imported only by the test, from R18).

## 5. Blockers / honest remaining items
1. `router/control.mjs`: needs authenticated forwarding of `GET /protected/deployments/<0x64>/instances` to the legacy role (exact path, no body). Native-role protected enrollment through the composite (pp is routed to legacy) needs a role-correct namespace. The composite e2e test is pending on this.
2. `host.mjs` is unedited. The integration is through its existing `reconcile`/`retire` imports. Its pre-steps (`staleVersion`, `findByName`, sizing) still use the legacy client. For an enrolled name, an unauthenticated legacy DELETE of a pp id reaches `ProtectedManager.remove` → withdraw (more restrictive, never adoption). `isolationVerdict` does not yet surface protected capability.
3. The production owned r18 runtime opener (`openOwnedHostRegistryLifecycle`) and the owner-selected collector are not composed in the node entry: genuine authority inputs are unavailable.
4. The remaining Milestone 2 items listed in §2, and all of Milestone 3.
