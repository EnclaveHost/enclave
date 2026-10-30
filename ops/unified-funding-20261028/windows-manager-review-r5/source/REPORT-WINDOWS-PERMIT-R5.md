# REPORT — Windows manager permit r5 (ownership/authentication repair + consuming integration)

**Status:** SOURCE ONLY, PARTIAL.
- Every test named here was AUTHORED, NOT RUN. Nothing was executed, built, installed, deployed or signed.
- No network, Git, services or financial action was used. The only tools were Read, Grep, Write and Edit.
- All writes went under `candidate/`.
- Evidence labels are kept apart:
  - root's executed r4 results (unchanged frozen product);
  - my source hypotheses;
  - authored scripted tests (TEST transport, TEST hardware and chain doubles).
- Nothing here is Windows, Hyper-V or Base qualification.

## 1. Priority 1 — demonstrated defects (root r4 evidence) and source changes

| # | Root evidence (executed, r4 product) | r5 source change | Files |
|---|---|---|---|
| 0 | `root-supervisor-diagnostic`: the second queued reconcile REMOVED the ready stage ("authenticated controller hold") and returned a new pp instance | **The I/O fence is now separate from compute retirement.**<br>• New manager `fenceStaged`, on the authenticated route `POST /protected/vms/<pp>/fence`. For the exact staged, never-serving instance it closes data-plane admission and splices and closes the composed boundaries. It **keeps compute**, still bounded by the absolute staging deadline fixed at stage, which is never extended.<br>• Anything else (serving, held, unknown, unreadable, unmapped) escalates **inside the manager** to the destructive `hold`.<br>• The node's `boundaries.hold` sends `/fence` only for its own exact instance (instance id, launch/manager epochs, state `staging`/`staged`, `serving !== true`). Every other live record gets the destructive `/hold`.<br>• Stop, revocation-with-removal and expiry still retire: `runtime.stop` → `client.remove` → authenticated DELETE, plus the manager's own staging/permit timers.<br>• Readiness is not bypassed. `checked()` and `readiness.verify` are unchanged. | permit-enforcement.mjs, protected-manager.mjs, protected-isolation.mjs |
| 1 | `root-delayed-mac`: at 150001 ms the client cleared the unknown obligation on an empty inventory, then the exact signed request still returned 202 | **Elapsed time and an empty inventory no longer discharge anything; the horizon is removed.**<br>• Every stage carries `operation` (`op`+32 hex). It is written to the node's **durable obligation store** (atomic write, fsync, rename) **before** the request is sent.<br>• The manager registers the operation synchronously on arrival, before the serial queue and `authority.read`. It writes the durable `executed` outcome before the staging intent, and refuses a duplicate or in-flight operation.<br>• `resolveUnknown` reads `GET /protected/operations/<op>`:<br>  – `unseen` → `POST …/cancel` writes a durable `cancelled`, and the manager then refuses every later arrival of that signed request;<br>  – `executed` → the node binds that exact instance (its own request id, MAC'd identity, not a first-match), or discharges only when that instance is confirmed terminal and absent;<br>  – `in-progress`, unreadable or anything else → still owned.<br>• Nothing is auto-resent.<br>• The inventory answers 503 while an accepted operation for the deployment is in progress (this covers accepted pre-intent queue and source delay). | permit-journal.mjs (`op` kind, `checkOp`, `operation`/`putOperation`), permit-enforcement.mjs (`stage`/`#stage`, `operationOutcome`, `cancelOperation`), protected-manager.mjs, protected-isolation.mjs |
| 2 | `root-inventory-auth`: a terminal row concealed an unmapped live pp VM | `protectedInventory` builds the mapping from **all** journal rows plus the trusted in-memory mapping:<br>• Any pp domain or raw spawn mapped to no deployment → 503 for every deployment. This does not depend on this deployment's historical rows, and there is no name-based guess.<br>• Each record carries `computePresent` (listed domain, pending spawn or removal).<br>• The client's `isLive` treats a terminal row whose compute is present as live, so a terminal record masks nothing.<br>• Exactly one record is required, with launch/manager epochs and generation; no adoption. | protected-manager.mjs, protected-isolation.mjs |
| 3 | `root-supervisor-diagnostic`: an enrolled deployment on a different origin called the legacy lookup | **The supervisor belongs to the policy, independent of the caller's client origin.**<br>• It always talks to `policy.manager` over guestd-control/1.<br>• `policy.host` must equal `composition.hostId`, the node's actual verified identity composed by the entry; otherwise enrolled deployments are held.<br>• It is created once, through a cached promise, so concurrent first calls cannot split ownership.<br>• `enrolledByPolicy` keeps unenrolled neighbours on the legacy path even when the supervisor is held. | protected-supervisor.mjs, isolation-lifecycle.mjs |
| 4 | `root-inventory-auth`: unsigned `DELETE /vms/pp…` returned 200 and withdrew | `createProtectedServer` answers **401** to any unsigned non-GET/HEAD request whose path addresses a pp id in any spelling: case, percent-encoding (decoded up to 3 times), trailing slash, query, backslash or sub-path.<br>• Unrelated legacy routes and unsigned reads are unchanged.<br>• Authenticated DELETE keeps r4's withdraw-first behaviour on a journal fault.<br>• The composite router forwards to this same server, so it inherits the 401. | protected-manager.mjs |
| 5 | Lost permit reconciled with `hostAuthority:null` | The manager's MAC'd view now carries `hostAuthority` (the digest its own gate bound to the live serving entry) and `expiryEnforced` (the serving timer is armed).<br>• `servingMatches` requires both, plus the exact identity, the same digest and a future deadline that was not extended. It also requires the hostAuthority to equal the **carried** signed record's digest.<br>• The reconciled receipt returns only the manager's checked fields.<br>• The carried envelope is now keyed per deployment **and typed-data digest**, consumed once, so concurrent renewals keep their own exact envelope. | permit-enforcement.mjs (`viewOf`), protected-isolation.mjs |
| 6 | Stale-replay policy | Not changed. The sequence, digest and deadline invariants and the Online/Offline behaviour in permit-enforcement and the gate are untouched by r5. | — |

