# Windows permit r11 — author report (source only)

**Status: NOT DEPLOYABLE. Integration is NOT complete.** This pass made source edits and authored tests, and **ran nothing**: no tests, builds, hashes, network, signing, transactions or services. Every assertion below is authored and not yet run unless it is labelled *root executed*.

## Evidence classes

- **Root executed (r10, carried):** Focused52 = 51/1. External r5 + policy9 = 7/2: both policy-cache failures. Direct send4 = 1/3: claim and release drop the gate, and renewal writes after the permission flips during simulation. Route-progress9 = 8/1: one route's held plan blocks another route's Stop.
- **Source findings (root r10 review):** stale snapshot staged after a fresh host decision; reservation not discharged on terminal stage outcomes.
- **Author r11:** the source repairs and authored-not-run regressions below.

## 1. Dynamic policy validity (`protected-supervisor.mjs`)

- `observeEnrollment(env)` re-reads and re-hashes the configured policy on **every** call. It is a small pinned file, and mtime is not trusted.
- The first observation establishes the epoch: the configured file/sha pair, or "none".
- Afterwards, any of these is `unknown`: a changed path or sha (including none → configured), a missing file, a corrupt file, or a hash mismatch. `enrolledByPolicy`, `enrollmentState` and `enrolledDeployments` all go through this check, so every existing Host final gate (claim, renew permit, release, keeper, the `#lifecycleNewWorkHold` legacy hold) now sees post-decision changes.
- Under a valid, unchanged policy, known unenrolled neighbours stay `false`, so they remain usable.
- The **established** policy keeps its single supervisor, so there is never a second owner:
  - `protectedSupervisorFor` still returns it when the file becomes unknown.
  - `establishedEnrolledDeployments()` feeds the Host's authority pass, so Stop/Offline/withdrawal and cold recovery continue.
  - `#newWork` refuses through `policyNewWorkRefusal()` at entry, after the capability await, and before `serve`.
- `TEST_reset` is not used as an invalidation mechanism. No request flag is consulted.
- **Limit:** adopting a changed policy requires a process restart; it is never live re-enrollment.

## 2. Final side-effect gates (`chain.mjs`, `host.mjs`)

### Direct sender

- The gate is re-asked at the queue, after the ambiguity check, after `simulateContract`, after `nonceFor` (immediately before `writeContract`), and after a retry backoff.
- Only pre-write failures are retried, and only once, as before.
- A throw from `writeContract` itself is **ambiguous**: a fallback transport may already have broadcast it, and `already known`, `replacement underpriced` and `nonce too low` can all be this same transaction. In that case:
  - the outcome is recorded as `ambiguousWrite {nonce}`;
  - `nextNonce` is **not** advanced;
  - the error carries `{unknownOutcome, pending, nonce}`;
  - every later send from this key is refused with `AmbiguousPriorWrite` until the **mined** count passes that nonce. So there is no duplicate send, no new-nonce send, no replacement and no cancellation.
- A sent transaction whose receipt is lost carries `{sent, hash}` and is never resent.
- **Behaviour change:** after an ambiguous write, a renewal is not retried within the same job.
- **Remaining gap:** a write that never actually reached any RPC blocks this key until an operator intervenes. No automatic resolution or operator tool for that case is implemented.

### Claim and release

- `claimDeployment(id, enclaveId, opts)` and `releaseDeployment(id, opts)` now forward `opts.gate`.
- The Host passes live gates:
  - **claim:** enrollment, platform service refusal and lifecycle new-work hold;
  - **release:** enrollment, and "tracked here again".
- A gate-refused release retains tracking and records `held`, the same as the pre-send boundary does.

### Sponsored path

- `chain.mjs` hands `configuredLeaseSender` a **gated account** (`signAuthorization` and `signTypedData`) and a **gated fetch** (any non-GET, i.e. the relay POST).
- Source inspection of the *shipped* bundle shows it forwards both: `{...s, ...a, account:t}`, `fetch:s.fetchImpl`, and the POST goes through `Sy(c, …/v1/lease, {method:"POST"})`.
- The repair therefore sits in the real consumed path **without touching the minified bundle**. This is not a "repaired bundle" claim.
- Permission is asked immediately before each signature and each POST. Once an operation is refused, it signs nothing more and contacts no further relay.
- Read-only receipt and nonce reconciliation run through the client's RPC set and are untouched.
- **Permission ends during signing:** the signature is kept. For a release, the bundle's `onSigned` journals it before the refused POST, and the entry stays `pending`, never "unsent". For claim/renew it is kept in `withheldLeaseSignatures`. That list is **in memory only, not durable**; it was disclosed to no relay.
- **Refusal after an earlier relay's POST:** reported as `unknownOutcome/pending`, never as unsent.
- **Not changed:** existing consent, caps, nonce, funding and integrity checks. There is still no fallback to operator funds.

