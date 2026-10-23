# witness-failover: whole-operation deadlines and terminal lifecycle (RESULT-DEADLINE, 2026-10-23 ~05:20Z)

**Status: SOURCE + OFFLINE TESTS ONLY.**
- No recording, network, production, SSH, wallet, push, toolchain or allocation changes.
- Same isolated clones. `7b4e8c68` / `ef320298` and all earlier evidence are unchanged.
- Root's probe directory was not modified and not re-run in place. Its scenario is reproduced as a committed test.
- No RPC-independence claim.

## 1. Root's repro and the fix

On `7b4e8c68` (gateway sha256 `e33d8a4b…668c`), root's loopback probe ran 3 concurrent `eth_chainId` reads with
`maxInFlight 1`, a 150 ms deadline and a 100 ms upstream. The **third read started at 222 ms and returned success at
324 ms.**

**Causes:**
- `ask()` computed the remaining time before waiting for a slot;
- the limiter's wait was unbounded and could not be cancelled;
- no deadline bounded cache, root or helper work.

**Fix:** Enclave `7b4e8c68` → **`d0775541db0a0cb599cfe5c7b3853e24242aaaec`**.
- `network/witness-gateway.mjs` is now `1ce52fa1…`.
- `network/witness-verify.mjs` is now `729496b0…`.

**One operation context per request.** `handle()` creates `{signal, deadline}`; the signal aborts at the deadline or
on `close()`, and expiry is also judged by time. Everything the request does uses it:

| Stage | Bound |
|---|---|
| Queue wait for a slot | The limiter (FIFO, `maxInFlight`, **`maxQueued`** 256, beyond which requests are refused at once) removes an aborted waiter immediately, so it never reaches an upstream. |
| Upstream try | The budget is computed **when the slot is granted**. No try starts with under **`minTryMs`** (25 ms) left. `fetch` gets `AbortSignal.any([request, per-try timeout])`, which also cancels the body read. |
| Source that ignores abort | The caller is answered at its deadline. The slot is released only when the work settles, so it is still bounded by `maxInFlight`, and the late answer is discarded. |
| Root lookup / ancestry walk | `rootFor(hash, {headers, deadline, signal})` (§3) |
| Helper checks | `checker.check(request, {signal})` (§3) |
| Cache read | A separate **`cacheTimeoutMs`** (default `min(1000, deadline)`). A slow or hung cache is **skipped**, then the upstreams are asked; it is not waited out. |
| Cache write | Runs in the background, capped by **`maxCacheOps`**. A read never waits for or fails on a write. `settled()` awaits the writes. |
| Result | **No success after the deadline**: `request deadline exceeded: refused`. |
| Transactions | No new upstream is sent to after the deadline. If a broadcast reached k upstreams before it, the error says so and returns no late result. Tested with fake HTTP only. |

There is no total-deadline `Promise.race` over a live backlog: every awaited piece is either aborted (fetch, queue
wait, helper entry, walk) or explicitly bounded (abort-ignoring sources hold a slot; cache operations are capped).

## 2. Evidence (queue, 16 GiB floor, offline `unshare -r -n`; digest in `TEST-EVIDENCE-DEADLINE.txt`)

**Root repro (final run `js-all-r7`):**

| Gateway | Upstream request starts (ms) | Replies (id: outcome @ ms) | Violation |
|---|---|---|---|
| **d0775541** | 14, 122. **The third read never reached the upstream.** | 1: ok @120; 2: deadline refused @155; 3: deadline refused @155 | **false** |
| **NEGATIVE CONTROL: exact `7b4e8c68`** (loaded from git objects, sha `e33d8a4b` asserted) | 4, 106, **209** | 1: ok @105; 2: ok @208; **3: ok @311** | **true** |

**`test/witness-deadline.test.mjs`: 11/11.** It uses real loopback HTTP upstreams, plus the real `witness-check`
helper and real recorded Base witnesses where verification is involved. Labelled SEAM stand-ins are used only to force
hangs.
1. Root's repro.
2. The negative control.
3. A request expiring in the queue never reaches the upstream. The running one is **aborted** (the server sees the
   connection close) and returns no late success. `active`/`queued` go back to 0.
4. SEAM, an abort-ignoring custom fetch: the caller is refused at its deadline. The slot stays held until the work
   settles; a waiter behind it expires in the queue. The late `0xlate` answer changes no counter.
