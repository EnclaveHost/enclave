# Windows permit r9: authority factory, route handoff and host consumption

Status: source only. Tests were authored but **not run**. Nothing was executed, built, deployed or signed. No financial action was taken. Root executes after review. The r8 evidence under `evidence/` is unchanged.

## 1. Factory + route repair (primary)

**Root cause (root-executed r8 evidence d2693af2…, 0 PASS / 1 FAIL).** `openRuntime` passed no `routes`, so the real constructor `parseLifecycleRoutes` refused, after all three owned journals had opened. The quiescence verifier was also `async () => false`, so no route could have activated even if one had been passed.

**Changes in `control/windows/node/protected-authority-factory.mjs`:**
- The hash-pinned config now has two exact keys: `routes` and `quiescence`. There are 1..64 explicit routes with distinct bytes32 deployments. Per-route exact keys, the binding/host-registry identity and the code hashes are checked only by the **real** `parseLifecycleRoutes` inside the real constructor. Nothing here re-implements or skips that check.
- **Owner-selected quiescence verifier.** This is a hash-pinned module exporting `createQuiescenceVerifier(options, { read })`. It is imported from its exact bytes and receives only the read-only reader. The real `dispatch.activate()` still requires `verified`, `proofVerified`, a finalized tier, the exact deployment/oldLedger/quiescenceDigest and `quiescent`. It then re-checks local legacy activity. Evidence shape alone never activates a route.
- **Route identity.** `openRuntime({ deployments })` refuses before acquiring any owner if a route names a deployment that is not enrolled.
- **Host view required.** `composeProtectedAuthority({ hostView })` refuses without the Host lifecycle view, which must provide exact `HOST_FNS` for the same hostId. The real dispatch is `attach()`ed to that view. If attach fails, the owned lifecycle is released and the call throws. The dispatch **cadence is never started**, so there is no automatic chain heartbeat, lease or transition. The r8 no-op `dispatch.stop()` was removed.
- `openRuntime` returns `handoff` = { owns, activated, why, activate, newWorkRefusal, state }, built over the real dispatch. One activation attempt is made at open.

**Supervisor (`protected-supervisor.mjs`):**
- An opener that does not return a full `handoff` is released and refused.
- The order inside `reconcile` is: owner-loss cleanup → snapshot → **withdrawal (Stop/Offline/unknown fence)** → **route handoff gate** (unrouted, not activated, or the box owner has turned hosting off: fence and hold, with the reason) → manager capability → stage/serve. Stop and Offline therefore never wait for the handoff.
- New `enrolledDeployments()`.
- New `protectedShutdown(why)`: latches no-new-work, does the exact owned release (its withdrawal closes the gate, which fences and retires compute before the flocks go), runs orphan reconciliation, and returns honest `outstanding()` counts. Raw unknown operations stay in the owned log; no blind new empty owner state is created.

**Host consumption (`host.mjs`):**
- Enrolled ids are excluded from legacy paths. The only input is the pinned policy.
  - `consider()` returns `standing:"lifecycle"` with no claim. A broken policy also refuses.
  - `renewDue()` never renews them.
  - `#reconcileTracked` goes to `#legacyHandoff`. That holds the lease without renewing it while it is live, then exact-retires and untracks it. While the lease is still tracked, the route cannot activate.
  - `#giveUp` goes to `#protectedWithdraw`: local exact removal, **no lease release**, reported as "local withdrawal is not a ledger Stop/Offline".
- **Event-driven launch.** `#tickOnce` calls `#protectedLaunch(id)` for each enrolled id. The path is the legacy row/catalog (used as **configuration only**) → the actual `#isolationReconcile` → isolation-lifecycle → ProtectedSupervisor → owned runtime/gate → manager.
- `isolationVerdict` now passes `needLease: launch && !enrolled`. Startup-package materialization no longer demands a lease for a routed app.
- **`lifecycleView()`** is the actual Host view the dispatch attaches to:
  - release-journal hold;
  - owner hosting-off;
  - this process's legacy activity (tracked lease, in-enclave app, renewal, give-up);
  - capacity from `shareUse` and the owner's caps;
  - `shareOf` via `cpuShareOf`;
  - `record`/`log`.

  The dispatch can never lower the host's share record from an allocation it has not resolved.
- Unenrolled deployments and hosts without a policy behave exactly as before (`enrolledByPolicy` returns false).

**Agent (`agent.mjs`):** passes `hostView: host.lifecycleView()`. SIGINT now runs a 10 s bounded `protectedShutdown` before the existing teardown.

