# Lease relay socket-timeout review: FINAL (2026-10-25)

**Verdict: the root-review finding is ALREADY FIXED in the committed `lease-relay-source` `433f04fa1`, with passing
tests that exercise the production defaults.**
- **No code change was made**, and no patch is proposed, per the instruction not to invent one.
- **No tests were run** by me; the existing evidence is cited below.
- Worktree `lease-relay-source`: clean at `433f04fa1`, apart from the untracked `node_modules` symlink. Not done: no
  commit, live action or deployment.

## The finding (`lease-relay-root-review.md`)

> `startLeaseRelay` sets `req.setTimeout(10_000)` before reading the body and leaves that socket idle timeout active
> during relay execution, although `requestTimeoutMs=60_000` and `receiptTimeoutMs=120_000` …

## Evidence that it is fixed

**1. The old code.** `git show 9fa02e1bc:client/lease-executor-client.mjs:415` reads
`req.setTimeout(10_000, () => { reply(408, …); req.destroy(); })`. That is the socket idle cut, active for the whole
request lifetime.

**2. The fix, in commit `433f04fa1`.** `git show 433f04fa1 -- client/lease-executor-client.mjs` removes that line and
adds `bodyTimeoutMs = 10_000` and `const receipt = setTimeout(…)`. Current file sha256 `4f4c416c…`, lines 472-522:
- **Receipt bound.** Headers and body must arrive within `bodyTimeoutMs` (10 s). Otherwise the client gets 408 and the
  connection is cut, so a slow uploader holds nothing. Body size stays ≤ `maxBody` (4 KiB, 413 otherwise), and
  `server.headersTimeout = 10_000`.
- **Processing bound.** `clearTimeout(receipt)` runs as soon as the complete body is in. From then on only `withTimeout(pendingJob, requestTimeoutMs)`
  (60 s) bounds the **answer**. No `req.setTimeout`, `socket.setTimeout`, `server.timeout` or `keepAliveTimeout`
  override remains anywhere in the file. `server.requestTimeout = requestTimeoutMs + 5000` limits only the time to
  receive the request, not the response wait.
- **Capacity and duplicate sends.** `inflight` is decremented only when `pendingJob` settles (`:516-518`). A timed-out
  HTTP answer therefore never frees capacity. `sendQueue = pendingJob.catch(…)` keeps the key locked while the original
  job can still broadcast, which gives one send at a time and no overlapping signature. Durable same-byte recovery
  (strict `stateFile`, re-broadcast of the recorded raw bytes) is unchanged.
- **Unchanged:** authorization, journaling, `submitGate`/own-backend binding and refusals, and no public fallback.

**3. Tests: committed and passing on exactly this code.**

| Test | Proves | Run and result |
| --- | --- | --- |
| `test/lease-relay-verifier.e2e.test.mjs` 'the backend fails to forward (relay receipt wait 30 s)…' | a legitimate job longer than 10 s keeps its connection: `waited > 10_000`, not `fetch failed`; the relay's own 502 reaches the host; bytes durable; lands once after restart | `logs/lease-relay-e2e-r6.tap` **ok 11**, host answer after **33,014 ms** |
| same file, '…under the PRODUCTION waits (request 60 s, receipt 120 s)…' (`relayOptions: {}`, the defaults) | the **production default** path: the host gets the relay's own 60 s answer (`no answer within 60000 ms`), the job keeps the key, the same bytes land once after a restart | r6 **ok 12**, host answer after **62,435 ms** |
| same file, 'a stalled upload is cut at the 10 s receipt bound with 408' | the slow-upload protection stays (cut at 9.5–20 s with 408) | r6 **ok 13** |
| `test/lease-authority.test.mjs` 'an HTTP timeout does not release the relay queue or its capacity while a send remains pending' | after a timed-out answer (502), a second request gets **503** (capacity held), `sends` stays **1** (no overlapping send), and the original send lands **once** (exactly 1 `LeaseGasPaid`) | `logs/lease-relay-legacy-r2.tap` **ok 13** |

**Binding of the runs to the committed bytes:**
- `client/lease-executor-client.mjs` mtime is 06:29:27 PDT; the E2E test file 06:24:20; `lease-authority.test.mjs` 05:05:51.
- r6 started at 13:31:01Z (06:31 PDT) and legacy-r2 at 13:50:06Z. Both are after those edits.
- The commit is 07:05:57 PDT, and the tree is clean now, so the tested files equal the committed ones.
- The r6 header's short dirty list omits the client file. Its mtime still predates the run, and no change after it
  exists (the clean tree at `433f04fa1`).

**Suite totals:**
- **e2e-r6:** 15 tests, 15 pass, 0 fail, 0 skipped.
- **legacy-r2:** 114 tests, 113 pass, 1 fail. The failure is test 62, "REAL gate: a relay host cold-starts from an
  imported signed policy…", which is unrelated to timeouts. It **passed afterwards** in `logs/lease-relay-hostpolicy-r3.tap`
  (ok 7; that suite 9/9, 0 skipped).

## Limits (honest)

- **Duration.** The >10 s proofs are real-runtime E2E tests: reth `--dev`, the pinned Helios, offline. They take about
  33 s and 62 s. No short-timer injectable pure unit test exists for the receipt/processing split. It isn't needed for
  correctness, because the production default itself is exercised (test 12). One could be added as a fast regression if
  root wants; I did not add one, to avoid an unrequested change.
- **Host-visible behaviour.** After `requestTimeoutMs` (60 s) the host receives a 502 while the job continues and keeps
  the key, until the receipt bound (120 s) and the RPC bounds end it. This is intended durable semantics: the host
  resolves the lease from the chain or its journal and never sees a false success.
- **Tests not re-run.** Nothing was re-run in this review. The cited logs are from 2026-10-25 06:31–07:00 PDT.
- **Live relay drift.** The eu-central relay runs release `94f4ebdf…` with the provider quorum (inventory
  `consumer-cutover-plan-2205`). Whether that release contains this fix is not established. Deploying `433f04fa1` (or
  later) is required to get it live, and is subject to the placement blocker for the verifier backend.