5. A transaction is not sent to the second upstream after the deadline.
6. SEAM, a hung cache (`candidates` and `put` never resolve): the read is served from the upstream and verified by the
   real helper well before the deadline (`cacheTimeouts 1`). `close()` returns within its bound.
7. **Real shared helper:**
   - an already-aborted check is never sent;
   - aborting caller A drops only A's check, and caller B's concurrent check is verified by the same process (pending
     back to 0);
   - **`close()` is terminal**: later checks reject, and no restart happens after the old child exits.
8. SEAM, a helper check that hangs for one address: that request is refused at its 400 ms deadline, and a concurrent
   read is verified by the real helper.
9. **Gateway `close()`** with 1 running and 2 queued requests: all three end at once as `closed`, the queued ones never
   reach the upstream, and new requests are refused.
10. **Root store `close()`** during a slow poll (real signed head 106):
    - the poll is aborted (the server sees the close);
    - the late answer binds nothing;
    - `rootFor`, `offer` and `refresh` return null;
    - `start()` makes no new poll.
11. **Shared ancestry walk** (real helper, real headers):
    - caller A gives up mid-walk and caller B still gets block 80's authenticated root from the same single walk (26
      header requests);
    - when the only caller of another walk leaves, the walk stops: no further header requests, and it ended long
      before its 46 links.

**Regression run: `js-all-r7` = 10 files, 60 tests, 58 pass, 0 fail, 2 skip** (offline, peak 255 MiB):
- deadline and blocks;
- ancestry and failover;
- the gateway's plain path;
- 5 Helios E2Es (block failover, witness failover, replay, Anvil, real history).

The two skips are the same as before: no recorded real proofs, and no stock 0.12.0 binary.

**Test edits needed by the new semantics:**
- Three spots now `await g.settled()` before inspecting the cache, because writes are background.
- The old hung-sources test now expects a deadline refusal, not a source verdict.

**Failed runs on the way (all my bugs, all in the digest):**
- r1: the default `cacheTimeoutMs` failed validation against short deadlines.
- r2: deadline refusals were sometimes classified as upstream failures because of a timer race; fixed with time-based
  expiry.
- r3: a request granted about 1 ms before its deadline still sent a try; fixed with `minTryMs`.
- `js-all-r6`: the old assertion.

**Scans:** range `7b4e8c68..d0775541`: crypto 0 findings, gitleaks "no leaks found".

## 3. Lifecycle (helper, root store, gateway) and per-request cancellation

- **`createWitnessChecker`:**
  - `check(request, {signal})`: an aborted signal before sending means the check is not written. An abort while
    pending drops **only that entry**: its timer is cleared and a late reply is ignored. The shared helper is not
    killed, so other callers are unaffected.
  - The helper answers in order, so an already-written check still costs it bounded work (`timeoutMs`, `maxPending`).
  - Crash or hang still fails all pending checks and restarts on the next use, as before.
  - **`close()` is terminal:** no restart, every later check rejects, and the old child's output and exit are ignored.
  - New `stats()`: `{pending, running, closed}`.
- **`createRootStore`:**
  - A caller's signal ends only **its** wait. `refresh()` is shared and is not cancelled by one caller.
  - Ancestry walks are **reference-counted**. Each runs under its own controller and the **latest** deadline of the
    callers waiting on it.
  - A walk is aborted (no further header fetch or helper check) when its last caller leaves, its deadline passes, or
    the store closes. An abandoned walk is never joined.
  - `headers(hash, child, {signal, deadline})` receives the walk's context.
  - Bindings already made stay. They are authenticated immutable history, **not** freshness.
  - `stop()` pauses polling. **`close()` is terminal:** it aborts the in-flight poll and every walk, discards a late
    answer, and makes no new work.
- **`createWitnessGateway`:**
  - **`close()` is terminal:** all requests abort, new ones are refused, the endpoint closes, and background writes get
    at most 1 s.
  - The checker and root store are the caller's (possibly shared) and are not closed by the gateway. The service that
    owns them must call `roots.close()` and `checker.close()` at shutdown.
  - New: `settled()`, plus stats `deadlineExceeded`, `queueFull`, `cacheTimeouts`, `cacheSkipped`, `cachePutSkipped`,
    `closedRefusals`, `active`, `queued`, `cacheReads`, `cacheWrites` and `closed`.

