# Independent review: management release/move (2026-10-19)

**Scope:** read-only review of `work/enclave` at HEAD `d0676ff3`, plus the uncommitted move work described in
`work/claude-cli-release-result.md` and `work/independent-move-interface.txt`.
- No production source was edited and nothing was committed.
- Evidence comes from a source trace and a pure directed timing model. The model lives only in
  `/tmp/move-review-model/` and peaked well under 128 MiB.
- No Anvil was used. The move suite peaks at about 650 MiB, over this round's 250 MiB budget, and in any case it cannot
  reach these paths (finding 6).

The short handoff is `work/independent-move-review-interface.txt`.

## Verdict

**BLOCKING.** The release can end a lease whose app is running, or report `released:true` while an app runs without a
lease. The contract behaves as written; the defect is on the host side. Every trigger below is reachable under default
settings with ordinary chain latency or an ordinary stale RPC. None needs an attacker. The remedy fits within the
deployed contract, except for one residual: a shared operator key across hosts.

The rest of the slice reviewed sound:
- the scope table and outcome classes;
- gateway `reauthorize:false` for `release`;
- the named-host `claimHint` rule;
- the signed claim-hint owner check against the ledger row;
- CLI quorum finality, with no hint before a quorum-confirmed release;
- one release, never resent by the CLI.

## Ground truth (source)

**The ledger (`contracts/EnclaveDeployments.sol`):**
- **`release(id)` (1153-1171):** checks only `d.runnerOperator == msg.sender`.
  - It takes no runner or epoch argument and has no liveness check.
  - It clears runner, operator and `leaseUntil`, refunds the tail, and resets `provenUntil`.
  - So any `release(id)` this key signs ends **whatever lease that operator holds when it is mined**.
- **`claim` (1080-1111):** requires `block.timestamp > leaseUntil` and that the registry entry's operator is the sender.
  The **registry lets one operator own any number of entries** (`EnclaveRegistry.sol:183-190`, id = keccak(endpoint)).

**The supervisor (`supervisor.js`):**
- **Shared gas keys are a real pattern.** The supervisor itself says "On a SHARED gas key several enclaves sign as the
  same operator EOA but have distinct enclave ids" (`supervisor.js:9943-9947`).
- **Release route (7583-7640):**
  - `holds()` compares **only** `runnerOperator` (7594).
  - The holdoff is armed **before** the stop (7599), and `MOVE_HOLDOFF_MS` defaults to 120 s (7451).
  - The status becomes `"expired"`, a `CLAIM_TERMINAL` status, before the final proof and the release (7611).
  - The 503 path starts `releaseLease` **without re-arming the holdoff** (7632-7638).
- **`sendOperatorTx` (9341-9348):** serializes only up to each receipt wait, and `awaitReceipt` times out at 90 s
  (9332). A timed-out transaction keeps its nonce and can mine later; the next queued transaction is sent anyway.
- **`releaseLease` (9511-9527):** 4 × `release(id)` with backoffs of 15/30/45/60 s. It does no read between attempts.
- **`considerClaim` (10469-10552):**
  - it refuses only non-terminal records (10473) and the holdoff (10551-10552); it never consults `_releasing`;
  - a live lease naming our own enclave id **resumes with no transaction** (10484-10485);
  - an open record is **re-claimed**.
- **Callers of `considerClaim`:**
  - the sweep, every 60 s, resume-first (10360-10367);
  - the **unauthenticated** `/v1/claim-hint` (5438 → 5502);
  - the signed `/v1/deployments/:id/claim-hint` (5455);
  - and only in the self-test harness, 11097.
- **`auditClaims` (9950-10000):** a running record whose lease is gone is torn down only after **two** consecutive
  passes.
- **`performTenantProvision`:** sets `rec.status = "running"` unconditionally after its spawn (7125).

## Findings

### 1. BLOCKING: self-resume during an in-flight release, then `200 released:true` with the app running (A)

**Mechanism:**
- The route spends stop + final proof (up to 90 s receipt) + release (up to 90 s receipt) on the shared operator queue,
  behind any queued renewals or claims.
- Once 120 s have passed since the holdoff was armed, the record is `"expired"` and the lease still names this enclave.
  So the sweep, or **anyone** via the public hint, resumes the app with no transaction.
- The release then mines, `holds()` reads false, and the route answers **200 `released:true`**. The app is running here
  with no lease.
- The CLI hints the target, which claims. Both copies run until the source's audit tears its copy down two passes later.

