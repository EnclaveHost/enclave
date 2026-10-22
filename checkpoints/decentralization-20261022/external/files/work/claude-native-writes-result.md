# Native client writes and streaming: Claude result (2026-10-19)

Worktree `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`. Nothing is
committed or pushed. There were no live, chain or wallet operations, and no secrets
or private configuration were read. Only the files below were edited; the
concurrent custody and supervisor changes are untouched.

## Files

- `network/native-client.mjs`
  - **Unchanged:** `resolve()`, `currentLease()` and the discovery and attestation
    sequence (lease, owner, package and route checks; fresh proof; second resolve;
    TLS-key and deadline check on the handshake).
  - **New and changed:**
    - `request(options)` keeps its result shape and is now built on the same core.
      It adds methods POST/PUT/PATCH/DELETE/OPTIONS and bounded bodies.
    - New `stream(options)` resolves at response headers and returns
      `{status, headers, body: Readable, cancel(), closed, route, proof, expectation, leaseBlock, validUntil}`.
    - Each request is snapshotted synchronously. Headers, body, path and limits are
      copied; the `AbortSignal` is kept by reference and must be a real one.
    - Strict validation: method allowlist, path and header token rules, CR/LF/NUL
      refusal, forbidden hop-by-hop/framing headers, duplicate-name refusal, size
      bounds, unknown options refused.
    - Per-client `maxConcurrent` (1–32, default 4). Setup is serialized; the queue
      is released at response headers.
    - Stream limits: idle, duration and byte limits, plus a periodic lease recheck
      that cuts the stream when the deployment changes or can't be confirmed.
    - One send, no retry, no redirects.
- `test/native-client.test.mjs`
  - **Rig additions:** an optional server handler, client options, and a TLS-layer
    decrypted-byte counter. All 14 existing tests are unchanged and pass.
  - **7 new tests** (see Tests).
- `docs/network/native-client.md`: exact API, options and limits table,
  semantics, and gaps.
- `scripts/network/native-request.mjs` does not exist. The only wrapper is
  `native-get.mjs`, which is not mine; it keeps working unchanged (GET).

## Tests

The new tests use a real local TLS server with a self-signed key. Hardware verdicts
and chain reads are test doubles, as before; nothing here is a real SNP run.
- **POST.** An exact body arrives with `content-length`, content type and
  credentials. Mutating the caller's buffer after the call doesn't change what is
  sent. PUT/PATCH/DELETE with typed-array bodies work. The owner-startup expectation
  path is used.
- **Incremental SSE.** The server sends event 1 and waits until the client has
  consumed it before sending event 2 and ending, so a buffering client would
  deadlock. Both arrive in order; `closed` reports 22 bytes; the slot is freed.
- **Cancellation and limits.**
  - `cancel()`, the response byte limit, the idle timeout and `AbortSignal` each
    end their stream, and the server sees all four connections close.
  - A buffered request's byte limit is enforced.
  - A request aborted before sending never reaches the server.
- **Refusals before any byte.** For a wrong TLS key, a changed owner, a changed
  lease and a route withdrawal, both POST and stream are refused with zero server
  requests, zero decrypted application bytes, and the slot released. The POST test
  shows the counter does count accepted sends.
- **Redirects and failures.**
  - A POST answered with 307 is returned, not followed.
  - When the server receives a POST and then drops the connection, the client
    errors with no second request.
  - A stream reset after a partial body errors.
  - Across these three requests: 3 requests and 3 probes, with no re-attest or resend.
- **Mid-stream ownership change.** An ownership transfer while a stream is open
  cuts it ("authorization ended … not confirmed current").
- **Concurrency and validation.** The third stream is refused at
  `maxConcurrent:2`, and a slot frees after `cancel`. 13 invalid requests (CONNECT,
  TRACE, GET with a body, an oversized body, forbidden headers, CRLF injection,
  duplicate header names, a non-byte body, a fake signal, `//` path, a timeout below
  1 s, an unknown option) all fail without a probe. HEAD returns an empty Buffer
  body, as before.

Results:
- `node --test test/native-client.test.mjs test/native-profile.test.mjs test/startup-expectation.test.mjs test/guest-probe-bootstrap.test.mjs`:
  **42/42 pass**.
- `test/native-client.test.mjs` alone: 25/25 (14 existing tests, 7 new, plus 4
  subtests).

## Remaining gaps

- **Browsers and WebPKI.** There is no browser path. Browsers can't pin an attested
  key or skip WebPKI, so EyesOff in a browser still needs browser naming and
  certificates, or a reviewed local extension or app. This library is Node only,
  not a proxy.
- **Authentication.** Application credentials are passed through only after
  verification; there is no Enclave-independent login or session flow. Users must
  hold whatever credential the app issues.
- **Transport gaps.**
  - No streamed or unbounded uploads: request bodies are bounded at 64 MiB, so
    large file uploads need app-level chunking.
  - No WebSocket/`Upgrade`, `100-continue` or HTTP/2.
  - No CLI wrapper for writes or streams; `native-get.mjs` is GET only.
- **Stream revalidation.** It covers the lease and identity (owner, runner, app,
  config, lease freshness), not route withdrawal; `maxDurationMs` bounds that. An
  attested TLS session stays pinned to the attested key, but the proof itself is
  not refreshed mid-stream.
- **Cancellation timing.** The probe isn't abortable mid-call; cancellation is
  checked between steps and at the handshake, so it can lag by one probe duration.
- **Evidence.** All of this is local fixture evidence. No live EyesOff write or
  stream has been run through this path.