**Also corrected:** the header comment that said "No P2P witness transport exists for Base today". It now states the
evidenced bound: on the pinned/current Base client releases audited, state serving is disabled by default with no flag
to enable it; no enabled, supported P2P proof path was observed; custom peers that serve state were not ruled out.

## 4. Interface changes (all backward compatible)

- **Gateway options:** `maxQueued`, `minTryMs`, `cacheTimeoutMs`, `maxCacheOps`. Defaults keep existing callers
  working.
- **Gateway methods:** `settled()`; `close()` is now terminal.
- **Cache (E):** optional extra arguments `candidates(w, {signal})`, `get(w, {signal})`, `put(w, result, {signal})`.
  - The gateway now **never awaits `put` on the read path**. E's earlier observation that an awaited put held a read
    for 8043 ms on a hung S3 no longer applies here.
  - E's S3 archive tier should honour `signal` to free resources early; if it doesn't, the gateway still bounds it
    (`maxCacheOps`) and discards late results.
  - A store with only `{get, put}` still works.
- **Root store (A/B):** `rootFor(hash, {headers, deadline, signal})`, `offer(commitment, {signal})`, `close()`. A
  `headers()` implementation receives `{signal, deadline}` as its third argument instead of a bare deadline. Only
  tests and the gateway implement it here.
- **Checker:** `check(request, {signal})`, `stats()`; `close()` is terminal.

## 5. Final pins

| Item | Pin |
|---|---|
| Enclave `witness-failover` | `7b4e8c68` → **`d0775541db0a0cb599cfe5c7b3853e24242aaaec`** |
| Helios `enclave-witness-check` | unchanged **`ef3202982b475212d9bb6adfdc3eed4ebb0b83c5`** |
| witness-check helper | unchanged **`4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411`** (B needs this one) |
| Helios under test | `cc962e2b` (A's r4 build of `eeffcc9`) |
| Patch | `patches/deadline/0001-Bound-every-gateway-request-by-one-whole-operation-d.patch` (`ce11000b…`) |
| Provenance / evidence | `PROVENANCE-DEADLINE.json` (`a186e0f5…`), `TEST-EVIDENCE-DEADLINE.txt` (`6fcd67af…`) |

## 6. Integration steps (root; I have not touched other trees)

1. **Helios:** on `eeffcc9`, apply `patches/helios` → `patches/history/helios` → `patches/block-responses/helios`
   (`ef320298`). Build `witness-check` and pin `4fe0cd3b`.
2. **Enclave:** on `9fdc1418c`, apply in order:
   - `patches/enclave`;
   - `patches/history/enclave`;
   - `patches/real-history`;
   - `patches/block-responses/enclave`;
   - **`patches/deadline`** (`d0775541`).
3. **E** (S3 history on `7b4dd692`): rebase onto `d0775541`.
   - Expect conflicts only where E edited the gateway's `witness()` cache lines or the stats line.
   - Pass `{signal}` through to S3 calls.
   - Tests that inspect the cache after a read should `await g.settled()`.
4. **A** (consumer wiring):
   - shut down with `gateway.close()`, then `roots.close()` and `checker.close()`;
   - for any custom `headers()`, accept `{signal, deadline}`.
5. **B** (runtime composition):
   - ship helper `4fe0cd3b` and the `d0775541` gateway/root code;
   - wire `roots.offer(commitment)` for each accepted head;
   - close the owned roots and checker at shutdown.
6. Run the composed suites once, including `witness-deadline` and the Helios E2Es.

## 7. Boundaries (actual tested scope) and remaining gaps

- **Timing claims are loopback-measured** at 150–400 ms deadlines, with a slack of about 50 ms. Under host load, timer
  latency adds to those numbers.
- **A written helper check still costs helper time.** One caller's abort can't stop a check the helper has already
  read; that work is bounded by the helper `timeoutMs` and `maxPending`.
- **Sources that ignore abort** (a custom `fetch`, a custom cache) are bounded by `maxInFlight` / `maxCacheOps`, not
  stopped. Their late results are discarded.
- **Out of scope:** receipts and logs verification, new proof recordings, fresh witness supply (an execution-data
  holder is still required), transaction inclusion (a broadcast is not inclusion), and L1 finality or signer rotation.
- **Not claimed:** RPC independence, a completed real historical call, or release builds.
