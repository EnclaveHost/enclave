# Windows permit r12: author report (SOURCE ONLY, AUTHORED, NOT RUN)

**NOT DEPLOYABLE.** I wrote all of this with Read/Grep/Write/Edit only. I ran no tests, builds, modules, network calls, signing or transactions. Every assertion below is **authored and not run**. The only executed results are root's r11 results; I quote them and did not reproduce them. This pass edited the r11 seed and did not overwrite older evidence.

## 1. Executed results (root r11) versus findings versus authored assertions

- **Root executed (r11):** isolated90 = 88 PASS / 2 FAIL.
  - The first failure was the r8 direct-supervisor fixture, which lacked a pinned policy. Root's external correction passes 4/4.
  - The second failure was the fresh-module restart case, which allowed a second inert write.
  - The initial shared-process run (89 = 57P / 32F) was mock leakage, not 32 product defects.
- **Source findings (peer r11 review):** I repaired them in source (§3). The repairs are not executed.
- **Authored assertions (§4):** none of them have run. Two named fixture inputs are **not verified by me** (§4.1).

## 2. First deliverable: actual consuming path, authored first

`test/windows-permit/r12-real-consumer.test.mjs` exercises the full chain:

1. Actual `Host` (`protectedTick` → `#protectedPass` → `#protectedLaunch` → `#isolationReconcile` → `isolationVerdict`/node-bridge `isolationPlan`, plus `Host.lifecycleView()`).
2. Real `isolation-lifecycle.reconcile`.
3. Real `protected-supervisor` (pinned enrollment, per-route lanes, live new-work fence).
4. Real `composeProtectedAuthority`.
5. Real R18 `openOwnedHostRegistryLifecycle` (owned parent, incarnation and permit journals under flock).
6. Real dispatch: attach, activate, observeRoute, admitStart, settleStart.
7. `DeploymentPermitGate` and `createIsolationLifecycleRuntime`.
8. `ProtectedIsolationClient` and real `GuestdControl`.
9. Router `CompositeManager` (snapshot, precheck, admission, attest, observePending).
10. Real `ProtectedManager`, guard, and router `dataServer`.
11. TCP echo.

The positive steps are:

- queued → one exact stage, and repeated passes stage nothing new;
- readiness → Running;
- off-chain witness permit, then a refresh with an **increasing sequence and a new digest**;
- TCP response through the router splice;
- authenticated Stop → stream closed, exact removal, record `stopped`;
- `protectedShutdown` exact owner release;
- `fixture.sends == []`: zero claim/renew/release/heartbeat, and zero retired ledger/catalog reads.

The same file also covers two races:

- **Finding 1:** a plan built on context A followed by context B at admission causes no old-body start; the next pass replans and stages from B.
- **Finding 2:** policy corruption after the plan's awaits sends no stage POST, and Stop still withdraws.

This file replaces three r7 fixtures in the new positive: the TEST in-memory lifecycle journal, the TEST owned-runtime composition and the pre-activated handoff. It also replaces the r9 `read:never` adapter, the TEST host view and the inert adapters.

**TEST fixtures (labelled in the file), all external inputs:**

- the chain adapter `read()` returns snapshot inputs (the real dispatch and factory still decide);
- the owner-selected quiescence verifier module;
- the witness collector signing with **public TEST** witness keys;
- the Host's external service modules: chain.mjs sends are inert spies, plus the secrets probe, caps and platform gate;
- JSON Hyper-V inventory, launcher and readiness doubles, and TEST headroom;
- a public TEST operator key.

Linux flock is not Windows or native qualification.

### 2.1 Fixture inputs I could not verify (root's first run qualifies them)

- **(a)** The host-admission decision fields and `hostIncarnation` shape that the owned authority derives from the adapter read (`DECISION_KEYS`, `validateHostIncarnation`). I did not trace them in this pass.
- **(b)** Whether the Host plan inputs (strict `appConfig` with an empty `configCid`, `isolationPlan` over the TEST component vector) produce the spawn body the router precheck accepts.

If either fails, correct the fixture. Do not add a product bypass, and do not weaken an assertion.

## 3. Consumer repairs (source)

### 3.1 Plan body binding (finding 1)

