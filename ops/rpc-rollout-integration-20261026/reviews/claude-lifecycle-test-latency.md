# r5 test latency (root 1386): read-only diagnosis

**Scope.** I modified nothing.
- r5 is frozen and untouched.
- No builds, new tests or test runs.
- I did not kill or signal anything.
- No network, SSH or commits.

**Observations came from:**
- the run directory `r5/logs/run-20261026T144333Z-1917184`;
- `ps` and `/proc`;
- **read-only** JSON-RPC to the job's private anvils through `nsenter --preserve-credentials -U -n -t <anvil pid>`, using only `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `txpool_status` and `anvil_getAutomine`;
- the viem 2.53.1 source.

No key material was read or printed. Times are UTC, and the job log mtimes are UTC−7.

**Status at 14:55 UTC.** The run is **not terminal**.
- `r5-abi`: PASS 5/5.
- `r5-policy`: **terminal FAIL**. See "Policy suite outcome" below.
- `r5-proof` is live: process 1924860 with anvil 1924868. Its TAP shows `ok` for tests 1–5. That includes the exact receipt-proof path running against real anvil blocks for the first time. **This is not a pass claim; the suite is still running.**
- `kvm-host-admission` (35) and `runtime-expiry` (7) have not started.

## Policy suite outcome (terminal, from its TAP)

`FAIL r5-policy rc 1 expected 9 tests 7 pass 6 fail 0 cancelled 1`

**Per-test results:**

| test | result | duration |
|---|---|---|
| 1 F2 | ok | 1.2 s |
| 2 F1 | ok | 1.2 s |
| 3 F1 | ok | 0.8 s |
| 4 F1 | ok | 13.3 s |
| 5 F3/F4 | ok | 169.5 s |
| 6 F3 | ok | 364.9 s |

**Then:** `not ok 1 - test/deployment-chain-adapter-r5-policy.test.mjs … testTimeoutFailure 'test timed out after 600000ms'`.

**What the timeout means:**
- Under node's default per-file process isolation, the job's `--test-timeout=600000` applies to the **whole file**, not to each test.
- The file was cancelled at 600 s (07:53:41 local). F5, F6 and F7 **never ran**. This was not an assertion failure.

**Orphaned anvil:**
- The file's anvil (PID **1917493**, private namespace port 35855) is still running, re-parented to PID 1.
- `test.after` does not run when the runner cancels a timed-out file.
- I did not touch it; root should reap it.

## Root cause (observed + mechanism)

**1. Every slow interval is exactly one viem polling interval.**
- On the policy anvil, a timestamp profile of all 658 blocks shows:
  - blocks 1–283: consecutive timestamps 0–1 s apart, i.e. many transactions per second;
  - from block 284 onward: more and more **exactly 4 s** gaps;
  - blocks 544–658: **every** block is 4 s after the previous one.
- Each block holds one transaction.
- Anvil state was healthy throughout: `anvil_getAutomine = true`; `txpool_status` showed pending 0 and queued 0; the last transaction was mined with a status-1 receipt.
- CPU over 8 minutes was node 9 s and anvil 1 s, so both processes were **idle-waiting**.

**2. Mechanism.** The viem 2.53.1 `waitForTransactionReceipt` source works like this:
1. It makes **one** immediate `getTransactionReceipt`.
2. If that misses, it falls back to `watchBlockNumber({poll:true, pollingInterval: client.pollingInterval})`.
3. The fixture's public client keeps the default `pollingInterval` of **4000 ms**.

Anvil's instant automine runs asynchronously after `eth_sendRawTransaction` returns. If the immediate receipt check runs before the block is sealed, the fixture's `send()` waits a full 4 s poll. `world()` sends about 45–50 serial transactions, so a world costs about 0.5 s when every race is won and about 3 minutes when every race is lost.

**3. Why the first worlds were fast and later ones took minutes.** The lost-race probability grows with chain/state size in each anvil.
- On the policy anvil, the first 4 s gap is block **284**. That is **before** the `warp(30)` at block 288 (the 31 s gap), so the warp is not the trigger.
- The same shape shows on the fresh proof-suite anvil: no 4 s gaps through block ~322, then increasingly frequent ones, before its `warp(200)` at block 371.
- Both anvils accumulate about 20 worlds × about 25 contracts in one process.

That anvil's async sealing latency grows with state size is an inference from these consistent observations. I did not profile anvil internals.

**4. Ruled out, from the observations above:**
- **Nonces:** no gaps; the pool was empty.
- **Gas:** fixed 5 M (25 M for the ledger deploy), against a 30 M block limit. Base fee had decayed to 7 wei, so the 100 gwei fee cap is never binding.
- **Mining mode:** automine was on.
- **Host-policy reads:** one `authority()` call plus local hashing per `read()`.
- **Adapter reads:** about 80 loopback calls per `read()`.
- **Assertion or freshness logic:** none of it waits.
- **Not a hang:** the process kept advancing at 1 transaction per 4 s until the file timeout.

## Projection for the live proof suite (estimate, not a result)

- Tests 6–10 need about 5 more worlds plus their transactions (about 300 sends), on an anvil already losing races.
- At the observed rates, the file's 600 s budget **may again be exceeded** before test 10.
- `kvm-host-admission` and `runtime-expiry` do not use anvil and are unaffected.

## Narrow harness fix (for a NEW r6, only after root review; nothing here weakens a check)

1. **Fixture client polling.** In `test/fixtures/r5-world.mjs` (the only change):
   ```js
   S.pub = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: http(url, { retryCount: 0 }) })
   ```
   (or `waitForTransactionReceipt({ hash, pollingInterval: 25 })` in `send()`). A lost race then costs ≤ 25 ms instead of 4 s.
   - It changes no assertion, no authority, no freshness gate and no adapter code.
   - The authority double still reads one uncached block.
2. **Job budget:**
   - Keep exact counts.
   - Make `--test-timeout` explicit per file, sized to the file. For example, keep 600 s per file but add a per-suite wall clock that is reported separately.
   - Report the timeout as "cancelled" (the summary already does).
3. **Orphan reaping:**
   - Run each `suite` under `setsid` and kill its process group when the suite exits, or add a `process.on('exit')` anvil kill in the fixture.
   - A timed-out file then cannot leave an anvil behind, as 1917493 did.
4. **Optional (not required):** a fresh anvil per test file is already used. Splitting the 9 policy tests across two files would also halve the state growth, but the polling fix alone removes the 4 s penalty.

**Unrelated host observation, not acted on:**
- About 15 **12-day-old** anvils (`--chain-id 31337`, ports 18xxx/3xxxx, `--disable-code-size-limit` or `--hardfork osaka`) are re-parented to PID 1.
- They are not from this stage. They belong to other workers or earlier jobs, and root may want to reap them.
