# Independent management hardening: Claude result (2026-10-19)

Worktree `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`. Nothing is committed or pushed, and nothing was run
live (no chain, wallet, SSH or production action; no private configuration read). I touched no file outside the
management modules, `network/public-directory.mjs`, `network/directory-server.mjs`, the management test and the
management doc. Their diffs contain only my changes; all other working-tree changes belong to other workstreams and are
untouched.

## Review findings and fixes

1. **Async signers** (`network/management-client.mjs`).
   - The signer is awaited, and its failure is a refusal with nothing sent.
   - New `checkAuthorization()`: the answer must be one `EnclaveSession v1` header, at most 2 KiB, with no CR/LF/NUL. It
     must parse, fall inside the 60 s clock window, and its P-256 signature must verify over exactly this method, the
     runner base, the target and an empty body.
   - After signing, the client re-checks the deadline (the earlier of record expiry and lease freshness) before
     connecting; the TLS handshake check also enforces it.
   - Response bodies are cut at that deadline.
2. **Floors.** Keys are now `recordHash({chainId, deployments, registry, runner})` with the pinned ledger and registry.
   The same runner on another pinned network has its own floor and cannot raise or lower this one.
3. **Restart outcome.** Only two answers are definite:
   - **success:** 2xx with a JSON object naming this deployment and a string status;
   - **refusal before any side effect:** a gateway answer marked `x-enclave-management-forwarded: 0`, or one of the
     supervisor's own pre-restart refusal codes.

   Everything else is `outcomeUnknown: true` with "may have run … check status": cut-off or malformed bodies, malformed
   successes, any 5xx, and unexpected statuses or codes. The gateway now marks every answer forwarded `0` or `1`.
4. **Gateway bounds** (`network/management-gateway.mjs`, rewritten).
   - **Deadlines:** a body deadline (408); a hard total deadline per operation (`maxRequestMs` cap); and a cut at the
     earliest of that, lease freshness, lease end and session expiry.
   - **Revalidation:** every `recheckMs` (default 15 s) the gateway re-reads the lease (runner and owner unchanged), the
     session's refusal rule, and the session's on-chain `sessionOf` (live, same key, scope). Any change cuts the stream.
   - **Cleanup:** one cleanup path clears timers and listeners on every exit; `server.managementStats()` exposes slots.
   - **Fixed bugs:** destroying the upstream request raised an unhandled second `error` (the listener is now `on`), and a
     413/408 destroyed the socket before the refusal was written (it now closes after the write).
   - The gateway now requires a chain client (`pc`) so it can revalidate sessions.
5. **Directory server** (`network/directory-server.mjs`).
   - `POST /v1/network/management` is mapped to kind `management`.
   - `runDirectory` passes `importManagement: true`.
   - `runDirectory(config, {reader})` accepts an injected chain reader, used by tests; production behavior is unchanged.
6. **Host service** (`network/management-host.mjs`).
   - Startup validates the account, directories and record before listening, and closes the listener if the first
     signing fails.
   - Sequences are `max(now, last + 1)`. With `stateDir` the last sequence is persisted before publication, so a
     restart with a slower clock continues above it.
   - Refresh and withdraw are serialized; nothing republishes an endpoint after `withdraw()`.
   - A failed publication retries within 60 s instead of waiting half the lifetime.
   - `close()` also closes connections.

The tenant SNP identity and the operator management identity stay separate: the trust-root section of the doc is
unchanged, and attestation fetched this way is still host-reported.

## Tests

`test/management-plane.test.mjs`: **19/19 pass**. The 8 earlier tests are kept; 7 new tests add 4 subtests. Real pieces:
TLS, P-256 sessions with the shared verifier, secp256k1 operator signatures, HTTP hops, and the actual `runDirectory`.
Test doubles: chain reads, and the supervisor stand-in with the same verifier and base construction.

- **Async signers.**
  - A slow signer works.
  - Refused: a wrong-request signature, a bearer token, CRLF injection, a malformed header, a throwing signer, and a
    stale clock.
  - A record that expires during signing gets `sent: false`, with zero gateway requests and zero restarts.
- **Floors.**
  - Network A's withdrawal floor (sequence +1000) does not block network B's older record for the same runner in a
    shared `stateDir`.
  - B's floor never lowers A's: a stale A endpoint is still refused.
- **Restart side effects.**
  - After a side effect, the supervisor answering malformed JSON, 500, or a wrong-shaped 200 each gives
    `outcomeUnknown`, with exactly one restart each.
  - A supervisor `not_running` and a gateway 403 are definite refusals.
  - Slots end at 0/0.
- **Bounds.**
  - A trickling log answer ends within 3 s under `maxRequestMs: 400`.
  - A raw TLS request with a never-ending chunked body gets 408 within 3 s, not the 30 s server timeout. The supervisor
    sees no POST, and the slot is released.
- **Mid-stream changes.** For each of four changes (owner, runner, session revoked, lease freshness), an open log
  stream is cut within 3 s and the slot is released.
- **runDirectory.** The real directory accepts a POSTed record, serves it in `/v1/network/records`, rejects a
  foreign-signed one with 400, and a second `runDirectory` with `peers` replicates it.
- **Host lifecycle.**
  - A start whose signer fails is refused and the port is free again.
  - Sequences strictly increase across same-instant refreshes, a clock step back and withdrawal.
  - Refresh after withdrawal is refused.
  - A restart with a slower clock continues above the persisted sequence.

**Mutation checks.** Disabling each of the following made its test fail; every file was restored and verified with diff:
- floor namespacing;
- the post-sign deadline;
- treating a malformed restart answer as success;
- gateway revalidation (it at first ended streams only at the 60 s bound, so I added a 3 s assertion);
- the gateway body deadline (it at first passed through Node's own 408, so I added a timing assertion);
- the directory POST route;
- host sequence monotonicity (this hung on a leftover listener, fixed with `t.after` cleanup).

**Regression.** All 77 test files that import `network/` or `session-api-auth`: **450/450 pass**.

## Remaining wiring and gaps

- **CLI:** no `enclave logs/attest/restart` uses `ManagementClient` yet (S7). It needs an async SDK signer adapter (the
  client already awaits one) and a persistent `stateDir`.
- **Supervisor environment:** `SESSION_API_HOSTS` must include `enclave-management.invalid/<runner>`, plus
  `api.enclave.host` only if the relay path should stay. Not configured anywhere.
- **Host/control image:** start `node network/management-host.mjs <config>` beside the supervisor (with `stateDir`), and
  provision the management TLS key and the private operator key file. Not done.
- **Browser/site and Windows:** no dashboard or Windows `hv-node` integration. Browsers cannot pin the management TLS key,
  so a browser path needs a separate design.
- **Directories in production:** the directory change is in source, but no deployed directory replica runs it yet.
- **Unchanged gaps:**
  - SessionVault credentials only (no EOA or SIWE per-request credential);
  - no `app-token` or CPU profile;
  - logs are a tail with no follow mode;
  - rate limiting is only the in-flight bound;
  - no measured-host binding of the management key;
  - no live end-to-end run.
