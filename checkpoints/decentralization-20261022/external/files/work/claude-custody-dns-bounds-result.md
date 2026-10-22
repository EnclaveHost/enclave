# DNS-01 responder Shield session handler: request bounds and admission (result)

**Repository:** `wo/work/enclave` (main working tree, at `d0676ff3`).

**Constraints kept:**
- Nothing committed. No production, SSH, Wine, new windows or chain writes.
- No source mutation in the shared tree: all mutation checks ran in an isolated on-disk copy, deleted afterwards.
- Not touched: the shared session module (`relay/shield-host-session.mjs`), `relay/dns-relay.js`, and all custody,
  Windows, browser, CLI and Go source.

**Scope.** This finishes the existing `POST /v1/shield-session/{challenge,attest}` handler. It adds no route, authority
or platform.

**The guest candidate** `c7084346` remains unactivated.

## Changed files (exactly)

| File | Change |
| --- | --- |
| `relay/dns-challenge-shield.mjs` | `handle()`: per-route body bounds, admission counts, read deadlines, and a slot release that settles exactly once. New exports `SHIELD_CHALLENGE_MAX_BYTES`, `SHIELD_ATTEST_MAX_BYTES`, `HVNODE_RAD_BODY_MAX_CHARS`. New options on `createShieldChallengeAuth`, validated. Read-only `inflight()`. |
| `test/shield-dns-challenge.test.mjs` (its direct test) | 2 new tests. The relay-process test extended. `responder()` takes options. |
| `work/custodian-shield-daemon-interface.txt` | "DNS RESPONDER BOUNDS ADDENDUM", D1 to D5. |

## What `handle(req, res, json)` does now

The contract is unchanged: `dns-relay.js` still passes its own `json(code, body)`, and still rate-limits per socket peer
before calling.

**Body bounds come from what the verifier itself accepts, never less.**
- **challenge:** `SHIELD_CHALLENGE_MAX_BYTES` = 796,108 bytes (about 777 KiB). That is one EK plus `VBS_MAX_CHAIN_CERTS`
  (8) chain certificates, each at the TPM verifier's 64 KiB maximum in the session module's own base64 bound, plus
  `aikPub` (1024 B), `aikName` (34 B) and an 8 KiB envelope.
- **attest:** `SHIELD_ATTEST_MAX_BYTES` = 12 MiB + 8 KiB. The 12 MiB is the session module's own `rad.body` ceiling.
  The previous flat 16 MiB is gone.

**How bounds are applied.** A declared `Content-Length` over the bound gets 413 before reading. A streamed body gets 413
at the bound; the rest is discarded and the connection closed.

**Admission.** Up to `maxConcurrentChallenges` challenge requests (default 8, range 1..64) and `maxConcurrentAttests`
attest requests (default 2, range 1..16) may be held at once. A request is held from arrival through body read and
verification. The next one gets 503 `{error:"busy"}` with `retry-after: 1`. The decision is made synchronously on
arrival, before any byte is read, so it is deterministic.

**Read deadlines.** `challengeReadMs` 30 s and `attestReadMs` 120 s (12 MiB at about 1 Mbit/s); past them, 408 and the
connection closes. Out-of-range or non-integer options throw at construction.

**Release.** The slot is released exactly once (in `finally`, after a body read that settles once) on every outcome:
- 405, 413 (declared or streamed), 408;
- 400 (bad JSON);
- the client disconnecting or erroring;
- a verification refusal (expired, replayed, wrong-CA EK, wrong operator signature);
- an internal error;
- success.

**Memory, worst case.** About `maxConcurrentAttests × 12 MiB × a small parse factor`, so tens of MiB at the defaults,
instead of an unbounded number of 16 MiB bodies.

## Tests (actual HTTP, real fixtures)

All are in `test/shield-dns-challenge.test.mjs`, 10/10, three consecutive clean runs.

**"Bounds are the verifier's own maxima…"** (the real handler behind the same `json` responder `dns-relay.js` uses):
- **The genuine exchange passes the bounded handler:** challenge with the synthetic TPM's genuine EK, the node's real
  `buildHvNodeFrame`, attest 200, then the guest's push authorized.
- **Bodies up to the verifier's limits reach the verifier:**
  - a maximal challenge envelope (8 chain entries of 87,384 base64 characters each, about 700 KB) is read, and the
    session module itself answers 422;
  - one byte over the challenge bound gets 413, both with a declared length and chunked.
- **Attest at the session module's ceiling:**
  - `rad.body` at exactly 12 MiB reaches the session module (its own 422, "not JSON");
  - at 12 MiB + 1 it is the session module's own refusal ("missing or oversized"), not the handler's;
  - only a request over `SHIELD_ATTEST_MAX_BYTES` is the handler's 413.
- `inflight()` returns to `{0,0}`.

