# rpc-verifier-deadline — RESULT (2026-10-23 ~03:42Z; times from job logs and `date -u`)

**Status: source plus offline tests in an isolated candidate. Not merged, not pushed, not deployed.** A's
`rpc-priority/repo`, and every other worker tree, were only read (a `git clone --local --no-hardlinks` plus read-only
`git show/diff/status`). No SSH, live RPC, production, signing or new toolchain.

## Pins

| Item | Value |
|---|---|
| Base | A's `921d60c2b37ec8ae64e1fd22d7bc7b408939bd70`; its `network/lease-reader.mjs` sha256 = `3d1850b2…`, the file root probed |
| Candidate | `rpc-verifier-deadline/repo`, branch `verifier-deadline`, origin removed. `62feb3aaf` → **`8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346`** (tree `740120a4`), SteveDeFacto |
| `network/lease-reader.mjs` | sha256 `7c01e53b17fb97c65a2043d2703caa2ccc9bbec1e9236d7b11c0c3559e4d060a` (+66/−21 lines vs base; test file +215) |
| `test/lease-reader-verifier-deadline.test.mjs` (new) | sha256 `f3e99df4438467529c41eeb0f784ef5b7d24002892bcafdd7a5179d7df72668d` (11 tests) |
| Standalone patches (`patch/`) | `0001-Bound-the-whole-verified-read…` ef8bdbc3, `0002-Keep-the-verified-operation-deadline-timer…` c611c911, `combined-921d60c2..8d110101.diff` 54feece7. Both the series and the combined diff rebuild tree 740120a4 exactly from 921d60c2 (checked in a throwaway index) |
| A now | HEAD `0c43e4db8` (one new commit, a test). `network/lease-reader.mjs` is unchanged since 921d60c2 and unmodified in A's worktree, and there is no clash with the new test name: the patch applies as-is today |

## The defect, and what changed

Root's probe, under authority `verifier` with a 100 ms deadline, showed `agreed()` with a never-settling callback still
pending after 401 ms. In base, `verifiedRead` (and `readAt`) did `await read(...)` with no bound. The per-request
`deadlineCall()` only checked the clock, and only before queueing the request: it never checked closure. A client kept
by the callback could still send after success or failure, until the deadline. `blockHashIs` used its own unclosed
call.