## 3. Fresh deployment snapshot binds the start (`lifecycle-host-dispatch.mjs`, `protected-authority-factory.mjs`)

- After `freshDecision`, `admitStart` compares the fresh authenticated snapshot with the planned one. It compares state, generation, host, resources, content appRef/cid, envelope configCid/owner, access and forPrivate.
- Any difference refuses the start, and the next pass replans.
- Capacity and reservation are computed on the **fresh** snapshot, and the admission returns it.
- `admittedRuntime.ensureStaged` stages `protectedSnapshotOf(adm.snapshot)`, never the caller's older copy.
- The real ABI and proof path are kept as they were (configCid/owner are already present).
- **Not covered without host registry (HR off):** there is no fresh read, so the start uses the supplied snapshot, which comes from the authority pass just made.

## 4. Exact terminal reservation discharge

- The admission token is held in the allocation.
- `settleStart` releases a reservation only when **all** of these hold:
  - the same admission still owns it;
  - the caller reports no unknown raw operation;
  - the owned journal has no pending or mined running intent;
  - a fresh manager listing is definitely absent, re-checked after that await.
- `admittedRuntime` calls it:
  - on `ended:true` (refused spawn, or the runtime's own startup-deadline stop);
  - on a throw, only when the supervisor's `client.unknownStages` lacks the id.
- `launch outcome unknown`, a listed failed instance, a commitment, or an unknown predicate all keep the reservation.
- `retired()` clears the token. Max-of-known shares is unchanged.

## 5. Bounded per-route authority (`host.mjs`, supervisor)

- `protectedTick` no longer has a shared guard.
- Each route's authority runs on its own lane:
  - the supervisor serialises calls **per id**, and each call makes a fresh read;
  - the Host joins an in-flight pass and bounds its own wait to 15 s;
  - the raw promise is kept until it settles, so it is never forgotten or doubled.
- New work is single-flight per route and is never awaited by another route.
- A withdrawal bumps the route epoch. Late new work then triggers a fresh authority pass, so it is fenced or removed rather than kept.
- `resolveUnknown` is single-flight.
- **Assumption for root to check:** concurrent `authority` calls for **different** routes are safe with the actual runtime.

## Authored tests (NOT RUN)

- `test/windows-permit/r11-policy-send-boundary.test.mjs`, 17 cases. All use the actual modules with an inert TEST viem account/RPC/wallet:
  - **Policy (6):** carries both root failures, plus a changed path, none → configured, the neighbour positive, and the initial-corrupt control.
  - **Direct sender (6):** claim/release gate (root FAIL), simulation flip (root FAIL), nonce-read flip with no nonce spent, retry re-gate, ambiguous write (no resend, blocked until mined, then nonce+1), and the positive once-only send.
  - **Sponsored (5):** sign-time flip, release journaled pending, post-POST unknown, queue refusal, positive.
  - **Caveat:** the sponsored cases use a **clearly labelled TEST lease-client emulator** of the reference per-relay order, not the shipped bundle. Root should rerun with the actual bundle and the reference fixture `source/test/helpers/windows-lease-runtime-fixture.mjs`.
- `test/windows-permit/r10-host-independence.test.mjs`, 4 appended r11 tests. They use the actual Host and supervisor with the same labelled TEST external runtime:
  - the root route-progress case, plus no duplicate plan and progress restored afterwards;
  - a hung authority bounded and joined;
  - a corrupted policy still withdrawing but starting nothing;
  - the actual `admittedRuntime` fresh-stage and settle rules (TEST dispatch double).

## Remaining work (unfinished, not excluded)

- **Real-dispatch fresh/terminal regressions.** `startChange`/`settleStart` need a host-registry fixture that gives `freshDecision` a valid incarnation decision. I could not author that blind; the existing r10 real-dispatch test uses `read: never`. Needed: a stopped / different generation / host / config / resources refusal, an identical-fresh positive through stage, and stage → ended/refused/deadline-stop → absent → usable capacity, with pending-unknown retention.
- **REQUIRED positive real consumer — not delivered.** Actual Host + real factory/journals/gate/runtime + real client/manager/router: queued → readiness → Running → TCP → off-chain permit refresh → Stop/Offline/owner-loss removal, with zero periodic chain renewal. Integration must not be called complete without it.
- **Native protected roles/workloads:** untouched (manager/main/compose, router main/control/io, KVM/GPU/worker/egress/secrets/volumes/ports/command sockets).
- **Retained from earlier rounds:**
  - full A/B/C/D;
  - the production quiescence verifier;
  - backward-clock / expired-old-guard / boundary-retry cases;
  - graceful-release fencing;
  - durable storage of withheld claim/renew signatures;
  - operator resolution of an ambiguous write that was never broadcast.
- **Qualification:** ws/npm acceptance; Windows, Base, production and financial qualification. All are root-only.