**"Admission: overload is refused at once…"** (`maxConcurrentChallenges: 2`, `maxConcurrentAttests: 1`, 1 s deadlines):
- **Overload.** One attest held mid-body: three further attests each get 503 `busy` with `retry-after: 1`. A genuine
  challenge on the other route still gets 200, because the routes are admitted separately.
- **Disconnect release.** The held client disconnects; once the server observes the close, the slot is back.
- **Deadline release.** Two challenges held: the third gets 503, then both held ones get 408 at the deadline and
  release.
- **Release on refusals:** bad JSON (400), a declared oversized attest (413), a never-issued session (409), a wrong-CA EK
  (403).
- **Release on verification failures**, on a responder with a controlled clock: an expired challenge (+61 s, 409) and a
  stranger's operator signature (403).
- **Recovery.** The genuine host's full exchange then passes on the same single attest slot, and its guest's push is
  authorized.
- **Options.** Out-of-range and non-integer values throw.

**The real relay process** (the existing test, extended; `relay/dns-relay.js` spawned with `ATTESTED_SHIELD_POLICY` on
loopback). Through the relay's own dispatch and `json`:
- a genuine challenge gets 200 with a credential;
- a challenge one byte over the bound gets 413;
- an attest declaring `SHIELD_ATTEST_MAX_BYTES + 1` gets 413 before any body is sent.

**Mutation checks**, in an isolated on-disk copy (`work/claude-dns-bounds-iso`, 36 dependency files resolved with
esbuild, `node_modules` symlinked; deleted afterwards). Baseline 10/10 there. Each mutation is detected as a **fail**,
not a timeout (the waits that only a broken handler would leave open have 5 s ceilings):

| Mutation | Result |
| --- | --- |
| Challenge cap shrunk to 64 KiB | 1 fail |
| Attest cap below the verifier's ceiling (8 MiB) | 1 fail |
| No declared-length check | 2 fail |
| No admission bound | 1 fail |
| Slot never released | 3 fail |
| No disconnect release (`error` and `close` handlers removed) | 1 fail |
| No read deadline | 1 fail |
| No `retry-after` | 1 fail |

The file was restored byte-identical. The shared tree's file was compared against it and is identical.

**Regression (serial, with the 16 GiB MemAvailable floor checked before each file; never crossed):**

| Suite | Result |
| --- | --- |
| `shield-dns-challenge` | 10 |
| `dns-relay-attested` | 5 |
| `dns-relay` | 12 |
| `dns-relay-shrink` | 1 |
| `dns-relay-u7` | 3 |
| `dns-box-zone` | 4 |
| `dns-read-only` | 4 |
| `custody-endpoints` | 3 |
| `relay-hvnode-owner-only-fleet` | 5 |
| `shield-host-session` | 3 |
| `windows-shield-verifier` | 6 |
| `custody-v2-shield-daemon` | 10 (intermittently 9 / 1 fail, see below) |

All pass, apart from that intermittent `custody-v2-shield-daemon` failure.

## Found, not fixed (outside this task's ownership): an intermittent test in `test/custody-v2-shield-daemon.test.mjs`

- **Frequency.** 2 failures in 6 runs (the regression pass, then 1 of 5 reruns), always the case "over HTTP at the custodian: malicious EKs take no pending slot…"
  (my test from the previous task).
- **Cause, test-only.** The test pins its clock (`let t = Date.now()`) **before** calling `maliciousEks()`. That helper
  issues the "discrete" EK with openssl at that moment, with a whole-second `notBefore`. Within the same second,
  `notBefore` can be later than the pinned clock. The chain check then refuses the certificate as "not yet valid" before
  the on-die check, so the test sees a different (still 403) reason than it asserts.
- **Not a product defect.** The certificate is refused either way.
- **Fix, one line, for the owner of that file:** create `maliciousEks(world, other)` before `let t = Date.now()`.
- **The DNS tests don't have this race.** Their controlled-clock cases use no freshly issued certificates.

## Remaining boundaries

- **The push route is unchanged.** `POST /v1/txt` (in `relay/dns-relay.js`, not mine) keeps its 64 KiB cap and its
  per-peer rate limit. Its Shield verification (`authorize`) is synchronous CPU work, so it has no concurrent overlap
  to bound.
- **No real hardware.** Everything ran against the synthetic TPM and loopback, with no real Windows TPM boot log. The
  12 MiB attest ceiling is the session module's. A real hv-node frame's size depends on the host's boot log; the
  verifier refuses logs over 4 MiB, which fits within the ceiling.
- **Nothing activated:**
  - no responder deployed or reconfigured;
  - no host session against a real TPM;
  - no custodian image built (any custody bundle change still needs `code-approve`);
  - the Shield-direct guest candidate `c7084346` remains unactivated.

## Cleanup

- Deleted the isolated copy and its scratch files: `work/claude-dns-bounds-iso` and `work/claude-dns-bounds-iso.*`.
- Deleted my test fixtures from `/tmp`: 394 directories, 4.7 MB (`shield-dns-*`, `shield-custody-*`,
  `shield-verifier-*`).
- No test or relay process left running.
