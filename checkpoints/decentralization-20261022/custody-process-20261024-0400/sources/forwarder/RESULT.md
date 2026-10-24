# Custody v2 canary ingress forwarder: source and tests only (2026-10-23)

This is the follow-up to `work/custody-v2-direct-route-20261023` (root accepted Option A).

**Scope.**
- This is a reusable forwarder for the isolated canary ingress on metal0, with real-HTTP adversarial tests, a mutation check, and
  canary-only example configs.
- Nothing was started, configured or deployed. There was no production, SSH, key, chain or config action, and the original
  custodian and the frozen image are untouched.
- The forwarder was not run against a real custodian guest. The upstream in the tests is a stand-in that dispatches the way the
  guest does.
- This is NOT final routing and NOT decentralized custody. The permanent Linux host-role route stays deferred.

## What it is

`forwarder.mjs` uses Node only, with no dependencies (Node v22.23.3 here).
- It listens on loopback only, as the reverse tunnel's target behind the control-VM HTTPS prefix.
- It forwards to ONE fixed loopback port: the canary custodian's `mgmtPort`.

**Allowlist.**
- The allowlist is the reviewed one: `pinned/ingress.mjs` is a byte copy of `custody/v2/ingress.mjs` at **ab589bf8** (blob
  ebacbcc6), the corrected-image source root named.
- The test parses that file's generated Caddy site. It does not re-type the routes.
- There are 12 method+path pairs: `GET /v2/custody/info` and 11 `POST` routes.
- Private routes (host-binding, `/health`, `/`) and the host's state/submit port are unreachable by construction.

**Matching.**
- The RAW request target must equal `<prefix><route>` byte for byte, with that route's one method.
- Nothing is decoded, normalised or case-folded, so any encoded, dotted, backslash, double-slash, query, `;`, trailing-slash,
  case-variant or absolute-form spelling gets 404.
- The upstream path is the allowlist's own constant.
- Why: the guest uses WHATWG `new URL()`, which resolves `/v2/custody/x/%2e%2e/host-binding` or `…\..\host-binding` to the
  private route. The tests assert that hazard exists, and that no such request reaches the upstream.

**Headers.**
- Nothing from the client is forwarded: no Host, X-Forwarded-*, Forwarded, Cookie, Authorization or hop-by-hop headers.
- Upstream gets only host, accept, connection: close, and for POST content-type: application/json plus content-length.
- The client gets only content-type, content-length, cache-control: no-store, nosniff, connection: close and a numeric
  Retry-After. There is no keep-alive or pipelining, and Upgrade and CONNECT are destroyed.

**Bounds (defaults).**