- `protected-isolation.mjs` exports `planBasisOf(snapshot)`. It covers deployment, access, assignment state/host/generation/revision, resources, content pin, owner configuration and host incarnation. Observation fields are excluded.
- `ProtectedSupervisor.reconcile({ id, body, basis })` stores the frozen body together with its basis.
- `runtimeAdapters().plans.read(id, snapshot)` reports `verified` only when:
  - the plan was not replaced during the capability await, and
  - `plan.basis === planBasisOf(snapshot)`.

  Here `snapshot` is the exact snapshot the runtime stages, which is the dispatch admission's fresh read. A body without a basis is refused.
- `health()` (no snapshot) checks only name and capability, and has no side effect.
- Host `#protectedLaunch` passes `basis: snap`, through `#isolationReconcile` and `isolation-lifecycle`, for both the normal reconcile and the restart-recovery reconcile.
- The dispatch's own `startChange`/`startIdentity` check stays in place (fresh versus planned).

### 3.2 Policy re-checked after every await (finding 2)

- `ProtectedIsolationClient` takes `newWorkRefusal`. It is called synchronously immediately before the stage POST (before any durable record) and immediately before the permit POST. That is, after every await on the way there.
- The supervisor's `newWorkRefusal()` refuses during graceful shutdown or owner loss, and otherwise calls `policyNewWorkRefusal()`, which re-reads and re-hashes the policy file on every call.
- After `ensureStaged` returns, the supervisor checks the fence again. A start refused by the fence is reported as `fenced`, never as ended/failed.
- Withdrawal, hold, stop, cancel and read-only reconciliation never consult the fence. The established policy stays the single owner, and a new configured policy is never adopted silently.

### 3.3 Terminal reservation discharge (finding 3)

- `lifecycle-host-dispatch.settleStart` accepts `rawUnknown` as a predicate.
- Before the inventory await it checks the token, the predicate and the journal commitment. **After** the await, synchronously right before discharge, it checks the token, the listing, the predicate and a fresh journal read again.
- A running intent or an unknown raw operation that appears while the listing is in flight therefore keeps the reservation, even with the same token.
- `admittedRuntime` passes the live predicate. The r10 test double was updated to evaluate it.
- Unknown never counts as zero, and nothing is released on a timeout.

### 3.4 Independent raw cleanup (finding 4)

- `ProtectedIsolationClient.resolveUnknown(deployment)` runs a single flight **per route**. The no-argument form fans out through the same per-route flights. `exactOne` resolves only its own route.
- The supervisor's `#resolveUnknown(id)` skips routes with no unknown stage, and waits at most `UNKNOWN_BOUND_MS` (2 s) for its own route. The cleanup is never abandoned or doubled; late completions land in the client.
- The owner-loss branch now bounds the wait on `reconcileOrphans`.
- New work stays refused while a stage is unknown (`stage()` and `exactOne` both refuse), so no start is duplicated.

## 4. Durable send recovery

### 4.1 Direct sender

- New `control/windows/node/operator-obligations.mjs` provides strict keyed records: atomic replace plus fsync of the file and directory, schema-checked, bounded to 64, and a full store refuses new work.
- `chain.send` writes `{account, chainId, address, functionName, args, nonce, state:"sending"}` **before** `writeContract`. It then updates the record with the hash, removes it when the receipt arrives, and keeps it as `unknown` if the write throws.
- At the start of every job, every recorded write is reconciled read-only:
  - a receipt for its hash ends the record;
  - a mined nonce count past it is a **fence**, not success: the record is removed and `nextNonce` raised;
  - otherwise it blocks with `AmbiguousPriorWrite`;
  - a record from a foreign account or chain blocks.
- A journal that is missing, unconfigured or corrupt refuses every write (`NoWriteJournal` / `WriteJournalUnavailable` / `NotPersisted`) and is never overwritten.
- The Host sets `<dir>/operator-writes.json`; `ENCLAVE_OPERATOR_WRITE_JOURNAL` is the fallback.
- `ambiguousOperatorWrite()` now reads the durable record.
- `test/windows-permit/r12-durable-send-restart.test.mjs` covers:
  - no journal → no write;
  - an ambiguous write is persisted, the same module refuses, a **fresh module** refuses, the mined nonce fences, and progress resumes with a new nonce (never the recorded one);
  - a crash-window record (`sending`, no hash) is unknown;
  - a corrupt journal refuses and is kept.

  It restores env, hooks and globals in after-hooks.