## 2. Authored tests (NOT RUN)

| File | What is real | Fixtures (labelled) |
|---|---|---|
| `r9-real-owned-factory.test.mjs` (**positive successor of the failing r8 evidence**) | r9 factory config/pins/scan/verifier load; R18 `openOwnedHostRegistryLifecycle` (sha ee1f93c8 asserted); parent and two sidecar journals under Linux flock; gate/runtime; `composeIndependentLifecycle`/`createLifecycleDispatch`/`parseLifecycleRoutes` over two explicit host-registry routes; `attach`; `activate` | canonical adapter identity (R18 O8 construction, no read), quiescence verifier module, inert finality/collector/accounts/manager adapters, host view |
| `r8-authority-factory.test.mjs` (updated) | Factory contract | Routes reach the constructor, cadence is never started, the dispatch is attached, one activation is attempted, unenrolled-route refusal, refusal without a host view |
| r4/r5/r6/r7-composite/r7-withdrawal/r8-unknown-owner-loss | Unchanged assertions | An inline **TEST pre-activated handoff fixture** was added, because the supervisor now requires a handoff |
| `r7-owner-lifetime`, `r8-permit-owner-loss` | Carried root corrections: await `entry.promise`; build the valid attachment before removal and retain it | None of the absence/identity assertions were weakened |

The r9 positive test asserts the following:
- open succeeds;
- the v2 runtime is used;
- `owns` covers exactly the routes;
- the route row is published through the host view;
- DEP_A activates on bound evidence;
- DEP_B is held for "legacy work in this process", and once that clears it is held for "does not bind this route" (wrong digest);
- a second owner is refused;
- there are zero chain/VM/permit calls;
- the exact release succeeds and all three locks can be acquired again.

## 3. Still not done (honest)

1. **Useful stage/serve/renew after a real activation is not tested through the real factory.** That needs the real two-manager rig with a store and control composed under the real owned runtime. Stop/Offline/owner loss through this exact composition is also untested. Earlier tests cover the supervisor with pre-activated fixtures.
2. **There is no production quiescence verifier.** The module is owner-selected and hash-pinned. A proof module for old-ledger quiescence, built on the derived reader, still has to be written and reviewed. Until then routes stay HELD (fail closed).
3. `Host.lifecycleView()`, `#protectedLaunch`, `#legacyHandoff` and `#protectedWithdraw` have **no direct test** (a full Host needs chain/enclave state).
4. **Configuration source for event-driven apps.** appRef/configCid/resources still come from the legacy row. Authority (state, assignment, finality) comes from the owned snapshot. The config should move to the authenticated new-ledger snapshot.
5. **Capacity.** The dispatch's allocation accounting is driven by its own `reconcile`/`observe`, which never runs because there is no cadence. Host capacity relies on the host's `shareUse` and the manager's precheck. `capacityUnresolved()` is not consulted.
6. **Native manager role and routing are not implemented in r9.** `allpp`→legacy routing and the V8/native protected refusal are unchanged. Not done:
   - manager-role/instance/epoch-owned routing through manager main/compose and router main/control/io;
   - protected native stage/serve;
   - a native neighbour in the two-manager composite.

   There is no claim of a native implementation.
7. **Per-workload boundaries are unchanged in r9:** KVM desktop, GPU, worker, egress, secrets, volumes, storage, ports and command sockets, including late stream/dial completion tracking and revocation-close. The generic permit boundary is still the only enforced boundary. Hung-relay-independent compute removal, finite staging bootstrap and the remaining clock/boundary-retry cases carried from r8 also remain.
8. **Lock reconciliation.** I added `overrides.ws = 8.21.1`, matching both installed lock entries and their existing integrity: no download and no invented hash. It sits in package.json and the lock root. The coordinator must verify `npm ci --offline --ignore-scripts` accepts it. If npm does not record overrides in the lock root, the lock edit should be dropped.
9. **Not qualified:** Windows Job/EXLOCK, the real Base/finality chain, and production. Linux flock is not Windows qualification.

## 4. r8 work kept

All r8 behaviour is kept: owner-after-await checks on both permit return paths, raw unknown-stage cancellation/exact-retirement, bounded retries, durable pending/cold recovery, the router epoch cancellation, Stop/Offline bypass and the read-only reader. The gate and runtime files are unchanged; only the five product files listed in RELEASE-CLOSURE-R9.json were edited.