**Model, scenario A** (checkpoint inclusion 80 s, release 75 s):
- resume at 150 s;
- release mined and `200 released:true (app=RUNNING)` at 158 s;
- target claims at 164 s;
- **two copies for 106 s**, until the strike-2 teardown at 270 s.

The answer is a false early success, and the duplicate serves two copies of a tenant's app (state, keys, side effects).

### 2. BLOCKING: an old retry ends the source's own new or resumed lease (B)

**Mechanism:**
- The release mines, but the route's single-RPC `holds()` reads stale, so it answers 503.
- `releaseLease` retries without re-reading, and the holdoff is not re-armed.
- After 120 s the source re-claims (the "falls back here" path) or resumes.
- A later retry is a later nonce on the same queue, so it mines **after** the claim and ends the new lease while its app
  provisions or runs. The tail is refunded and the app keeps running without a lease until the audit's second strike.

**Model, scenario B** (30 s read lag, retry inclusion 40 s):
- re-claim mined at 180 s;
- `release-retry4` mined **success** at 261 s;
- the app runs leaseless until the teardown at 360 s, then re-claims at 420 s.

The same path also follows a receipt timeout on a slow chain, with no stale read at all. The pending first release plus
a retry gives two releases in flight.

### 3. BLOCKING (partly a contract boundary): a retry ends a same-operator target's lease (C, C2)

**Mechanism:**
- The target, or a reacquiring sibling, runs under the **same operator key** with a different enclave id. The registry
  allows this, and the supervisor documents it.
- After the quorum shows the release, the CLI hints, and the target claims.
- Any source `release(id)` that mines afterwards succeeds against the **target's** lease, because the operator matches.
  The target's app runs without a lease.

**How `holds()` misclassifies:** it compares only the operator, so a same-operator target's lease reads as "still
held". That 503s the route, starts retries, and keeps them firing. `stillHeld` in the 503 body is also wrong.

**Model:**
- **C** (20 s lag): `release-retry2` succeeds at 76 s against T's claim from 36 s. The final ledger shows runner `null`
  while T's app runs.
- **C2** (no lag; the release receipt times out at 90 s and mines at 107 s): the CLI's 15 s window sees the release, T
  claims at 122 s, and `release-retry2` succeeds at 162 s.

### 4. BLOCKING: a release accepted mid-restart or mid-provision answers `released:true` while the app comes up (D)

**Mechanism:**
- The route accepts any status and checks neither `rec._restarting` nor `tenantProvisions.has(rec)`. (The reverse
  direction is safe: the restart route refuses non-`running` records, 7904.)
- During an owner restart (status `"claimed"`, old VM deleted at 7910), `stopContainer` deletes the old `_vmId`
  (404 = `true`, 4325). The release lands and the answer is 200.
- `performTenantProvision` then sets the status to `"running"` (7125). The app runs leaseless next to the target until
  the audit's strike 2.
- The same window exists for a claim-time provision.

The restart and release share one scope (`api.restart`) and one session, so a single owner, or two of their tabs, can
trigger this.

### 5. MAJOR: the operator-only pre-check (`holds()` at 7596-7598)

On a shared key, a local record that is not this enclave's lease passes the check. An example is a stale `"failed"`
record whose lease a sibling now holds. The route then stops the local copy and releases the **sibling's** lease.

Through the management gateway this is closed: the current-lease rule requires `row.runner` to equal the gateway's
runner. But the supervisor route is also reachable through its other `ownerAuth` bases, and the check must be the
route's own.

### 6. MAJOR: none of this is tested

The rig runs the actual supervisor with `CLAIM_ENABLED: ""` (`test/helpers/cli-independent-rig.mjs:408`). That means:
- no sweep, no resume, no re-claim and no audit;
- `release_unconfirmed` and its retry, the holdoff lapse, a same-operator target and the restart race are never
  exercised.

The 503 path is only unit-classified (`test/management-move-unit.test.mjs:37`), matching gap 5 of the result file. The
passing 6/6 says nothing about findings 1-5.

### 7. MINOR: CLI (`cli/enclave.mjs` `cmdMoveIndependent`, 5191-5262)

1. **It never compares the target's registry operator with `m.d.runnerOperator`.** `moveSnapshot` already returns
   `host.operator` (`cli/independent.mjs:207`), so the refusal costs nothing. The release-side remedies do not close
   finding 3 for an in-flight release, so the CLI must refuse.
2. **A source re-claim is reported as "queued".** `landed` ignores the source's re-claim when `m.held` (5253-5254). If
   the source takes the record back after its stand-down, the CLI prints "released and queued: no host has claimed it",
   which is false. It should report "claimed back by the source".