`verifiedOperation(kind)` now gives each `verifiedRead`/`agreed`, `readAt` and `blockHashIs` call **one deadline and
one closure**:
* `run(fn)` races the whole body (the caller's callback included) against one deadline timer. It rejects at
  `deadlineMs` even if the callback never settles. The timer is **not unref'd**: it fires even when nothing else holds
  the event loop, and it is cleared the moment the operation settles. In my first commit 62feb3aa it was unref'd, which
  let a silent in-process read exit the process still pending; a child-process test catches that.
* When `run` settles (answer, refusal or deadline), the operation is **closed**:
  * the `AbortSignal` handed to every transport request is aborted;
  * pending requests reject at once (`bounded()` removes its timer and abort listener on settle);
  * any later `call()` through a retained pinned client is refused **before anything is sent**.
* `call()` re-checks closure **and** the deadline at the moment the transport is invoked (the microtask), not only when
  it is queued. Each request waits at most the time left.
* **Transport cancellation:**
  * the loopback HTTP verifier aborts its `fetch` (connection and body) through `AbortSignal.any([operation, timeout])`;
  * an in-process verifier now receives the signal as `request(method, params, timeoutMs, signal)`. Honouring it is
    up to that object.
* A body that outlives its deadline cannot answer or touch reader state: `op.assertOpen()` runs before
  `lastBlock`/`lastEvidence` are set. `readAt` stays history: it never moves `lastBlock` or `lastEvidence`.
* `blockHashIs` runs under the same lifecycle and still answers false on any failure.

**Unchanged:**
* block-hash pinning;
* freshness (`maxBlockAgeMs`, +5 s future bound);
* monotonicity;
* the reorg re-check;
* `authorityPins` (admin-pinned authorities);
* the pinned-client method allowlist;
* no provider client or fallback under `verifier`;
* the policy bounds (`deadlineMs` 100–300000, unchanged);
* the whole **legacy `quorum` path**. Its `agreed()` already had one deadline plus a closed gate, and `timed()` and
  the quorum timer are untouched.

## Tests (all via `claude-test-queue.py`, 16 GiB floor, inside `unshare -r -n` with lo up; no network beyond 127.0.0.1)

New file: 11 tests driving the real methods through scripted in-process transports and a real loopback HTTP server.

**Base-failure control** (new test file on unmodified 921d60c2: `jobs/base-control-3`, 03:06Z, 512 MiB):
3 pass / 5 fail / 2 cancelled, 13.5 s. `base-control` and `base-control-2` were invalid controls: base's pending
promise drained the event loop and the runner abandoned every test. A keep-alive interval (cleared in `after`) fixed
the harness.

| Test | Base | Fix |
|---|---|---|
| never-settling callback rejected at the deadline, state untouched, signals aborted | **timeout (5 s)** | pass (~100 ms) |
| callback resolving after the deadline cannot answer, change state or send | pass: base's deadline check already blocked it | pass |
| hung RPC inside the callback bounded and its transport signal aborted | **fail** (no signal) | pass |
| retained client after success / failure / timeout sends 0 | **fail** (sent after success) | pass |
| deadline re-checked when the transport is invoked (event loop blocked past the deadline after queueing) | **fail** (request reached the transport) | pass |
| normal completion: an orphaned callback request is aborted, no timers remain | **fail** | pass |
| readAt bounded and closed, never fresh authority, pin mismatch refused | **timeout** | pass |
| blockHashIs true/false, hung verifier → false within the deadline, aborted | **fail** (no signal) | pass |
| loopback HTTP: hung request cancelled on the wire at the deadline | pass: base's `AbortSignal.timeout` already did | pass |
| deadline fires with no keep-alive (child process) | (added later) **fails on 62feb3aa** (unref'd timer) | pass |
| policy bounds unchanged | pass | pass |

**Fix runs:**
* `fix-1`: new + existing `lease-reader-verifier.test.mjs` (real consumers: snapshots, admin-directed book migration,
  host admission and catalog moderation, settlement pinned reads) + legacy `lease-reader.test.mjs`. 50/50, peak 156 MiB.
* `unref-control` (03:27Z): the no-keep-alive test fails on 62feb3aa; the working tree passes 51/51.
* **`final-2` (03:33:42Z, exact committed bytes 8d110101, 512 MiB):**
  * root's probe logic, unchanged except for the import path (`jobs/root-probe-candidate.mjs`): **rejected after
    102 ms**, "the verified read deadline of 100 ms has passed" (base: still pending at 401 ms);
  * the focused set **51/51**, peak 238 MiB.
* **`consumers-2` (03:40:28Z, 8d110101, 768 MiB):** the 9 other existing tests importing lease-reader (cli-independent-
  sessions, connectivity-chain, host-admission-retry, management-plane, network-authority-pins, provider-bootstrap,
  rpc-identity-common, site-independent-management, windows-host-identity). **97 tests: 74 pass, 0 fail, 23 skipped.**
  Every skip is "needs the Foundry build (forge build)", an environment limit that is the same without this patch.
  These are quorum CLI flows, not the verifier path.

A's Helios E2E (`lease-reader-verifier.e2e.test.mjs`) was not run, so as not to duplicate A's build. Root's combined
rerun should include it.

## Remaining limits (stated precisely)

* **JavaScript cannot be force-aborted.** A callback that never settles, or keeps computing, keeps running; it is
  simply no longer waited for. Its later requests are refused and it cannot change reader state through this
  operation. Side effects it makes elsewhere through its own closures are the caller's.
* **In-process transport cancellation is advisory.** The signal is passed; a transport that ignores it keeps running
  until it settles, and its answer is ignored.
* **HTTP:** the fetch and socket are aborted, but the Helios process may still finish computing that request
  server-side.
* **Legacy `quorum`:** `readAt` and `blockHashIs` remain unbounded, exactly as before. They were deliberately not
  changed, to avoid altering normal quorum behaviour. `agreed()` there was already whole-deadline. Root may want the
  same treatment there separately.
* **Deadline semantics:** the verifier deadline now bounds the callback too. A legitimately slow callback that used to
  finish after `deadlineMs` (when its last request had started before the deadline) is now refused. That is the
  intended fail-closed behaviour; no consumer test needed a longer budget.

## How to integrate (root, after A is terminal)

`git am patch/0001-*.patch patch/0002-*.patch` on A's branch (or apply `combined-*.diff`). Then run, with A's
`node_modules`, inside `unshare -r -n` + lo up:

```
test/lease-reader-verifier-deadline.test.mjs test/lease-reader-verifier.test.mjs test/lease-reader.test.mjs
```

plus A's Helios E2E. The `jobs/` scripts here show the exact commands. `node_modules` in the candidate is an
uncommitted symlink to A's tree.