## 2. Priority 2 — actual consumers

- **host.mjs (Edit, targeted)**:
  - `#isolationReconcile` computes `protectedEnrolled` from the pinned policy (`enrolledByPolicy`). A broken policy counts as enrolled and is held.
  - For an enrolled deployment it skips the legacy pre-steps: `staleVersion`, the startup/desktop `findByName` adoption check and the share-sizing `findByName`. It then reaches the supervisor through the same `reconcile()` import.
  - `#retireIsolated` → `retire()` → `sup.stop` (unchanged r4 path).
  - **Not done:** `isolationVerdict` does not yet surface the protected capability.
- **router/control.mjs (Edit)**:
  - Exact routes for `/protected/vms/<pp>/fence`, `GET /protected/deployments/<0x64>/instances`, `GET /protected/operations/<op>` and `POST /protected/operations/<op>/cancel`.
  - Authenticated only (401 otherwise). Requests are forwarded byte-for-byte with MAC headers to the protected owner, and the response and its MAC are the manager's own.
  - Health, accounting and `#noProtected` code is not touched.
- **main.mjs / compose.mjs**: carried from r4 unchanged (explicit general/native role, native pins on both spawns, `composeProtected` with an independent remover).
- **Not done:** a role-correct native-protected namespace through the composite.

## 3. Tests (AUTHORED NOT RUN)

### New: `candidate/test/windows-permit/r5-ownership-chain.test.mjs`
All of these run through the actual chain: lifecycle → supervisor → mapped r18 runtime → GuestdControl → `composeProtected` manager, with the real guard and real splice.
1. **R5 DIRECT positive.** Three repeated queued reconciles keep the **same** instance (one record, still `staged`, remover never called). Then the Running permit (manager digest = supervisor gate digest), with the staging deadline unchanged. Then usable splice I/O, Stop through `retire`, the stream closed, the VM gone from inventory, and the journal `removed`.
2. Changed client origin: zero legacy calls, and the stage lands on the policy's manager.
3. Host-identity mismatch: the enrolled deployment is held and nothing is staged; an unenrolled neighbour stays legacy.
4. Lost stage over actual MAC/TCP with a TEST held transport:
   - the obligation survives a new client (durable store);
   - it is discharged only by the cancellation acknowledgment;
   - the exact original signed request, arriving late, gets **409**, and nothing is staged.