3. **A natural expiry inside the window is reported as "lease released (quorum …)" (5229, 5240).** Ledger-wise this is
   harmless, but the wording claims a release that did not happen. Say "no live lease" unless a `Released` event or a
   cleared runner is seen.

### 8. NOTE (unchanged code, same bug class)

The legacy DELETE → `proveAndRelease` → `releaseLease`, the provision-failure releases (7917, 10007) and the
setActive(false) teardown (9957) all send id-only releases with blind retries. The remedy's helper should cover them.
The previous result file records DELETE as deliberately unchanged; it is listed here only so the fix is shared, not
forked.

## Supported remedy (no contract change; feature parity; no false early success)

1. **Decide on the lease epoch, not the operator.**
   - At decision time, require `d.runner === _enclaveId && runnerOperator === me && leaseUntil*1000 > now`, and snapshot
     `{runner, runnerOperator, leaseUntil}`. This closes 5.
   - "Released" means a **success receipt carrying `Released(id, _enclaveId, …)`**. That receipt is proof at its block,
     and no later stale read may turn it into a 503 (closes the trigger of 2 and C).
   - Any confirming read is taken at `blockNumber >= receipt.blockNumber`. A lagging node then errors instead of
     answering stale.
2. **One release transaction in flight per id.**
   - A receipt timeout is not a failure. Keep polling that hash until it mines, or until the operator's latest nonce
     passes its nonce (dropped or replaced).
   - Only then read again (at or after that block). Retry only if the **same epoch** is still present, and stop the moment
     it is not.
   - The legacy `releaseLease` callers use the same helper.
3. **Make the stand-down track the release, not a timer.**
   - While `_releasing` holds the id, `considerClaim` refuses it (for the sweep and both hint routes). This
     includes the resume path.
   - `_releasing` is cleared only once every release sent for the id has resolved. The holdoff is re-armed (120 s) from
     that moment, on both the 200 and the 503 paths.
4. **Refuse transitional records.** The release route answers 409 with nothing stopped while `rec._restarting`,
   `tenantProvisions.has(rec)`, or the status is `claimed` or `stopping`. A failed or paused record that holds the lease
   stays movable.
5. **CLI:** refuse a target whose registry operator equals the source's `runnerOperator`, and fix the two messages in
   finding 7.
6. **Tests:**
   - an actual-supervisor run with the claim loop on (`CLAIM_POLL_SEC` small, `MOVE_HOLDOFF_SEC` 30);
   - a delayed-mining or stale-read proxy forcing `release_unconfirmed`;
   - assertions: no resume or claim while releasing; no successful release mined after any later claim; a
     same-operator target refused by the CLI; release-during-restart refused.

**Model check of 1-3** (`node /tmp/move-review-model/model.mjs both`): A, B, C and C2 all end with exactly one running
copy holding its own lease. In C and C2 the retries stop on "earlier release resolved, epoch gone". In A, the resume is
blocked and the answer is `released:true (app=stopped)`. In B, the source re-claims cleanly only after the stand-down.

## Contract boundary (residual)

**What only a contract change can close.** A `release(id)` from a key shared by two hosts names no lease. A transaction
already broadcast cannot be recalled. A cancelling self-transfer at the same nonce is best-effort only. And two
supervisors sharing a key do not share `_releasing`. So a same-operator move, or a same-operator sibling claiming
while a release is pending, can still end the wrong lease. Only an epoch-checked
`release(id, expectedRunner, expectedLeaseUntil)` in a new ledger revision closes that.

**What the remedy reduces it to.** The CLI refusal (remedy 5) and the one-in-flight rule (remedy 2) make the residual
unreachable through the move feature itself. What remains is an out-of-band sibling sharing the key.

The existing boundary in the result file (a dead or hostile source can only be waited out, and placement is a steer) is
unchanged and correctly stated.

## Model limits

`/tmp/move-review-model/model.mjs` (162 lines, deterministic) is **not** the supervisor. It restates:
- the route's control flow;
- `sendOperatorTx`'s per-receipt serialization with the 90 s timeout and nonce order;
- `releaseLease`'s schedule;
- the holdoff, the resume-first sweep and the 2-strike audit;
- the ledger's `claim`/`release` predicates.

It uses scenario-chosen inclusion delays and read lag. It does not model:
- `stopContainer` latency beyond a constant;
- provisioning time;
- the gateway;
- the CLI's quorum, beyond a fresh read;
- gas, replacement or reorgs.

The timings are chosen to be plausible (tens of seconds to inclusion on a public RPC; the supervisor's own comments
record 122 s queue ticks, at 9324-9329), not worst cases.
