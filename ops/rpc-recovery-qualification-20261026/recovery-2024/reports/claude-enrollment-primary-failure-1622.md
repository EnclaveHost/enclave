# 1622: integrated r5 enrollment failure (root 1619/1621) — root cause and the integrated r6 fixture fix (source only; NOT run)

**Evidence read:**
- `writer-integrated-stage/r5/runs/20261026T200259Z-check-2259482/logs/enrollment.tap` and `enrollment-role-{0,1,2}.log`;
- root's receipt `logs/integrated-r5-enrollment-stop-1621.json`;
- the r5 sources from `writer-integrated-stage/r5/release.git`, read-only: `test/derived-state-enrollment.test.mjs`, `metal/guest/platform-api-role.mjs`, `relay/state-replica.mjs` and `metal/guest/derived-state.mjs`.

**Not done:** I mutated nothing in root's running repo or in r5. The r5 failed qualification is retained. I ran no tests, builds, network, live or USB.

## What happened (from the logs)
1. **Role-2 was primary for epoch 1** (20:04:21). Test 2's thirteen negative packages plus the tampered package each quiesced its writer. The role log shows 14 `relay stopped (derived enrollment: writer quiesced)` → restart cycles between 20:04:23.688 and .777. Then `relay serving (primary, epoch 1)` at 23.816.
2. **At 20:04:26.020 role-2 logged `step down (lease expired)`.** Role-0 became primary for epoch 2 at 26.355.
3. **The positive genesis failed in the gap.** The test (lines 221–222) built the package for one `await prim()` and sent it to a **second, separate** `await prim()` call. The request reached a member that was no longer leading, which answered `409 {"error":"not_primary","leader":2}`. That stale leader view of 2 is consistent with role-2 itself, just after it stepped down.
4. **Everything after it cascaded:** tests 3–13 need the genesis. Root stopped the suite (1621).

## Root cause: an unsynchronised fixture primary, NOT a production protocol bug
- **The refusal was correct and side-effect free.** `derivedEnroll` returns `409 not_primary` **before** the signature check, the lock, quiesce or any write when `node.role !== "leader"` (`platform-api-role.mjs`, `derivedEnroll` first lines). The in-lock re-check is the same. Nothing was written.
- **The step-down is the lease safety rule working.**
  - **The rule:** `relay/state-replica.mjs` `_tick` steps down when `now ≥ leaseUntil`, and `leaseUntil` = the send time of the last **majority-acknowledged** round + `leaseMs` − `leaseMs/5`.
  - **In this fixture:** `leaseMs` is 2000 (the configured minimum), so the window is 1600 ms. Heartbeats every 666 ms run on a 333 ms tick that skips while busy.
  - **What it means here:** the "lease expired" path (not "could not be renewed") means no round was acknowledged for ≥ 1.6 s.
- **What the integration changed — none of it is in this path:**
  - `relay/state-replica.mjs`: **unchanged** (diff against the pre-integration base `cff4690a`: 0 lines).
  - `metal/guest/platform-api-role.mjs`: only the 21-line `composeDerivedReader` hunk (the rollup pin and witness URL checks, which run inside `derivedPlan` on relay start).
  - `measured-control.mjs`: only the optional-key canonicaliser.
  - **History r5:** not used by the fixture.
  - **Not in the path:** none of these touches lease, heartbeat, commit, election or the enrollment protocol.
- **Unknown, not proven by the logs:** why one round was not acknowledged in time.
  - **What I can rule out:** it was not a refusal (that would log "could not be renewed" or "a member follows a newer epoch").
  - **Plausible cause:** a ≥ 1.2 s stall in the single test process that hosts all three role instances in-process (their relays are child processes). For example, CPU contention during root's `check` run with the deliberate 14-cycle quiesce/spawn churn just before.
  - **I do not claim this as fact.**
- **A production observation (not causal, no change made):** a relay deliberately killed by `stopRelay` (quiesce) still reaches the child `exit` handler's "restarting in N ms" branch, so the backoff doubles on intentional kills.
  - The scheduled `startRelay()` is a no-op while a child exists (`if (child || stopped || startQueued) return`), consistent with role-2 logging nothing after 23.816.
  - It is a cosmetic or backoff-accounting issue for KVM/role review, not this failure. **Not changed** (minimal fix).