5. Inventory: a terminal row plus an unmapped pp domain (TEST insertion) → the client inventory rejects (unknown).
6. Unsigned DELETE aliases → 401 with the state still `staged`; a legacy DELETE is not 401; the authenticated DELETE → 200 and `removed`.

### Modified: `r4-supervisor-chain.test.mjs`
- Sets `composition.hostId = HOST`.
- Imports the r18 runtime through the candidate mapping instead of the absolute external path.

### Notes on the tests
- The root's `root-delayed-mac` should still pass. Its TEST handler answers GET with an inventory body, so the operation read is unknown and the obligation stays owned. Its late-202 assertion tests the ControlServer transport, not enforcement.
- One assertion in test 1 (`hostAuthority` against `gate.entries…hostAuthority ?? …`) is weak if the gate entry has no `hostAuthority` field. Root should tighten it once run.
- **Unverified hypothesis:** the r18 gate accepts the repeated fresh-queued handoff on passes 2 and 3. Source reading suggests it does (no entry or resource is installed, and the same digest is bound again).
- **Not written:** a composite e2e test through the router (the routes now exist) and a native-role protected e2e test.

## 4. Release closure
- `candidate/RELEASE-CLOSURE-R5.json`:
  - maps the pinned R18 `deployment-isolation-runtime.mjs` (sha256 `6309c386…`) to `control/network/` as a **byte-exact vendored copy** that root materializes and verifies;
  - I did not retype it, to avoid byte drift. Until root materializes it, the two chain tests fail at import, loudly.
- `candidate/package.json` pins `viem` **2.53.1** exactly.
- **The lockfile is missing.** An honest integrity hash cannot be produced without network, so root must generate and pin it. This is meant to fix the four r4 "missing viem under external R18" setup failures; root must confirm that.

## 5. Status per area (honest)
- **Workloads:** desktop/GPU, V6/V7 secrets, worker/egress, volumes, published ports and command sockets are still **NOT wired**. Stage refuses them unless a composed adapter exists. Not accepted.
- **Authority:**
  - No genuine pinned read-only chain adapter is composed in the node or manager entry.
  - Production `openRuntime`/`collect` are absent, so enrolled deployments are **held** in production.
  - No caller flag qualifies anything.
- **Platform:** Windows Job/EXLOCK is unqualified and was not executed. The T0-hv threat model is unchanged. There is no Windows evidence.
- **Older regressions — not done:**
  - backward wall time vs durable withdrawal;
  - retryable boundary-close callbacks;
  - guard renew of an already-expired lifetime;
  - `confirmed.vmId` and independent-remover Notes fixtures.
- **Known r5 limitations:**
  - A staged instance fenced by `revokeHostAuthority` keeps compute until its staging deadline. That deadline is absolute and not extended, but revocation does not remove it at once unless Stop follows.
  - The obligation store defaults to `dirname(controlKeyFile)/protected-obligations.json`. The node entry may compose another. A malformed store throws, which holds the deployment.
  - Old operation-less stage requests are still accepted by the manager (r4 compatibility). The node always sends `operation`.

## 6. Remaining blockers
1. Root: materialize the vendored runtime, generate the lock, run the r4 and r5 suites, and keep the original 84-suite failures as evidence.
2. Compose the real authority (owned r18 opener and collector) and `composition.hostId` in the node entry.
3. Real per-workload adapters with allow, withdraw and late-effect cleanup.
4. A composite e2e test and a native-role protected namespace.
5. `isolationVerdict` capability surfacing.
6. The older regressions listed in §5.