- The root r11 regression file itself does not configure a journal. Against r12 it fails closed at its first assertion with `NoWriteJournal` instead of `unknownOutcome`. The extended test is the configured successor.

### 4.2 Sponsored claim/renew/release

- Each operation has a durable record **before** signing. An unresolved record for an id holds new claim/renew of that id (`SponsoredPending`).
- `onSigned` (called by the bundle after each signature and before any POST) records the intent for **every** kind. Release also keeps its release journal. Each operation holds at most 8 intents.
- Every relay POST is recorded as `posted` before the relay sees it. If that write fails, the refusal is latched.
- If permission ends during `signTypedData`:
  - the signature is recorded durably as `withheld`;
  - the refusal is **latched** on the operation (a restored Boolean cannot revive it);
  - the signature is **not returned** to the client, so it reaches no relay;
  - every later GET, signature or POST of that operation throws the latched refusal, so it never leaks into signing for the next relay.
- On error the record is discarded only if nothing was signed or posted, or if the bundle reported `NonceConsumed` (a fence). Otherwise it stays.
- `resolvePendingSponsored()` (also called from `resolvePendingReleases`) settles records read-only through the bundle's `resolveSigned`: landed, consumed or expired removes the record; anything else holds.
- `withheldLeaseSignatures` changed from an unbounded in-memory array to a function reading the durable journal.
- There is no operator-funds fallback.

**Not delivered:**

- **Sponsored tests against the shipped bundle.** No author test drives the shipped `lease-gas-runtime.bundle.mjs` with only external account/RPC/HTTP fixtures. The existing r11 sponsored tests use a TEST lease-client emulator and **are not evidence about the shipped client**. They will also need the sponsored journal env (`ENCLAVE_SPONSORED_OBLIGATIONS`) and the function form of `withheldLeaseSignatures`.
- **Bundle and its source closure.** I made no edits under `readonly-reference/`, did not touch the minified bundle, and authored no generator mapping.

## 5. Changed files (r12)

**Source:**

- `control/windows/node/protected-isolation.mjs`
- `control/windows/node/protected-supervisor.mjs`
- `control/windows/node/isolation-lifecycle.mjs`
- `control/windows/node/host.mjs`
- `control/windows/node/protected-authority-factory.mjs`
- `control/network/lifecycle-host-dispatch.mjs`
- `control/windows/node/chain.mjs`
- `control/windows/node/operator-obligations.mjs` (**new**)

**Tests:**

- `r12-real-consumer.test.mjs` (**new**)
- `r12-durable-send-restart.test.mjs` (**new**)
- `helpers/world.mjs` (`basisOf`)
- Basis carriage added to `r4`, `r5`, `r6`, `r7-supervisor-withdrawal`, `r7-composite`, `r8-unknown-owner-loss`
- `r10` settleStart double

These need root qualification and might fail:

- `r5` calls `basisOf` without a catch. Any step where the TEST authority is set to fail would reject.
- `r11-policy-send-boundary` sponsored and direct cases need the new journal env.

## 6. Remaining (honest, not completed)

- **No author tests yet for findings 3 and 4 or owner loss on the real dispatch.**
  - Finding 3: held inventory, then a new commitment or unknown appears, so the reservation is kept; then exact absence, so capacity can be reused; a stale token cannot discharge a newer start.
  - Finding 4: route A's unknown cleanup is held while route B's authenticated Stop removes B within the bound.
  - Owner loss through this composition.

  The source repairs exist. The tests should be added to `r12-real-consumer.test.mjs` once its positive passes at root.
- **Actual-bundle sponsored consumer tests** (§4.2).
- **Native and workload scope is not started in r12:**
  - protected native manager role, instance and epoch routing;
  - a running native neighbour;
  - protected native serving;
  - KVM desktop, GPU, worker, egress, secrets, volumes, storage, ports and command sockets.

  allpp→legacy and native refusal are not completion.
- **Root qualification** of Base, Windows, native, the dependency closure, funding and the migration: all root-owned.

Optional publisher moderation still cannot veto unchanged owner-authorized content, and enrolled event-driven apps have no periodic on-chain renewal or heartbeat.