## The fix: integrated r6 (a test-only change; no production file changes)
**`test/derived-state-enrollment.test.mjs`:**
- **`onPrimary(make, { tries = 3 })`:**
  1. it takes a primary **with its relay** (`live()`, so past any quiesce or restart);
  2. it runs **a fresh majority round on that member** (`m.role.node().commit() === true`, the same round the role's own barrier uses), so its lease is renewed now;
  3. it records the term (member, boot `statementSha`, `epoch`);
  4. it builds the package **for that member's boot**;
  5. it sends it **only while the same member still leads the same epoch with `leaseValid`**.
- **Retries happen only on a PROVEN loss of that term:**
  - the term was lost before sending (nothing was sent), or
  - **that member's own** `409 not_primary` **and** the term no longer holds (the code proves this answer had no side effect).
- **Bounded:** at most 3 attempts, then a thrown error naming each loss.
- **Never retried; returned unchanged for the assertion:** any other answer — 403 (`not_admin`, `wrong_target`, `not_for_this_boot`), 409 (`not_newer`, `wrong_previous`, `state_changed`, …), 422, or 503 (`not_committed`, `outcome_unknown`). An invalid signature, an unknown outcome or a wrong state is **never accepted**.
- **Test 2 (positive part only):**
  - **genesis:** `onPrimary(m => pkgFor(m, {}))` → **200**;
  - **replay:** the exact package to the same member, or the **same signed statement (same `at`)** bound to a successor's boot → **409 `not_newer`**;
  - **a second genesis:** → **409 `wrong_previous`**;
  - **`statusOf(await prim())`** replaces `statusOf(primary())`, which could read a transient `undefined`.
- **Unchanged:** all 13 negative cases, the tampered signature (403) and the standby `not_primary` case; every later test, the count (**19**), the strict 120 s, admin controls and the enrollment proofs.

**Residual:** other tests bind `const l = await live()` and send to that same `l`. That is not unsynchronised, but it is not term-checked either. A lease loss there would show as a visible failure, never as an acceptance. I did not change them (minimal fix, no evidence of failure).

## Stage (the full freeze follows this report)
- **`writer-integrated-stage/r6`:** source tree **`ee3a22997353b89962ee49a34a6af8c32accb6ac`** = r5 `939d8d08` + this 1-file test delta (`patches/INFO-integrated-r6-vs-r5-delta.patch`).
- **The patch:** `patches/writer-integrated-r6-vs-cold-recovery-r5-plus-driver-r1.patch`, against the history r5 + driver tree `1119db5b`. It was verified from a fresh checkout to give `ee3a2299`.
- **`release.git`:** branch `integrated-r6-source` = commit `e68355d20a57d277ea65129dec83ebac732b9101`.
- **Root job `jobs/root-writer-integrated-r6.sh`** (r5 job + the r5 stage verification + a new **`enrollment`** mode):
  - **`enrollment` (512, no build):** compose from r9 asserting every tree, then **only** the enrollment suite = **19** (the quick focused run first);
  - **`slice`:** 211, as r5;
  - **`check` (2560):** the full composed check, once.
  ```
  bash jobs/q-exit-status.sh wint-r6-enrollment 512 unshare -Urnm bash writer-integrated-stage/r6/jobs/root-writer-integrated-r6.sh enrollment
  bash jobs/q-exit-status.sh wint-r6-check     2560 unshare -Urnm bash writer-integrated-stage/r6/jobs/root-writer-integrated-r6.sh check
  ```
- **Scratch:** `/tmp/claude-int-r6-1622`, `/tmp/claude-int-r6-1622-verify` and `/tmp/claude-enr-1622-ro` (read-only copies). All new and mine.

**No pass is claimed.** If the focused run fails again with "no primary held its term …", the leases are being lost repeatedly within one request. That would point at the test host's scheduling, or at a real lease or heartbeat problem worth a KVM/replica review, and its error names each lost term for diagnosis.

---
**Frozen:** `writer-integrated-stage/r6/SHA256SUMS` sha256 **`6ec029c929590d8d145582c88bc22cc17a5f5e9cc0832044d491f24e497670f7`**; patch `71d557e0f9798bc000c355e94ef609d60637c26002e637ab52185680520cf4b6`; job `a8e7368253569a326a9ad11ea647ebfb494c79c13d5f99facd62337e62d00aaa`.
