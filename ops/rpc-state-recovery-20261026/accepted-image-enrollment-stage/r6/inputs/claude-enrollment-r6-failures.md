# Enrollment r5 slice (root 1435) failure diagnosis: EARLY report (Claude; source-only)

**Run:** `accepted-image-enrollment-stage/r5/runs/20261026T160454Z-slice-1996795`. It is TERMINAL: `verdict.json` exists, and every suite's `.rc` and TAP summary is present. I read the TAPs only; nothing was killed or re-run.

| suite | result |
|---|---|
| KVM r3 journal-durability | **22/22 PASS** |
| replica exactness | **8/8 PASS** (includes the real cross-process writer, M1/M2/M3) |
| real-KVM composition | **1/6** (test 1 passes; 2–4 time out with `authority` false; 5–6 TypeError) |
| role suite | **5/18** (1 and 15–18 pass; 2–14 fail) |

## Cause 1 (composition 2–4, then 5–6): a FIXTURE defect in the relay stand-in, not a role or KVM fault
- **What the stand-in passes:** `derivedWriterAuthorityFromEnv(process.env, { relayChain: { client: {} }, … })`.
- **Why that fails:** the real adapter, after KVM's `enrollDerivedState` and the real `openLifecycleJournal`, ends in `createDerivedWriterAuthority({ fresh: relayChain.client, … })`. That function requires a deny-only verifier client with `getBlockNumber`, `request` and `readContract` (`relay/derived-writer-authority.mjs:187-188`).
- **Sequence in every derived child:**
  1. it throws "derived writer authority needs the relay's local verifier…";
  2. the stand-in mirrors `api-relay.js`: fatal, then `exit(1)` before listening;
  3. the role's crash guard (correctly) disables derived for that enrollment and retries with backoff;
  4. every retry ends the same way, so `authority` is never true.
- **The enrollment itself most likely completed.** The throw comes after KVM's durable steps. That cannot be proven from the TAP, because the composition suite's role log is discarded (`log: () => {}`) and `fatal.log` lived in the test's temporary directory.
- **Tests 5 and 6** then fail with `pkgFor(leader())` / `leader().roleCfg` being `undefined`. `leader()` requires a running relay, and the relay was in a crash-guard cycle (cause 2).
- **Fix (r6):**
  - give the stand-in a deny-only client stub with the three functions; each throws if ever called, so it can never confirm anything;
  - keep the role log in a file for diagnosis.
  
  No real IPC, floor or ACK check is weakened.

## Cause 2 (role suite 2–14): the test harness used `leader()` where it needed "the primary"
- **The definition:** `leader()` = a primary **with a running relay**.
- **Since r2 (B3),** a successful or refused enrollment quiesces the writer: it stops the relay under the role lock and restarts it afterwards. Admin packages go to the peer port and need the primary, not the relay.
- **Test 2 failed exactly there:** `const ok = await enroll(leader(), g)` succeeded, then `enroll(leader(), g)` (the replay check) ran while the relay was restarting, so `leader()` was `undefined` and `m.ports` threw.
- **Tests 3–14** cascade from the same pattern (`relay(leader(), …)`, `statusOf(leader())` during restarts) and from test 2 not finishing.
- **Fix (r6):**
  - `primary()`: the role leader, relay not required, waited for, for enrollment, status and package calls;
  - `live()`: waits for a primary with a running relay, for relay-API calls.
  
  No assertion is relaxed.

## State transitions checked against the observed failure (role source; no change needed for this failure)
- **B1:** the exit wait resolves at once for a crashed child, because `lastExit` resolves on `exit`.
- **B2:** the term recheck only refuses on a real change.
- **`ENCLAVE_DERIVED_INTENDED`:** only selects the refusing writer authority. It does not block a start.
- **The crash guard behaved as designed:** each derived child exited before listening, so derived was disabled with backoff. That is the fail-closed outcome for a reader that cannot start.
- **Not fixed in r6:** the guard's progress rule (retry on committed-state change) cannot help when the failure is AFTER enrollment, so a permanently failing start is retried only by the backoff timer. That is intended.

## r6 plan (source-only; r5 and its tree stay frozen)
1. The composition stand-in gets a deny-only verifier client stub, plus a role log file.
2. Both suites use `primary()` / `live()` helpers.
3. **New test** (review item 7): stop with a commit in flight. With the replica round delayed, the derived child is SIGKILLed while its commit holds the role lock. The commit completes, the reply to the dead child is harmless, and the restart's seed (queued behind it) carries exactly the committed bytes on every member.
4. **Unchanged and still required:** the never-enrolled restored group's admin recovery path. It is not hidden, and is prioritized after the positive paths.
5. KVM r3, floors, the 120 s ceiling and admin controls are all unchanged. No HOME override.