| Bound | Default | Result when exceeded |
|---|---|---|
| Body | 262144 B (the guest's `MAX_BODY`): declared size checked before reading, then counted | 413 |
| Whole body | within 10 s | 408 |
| Body on GET | not allowed; conflicting or duplicate framing is refused by Node's parser | 400 |
| Headers | 8 KiB, within 10 s; whole request 45 s | 431 / 408 |
| Concurrent requests | 16 | 503 |
| Whole upstream exchange, including the response body | within 30 s | 504 |
| Response body | 1 MiB | 502 |

- The upstream must answer 2xx, 4xx or 5xx with JSON. 3xx and non-JSON give 502, so no redirect is followed or passed on.
- A truncated or reset upstream gives 502.
- A client that disconnects aborts the upstream request.
- The response is **buffered up to its cap, not streamed byte by byte**. That way a failure becomes a clean 502 or 504, never a
  truncated success. Custody responses (quotes, ciphertexts, signatures) are small.

**Configuration** (`validateConfig`):
- `listen.host` must be 127.0.0.1 or ::1.
- `upstreamPort` is an integer port; there is no host or URL setting.
- `prefix` is 1–3 lowercase segments, not under `/t/` (the relay's tunnels) or `/v2`.
- Limits are bounded, and unknown keys are refused.

## Tests (all through the unchanged queue, 256 MiB lane; logs in `logs/`)

- **`logs/test-6.out` (final):** 12/12 pass (`node --test test/allowlist.test.mjs test/forwarder.test.mjs`). Peak 132 MiB.
  - **Pin:** the pin equals the ab589bf8 blob (also checked against the durability repo's git object).
  - **Allowlist:** it equals `directCustodyIngress()` output exactly, and the example config and Caddy snippet match it.
  - **Config:** 21 invalid configs are refused.
  - **Allowed routes:** each of the 12 is forwarded with its own method, exact path and body. The upstream sees only the 3–5
    allowed headers, and the client gets only the allowed response headers.
  - **Adversarial targets:** more than 250, each sent as both GET and POST over a raw socket, return 400/404, and the upstream
    hit log stays empty.
    - Private routes, with every %-encoding, double-encoding, `..`/`.`/`%2e`, backslash, NUL, bidi, full-width, case, query,
      `;`, trailing-slash, double-slash and prefix variant.
    - Encoded spellings of the public routes themselves.
    - Absolute-form targets and truncated routes.
  - **Methods:** HEAD, OPTIONS, PUT, DELETE, PATCH, TRACE, WebDAV methods, the wrong method per route and a lowercase method are
    refused. CONNECT and Upgrade are closed.
  - **Request limits:** declared and chunked oversize, a GET body, TE+CL, duplicate CL, oversize headers, a slow body (408 near
    the 400 ms deadline) and slow headers. Exactly the cap passes. `Expect: 100-continue` is answered only after the checks.
  - **Upstream failures:** refused (502), hung (504), redirect (502, Location dropped), non-JSON or no type (502), declared or
    streamed oversize (502), slow body (504), truncated or reset (502). 1xx then 200 works, and 429 and 422 pass through
    (Retry-After kept, Set-Cookie dropped).
  - **Client abort:** it aborts the upstream request.
  - **In flight:** the in-flight limit gives 503.
  - **Connections:** the only outbound connection is to `127.0.0.1:<upstreamPort>`.
- **`logs/mutants-3.out` (final):** `node test/run-mutants.mjs` runs 24 mutants; **all 24 are killed**, and the unmutated control
  passes. Peak 191 MiB.
  - The mutants include the required **unsafe wildcard** (`/v2/custody/*` with any method). It is killed by the private-route and
    method tests.
  - The others: case-insensitive, percent-decode, WHATWG-normalise, ignore-query, strip-trailing-slash, method-agnostic,
    forwarding client headers, passing upstream headers, each size, time and response cap removed, passing redirects, no JSON
    check, accepting truncated responses, no client-abort, no in-flight limit, non-loopback listen, a prefix under `/t/`, no
    Upgrade/CONNECT guard, and Expect-continue before the checks.
- **Earlier runs, kept:**
  - test-1 (a bad test-path argument), test-2 and test-3. They caught a test regex bug, Node's automatic Date header (now off), a
    400-instead-of-431 header-overflow mapping, and a real forwarder bug: a Buffer upstream body was JSON-encoded, not passed
    through. All are fixed.
  - mutants-1: 2 survivors (percent-decode and no-body-deadline) exposed two weak tests. The tests were strengthened, and
    mutants-2 and mutants-3 kill all 24.

## Example configs (canary only, placeholders; not applied anywhere)

- **`examples/forwarder.canary.json`:** forwarder on 127.0.0.1:18901 to canary mgmtPort 18787, prefix `/custody-v2-canary/metal0`.
- **`examples/Caddyfile.canary-snippet`:** inside the existing api.enclave.host site on the control VM.
  - The exact 12 method+prefixed-path pairs go to `127.0.0.1:<R>`, with a 262144-byte body cap.
  - Everything else under `/custody-v2-canary` returns 404.
- **`examples/reverse-tunnel.canary.txt`:**
  - The metal0 `ssh -N -R 127.0.0.1:<R>:127.0.0.1:<F>`. The target is the forwarder, never `<MGMT>`.
  - The control-VM authorized_keys line: `restrict,port-forwarding,permitopen="none",permitlisten="127.0.0.1:<R>",command="/bin/false"`.
  - Negative checks, and teardown.

## Limits (honest scope)

- **Not tested against real infrastructure.** There was no real custodian guest, Caddy, SSH tunnel, TLS or SNP in these tests.
  Caddy is not installed on this workstation, so the Caddy snippet is checked only textually against the allowlist.
  - Its path matching (Caddy normalises before matching) is the first layer only. The forwarder's raw-target check is the
    authority.
- **Rate limiting:** behind this hop every client shares the guest's one per-TCP-peer rate bucket. That is acceptable for a
  canary. Per-client limits need an image measured with `--trusted-proxy` plus a forwarded client address, and that is
  deliberately not implemented here: the forwarder never sets X-Forwarded-For.
- **Shield attest bodies** larger than `maxBodyBytes` are refused (413). The corrected image measures no Shield recipients, so
  these routes answer 404 in the guest. If a Shield image is canaried, set `maxBodyBytes` to its measured `maxAttestBytes`.
- **Responses:** buffered up to the cap, not streamed byte by byte (see above).
- **Corrected image:** per root, it is ab589bf8, measurement 70aadf…, with fresh/reopen AMD quotes and the storage-503
  no-identity-replacement hardware test passed. D did not verify any of that; it is root's record.

## Follow-up: cancellation race (ROOT-FOLLOWUP.txt, 2026-10-23T20:35Z)

**Finding (confirmed).**
- In 35d73c68 a client could go away after its body completed but before the upstream request was created.
- Its socket `close` can arrive via `nextTick`, which runs before the `await` continuation. The `AbortController` was then already
  aborted, and the abort listener attached afterwards never fired.
- The upstream request was still sent, and its answer was discarded. That is wasted upstream work, but no exposure: the path and
  method are still the allowlisted constants.

**Fix** (`forwarder.mjs`).
- Right after the body (or none, for GET) and before any upstream socket exists, the forwarder checks the state itself:
  `ac.signal.aborted || res.destroyed || req.socket.destroyed`. If any is true it returns `client_gone` without creating a request.
- Inside the upstream promise, `if (ac.signal.aborted) return end({gone})` follows the listener.
  - It is defensive only: the code between the pre-check and the listener is synchronous, so no test can reach it on its own.
- An abort after the upstream request exists was already handled: the listener destroys the request. The existing test "a client
  that goes away aborts the upstream request" covers it.
- A test-only seam, `createForwarder(config, { afterBody })`, runs in exactly that window; production passes nothing.

**Evidence** (queue, 256 MiB):
- **`logs/test-7.out`:** 13/13 pass, peak 132 MiB. The new test covers POST release and GET info:
  - the client is made to go away in that window, without the abort having fired yet;
  - the upstream sees **no request and no TCP connection**, and the log reason is `client_gone`;
  - in flight and forwarded counts are 0;
  - a control run without the seam forwards normally.
- **`logs/mutants-4.out`:** only the cancellation-related mutants were re-run, plus the control. Both are killed:
  - `no-gone-check-before-upstream` (both new checks removed), by the new test;
  - `no-abort-on-client-gone`, by the existing abort test.
- **Not re-run:** the other 23 mutants. Their logic is unchanged, and their last full run is `logs/mutants-3.out`, 24/24 killed.

**Response handling** stays as documented above: **bounded buffering** (up to `maxResponseBytes`, under the upstream deadline),
not streaming.

**Scope is unchanged:** the public port never exposes host-binding, state or submit. Root has not installed or run this against
production, and D has not either.

## Dedicated-origin correction, October24

The r2 canary requires an exact HTTPS origin, whereas the original example only accepted an API path prefix. Added explicit `mount: "origin", prefix: ""` support; legacy prefixed configurations retain their behavior. An omitted mount still means prefix, and a missing or nonempty prefix is refused in origin mode. Matching remains byte-exact against the same 12 reviewed method/path pairs; no route was added.

`origin-config.mjs` generates a dedicated Caddy site, loopback forwarder configuration and reverse-port specification. It refuses shared Enclave/API origins, paths, credentials, alternate TLS ports and colliding local/remote ports. The generated example targets `custody-canary.enclave.host`; it is not installed and no DNS record was created. This remains temporary centralized canary ingress, not completed decentralized routing.

`logs/root-origin-tests-1.out`:16/16 pass, including real loopback HTTP for all12 direct-origin routes and rejection of private/encoded/normalized/wrong-method requests without an upstream hit. The installed control-VM Caddy accepted the generated dedicated-origin site with `caddy adapt --validate` at02:43:30UTC. That was syntax/provisioning validation only; there was no listener, live config write, reload or TLS certificate acquisition. See `evidence/origin-caddy-validate.json` and generated public config in `examples/`.

October24 02:57UTC root continuation: the first selected mutation run ended with signal143 and provides no mutation success evidence. The runner now requires an actual assertion failure (exit1, no timeout/signal) and uses Node's bounded test/force-exit controls so failed fixtures cannot leave listeners hanging. The new run, logs/root-origin-mutants-2.out, passed its unmodified control and detected all8 selected guards, including both new origin-mode guards. No production config, listener, DNS or tunnel was installed.
