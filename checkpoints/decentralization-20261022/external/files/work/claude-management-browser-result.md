# Management: quorum authorization, parity and the browser transport. Claude result (2026-10-20)

Repo `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`. Nothing is committed or pushed. There were no SSH, Wine,
GUI, production, wallet or chain actions, and no private configuration was read. I did not edit any CLI, site, Windows,
custody, bootstrap or isolation file. The contract for the CLI and browser workers is published at
`/home/steven/Documents/Codex/2026-10-18/wo/work/management-interface.txt`.

## The interrupted broad run

The earlier broad run (`/tmp/claude-mgmt-auth.log`) was **invalid**. It selected the CLI worker's unfinished
`cli-independent.test.mjs`, which failed and held handles; the coordinator stopped it (`work/management-broad-test-stop.json`).
That run is not evidence of anything. I did not rerun any broad grep-selected suite.

## Final verification

One sequential run with `--test-concurrency=1`, stable relevant files only, exit 0: **116 tests, 116 pass, 0 fail,
0 skipped, 0 cancelled** (`/tmp/claude-mgmt-final.log`). The files were:

```
test/management-plane.test.mjs      (30)
test/public-directory.test.mjs
test/session-api-auth.test.mjs
test/session-authority-pins.test.mjs
test/native-client.test.mjs
test/bootstrap-supervisor.test.mjs
test/direct-only-supervisor.test.mjs
test/private-app-auth.test.mjs       (supervisor app-token)
test/wasm-cpu-profile.test.mjs       (supervisor CPU profile)
```

**Mutation tests.** These ran only in isolated `/tmp` copies, never in the shared tree; all copies were deleted and no
shared file was weakened. Each mutation below made its test fail:
- a first-answer `agreed()` (re-checked against the concurrently rewritten `LeaseReader`);
- the owner rule, the scope check and the delegation-grant check;
- the authorization deadline and the fail-closed freshness check before forwarding;
- the gateway replay guard (it first survived, masked by the stand-in's own guard; the test now asserts the supervisor
  never sees the replay);
- exact profile bodies, and treating a profile 409 as definite;
- the supervisor `MANAGEMENT_GATEWAY` base;
- for the browser transport: the gateway CORS allowlist, the helper's dashboard check, the record-operator check, the
  DNS-origin rule, and the WebCrypto signature check.

**Memory.** The floor was respected: the first 846 MB tmpfs scratch was removed, and later copies were about 4 MB with
`node_modules` symlinked.

## 1. Authorization from one agreed snapshot (`network/management-auth.mjs`, new)

- **Signature first.** The gateway verifies the request signature locally: the runner-derived base, method, path, body
  hash and 60 s window. It then spends the nonce **for good**, never releasing it, so a refusal can never be replayed
  later into an acceptance.
- **One snapshot.** Every authorization fact comes from **one** `LeaseReader.agreed()` snapshot: two RPCs must return
  identical values at one fixed, fresh, reorg-checked block. The facts are:
  - the ledger row;
  - the runner's registry entry (active, same operator);
  - `isVault` on the pinned factory;
  - the session (key hash, actions, environments, expiry, liveness);
  - the vault owner;
  - the held environment, or the delegation (ledger code plus storage slot).

  Nothing is cached, and no fact comes from a different block. The decision is a pure function of that snapshot.
- **Deadline.** The operation's hard deadline races the chain read, so a hung read is a refusal (504) and the slot is
  freed.
- **Fail closed before forwarding.** The gateway refuses **before any upstream request exists** when the earliest of the
  deadline, lease end, snapshot freshness and session expiry has passed. This removes the earlier stale-forward race.
- **Rechecks.** While an answer flows, the authorization is re-read, never two rechecks at once; each fresh snapshot
  re-arms the cut time.
- **Host wiring.** `management-host.mjs` now gives the gateway only the agreeing `LeaseReader`. There is no first-answer
  client anywhere, so the coordinator's first finding is closed.
- **Supervisor (narrow change).** With `MANAGEMENT_GATEWAY=1`, the supervisor **adds**
  `enclave-management.invalid/<keccak256(PUBLIC_URL)>` to its session bases, computed inline because the image has no
  `network/` directory. The relay and `PUBLIC_URL` bases are unchanged.
- **Supervisor test seam.** New `MANAGEMENT_SUPERVISOR_SELFTEST` serves the **actual** supervisor's owner routes. Only
  chain reads, the app manager and the relaunch are scripted.

Tests. The quorum is real `LeaseReader.agreed` over three scriptable RPC clients:
- **Lying RPC.** One RPC lies and is made to answer first. It cannot authorize an attacker's session as owner, while the
  two honest RPCs still authorize the real owner.
- **No agreement.** One honest RPC, one liar and one down give a 503, with zero supervisor hits.
- **Deadlines and expiry.**
  - A slow chain read gives a 504 in under 2 s, and the slot is freed.
  - A session that expires during a delayed read gives a 401 `session_ended`.
  - A lease that ends during the read gives a 409.
  - A block that ages out during the read is refused before forwarding (503 from the reader, or 504).
- **Authority checks.** Missing scope, a revoked session and an owner transfer are refused. For wallet-held
  deployments, missing delegation support and a missing grant are refused, and the grant then succeeds.
- **Request checks.** Replays, rebound bodies, wrong methods, typed-body violations and admin paths never reach the
  supervisor.
- **Actual supervisor.**
  - Behind the gateway, status, logs, app token, CPU profile, profile start and restart each work, and each side effect
    happens exactly once.
  - It accepts the derived base, and refuses another runner's base.
  - Without `MANAGEMENT_GATEWAY` it refuses the management base and keeps its `PUBLIC_URL` base.

## 2. Parity: app token and CPU profile

These are exact routes in `management-routes.mjs` with the same quorum authorization; there is no generic proxy.

| Route | Scope | Body | Response bound | Mutation |
| --- | --- | --- | --- | --- |
| `POST …/app-token` | `api.appAccess` | none | 8 KiB | no |
| `GET …/cpu-profile` | `api.logs` | none | 24 MiB (≤16 MiB capture) | no |
| `POST …/cpu-profile` | `api.logs` | exactly `{"action":"start","seconds":1..60}` or `{"action":"stop"}` | 64 KiB | yes |

- **App token.** The client validates `{token, tokenType: 'Cookie', deployment, expiresAt}`. It is the supervisor's
  per-deployment, audience-pinned token, never host-wide.
- **CPU profile.** The client decodes the capture bounded to 16 MiB.
- **Profile-control outcomes.** A manager 422 is definite. A 409 is outcome-unknown, because the profiler can leave a
  capture "uncertain"; so are a malformed answer and any 5xx.
- **Shared classifier.** New `management-outcome.mjs` holds the outcome rules; the native client was refactored onto it
  and the browser helper uses the same one.

## 3. Browser transport: exact scope

**What it is.** It is an **optional, explicit** operator choice, carried by a v2 record (`management-record.mjs`, now
browser-safe):
- **Record.** `browser: {origin, dashboards}` sits inside the operator signature, under the message prefix
  `enclave-network:management:v2`.
- **Origin.** An exact `https://` origin on a public DNS name. IPs, reserved names, paths, queries, credentials and
  wildcards are refused.
- **Dashboards.** 1 to 8 exact `https` origins.

**Native path unchanged.** v1 records and the native exact-SPKI path are untouched: every v2 record keeps
address, port and SPKI.

**What the browser checks.** In the browser, the page's own **WebPKI** validation of that operator-signed origin is the
transport check:
- `transport: 'browser-webpki'`, and the helper never claims an SPKI check;
- it depends on DNS and a CA, which the native path does not; when those fail, the native path still works (tested).

**Owner authorization is identical on both paths:** a per-request signature, a single-use nonce, the agreed chain
snapshot, and no relay, bearer, cookie, retry or redirect.

**Gateway.**
- **CORS:** only for the listed dashboards. A request carrying any other `Origin` is refused with 403 **before
  authorization**, never forwarded, with no allow-origin header.
- **Preflight:** only on management routes (methods GET and POST; headers `authorization` and `content-type`; no
  credentials).
- **SNI:** selects the WebPKI certificate for the origin's name; literal-IP native clients get the pinned key.

**Helper (`management-browser.mjs`, new, browser-safe).**
- `browserManagementEndpoint(envelopes, lease, {…, dashboardOrigin, floor})` verifies the record against the
  **caller's quorum-verified lease**, enforces the shared floor (`managementFloorKey`, the same as native) and the
  dashboard allowlist, and returns the new floor to persist.
- `browserManagementRequest` checks the signer's answer with WebCrypto, refuses an expired lease or record before
  sending, and makes one fetch (`redirect: 'error'`, `credentials: 'omit'`, `mode: 'cors'`, `no-store`, `no-referrer`)
  with byte limits.
- A browser network failure is `sent: null` and, for mutations, outcome-unknown.

**Host.** `config.browser` = `{origin, dashboards, tlsKeyFile, tlsCertFile}` makes the host publish v2 and serve the
WebPKI certificate.

Tests:
- **Setup.** A real test CA chain is checked by Node's TLS for the origin's name. The page's fetch is emulated,
  enforcing preflight, `Access-Control-Allow-Origin`, exposed-header filtering, `redirect: 'error'` and no credentials.
  Signing uses WebCrypto.
- **Happy path.** Every operation works through the browser path, with fetches only to the operator origin and **no
  `*.enclave.host`**. The native path works on the same gateway.
- **Refusals.** An unlisted dashboard is refused by the helper and by the gateway (403, no allow-origin header).
- **Record attacks.** A record swapped in by a directory (signed by a stranger) is ignored. A replayed older record
  after a newer origin is stale. A newer v1 record gives "no browser transport", never a guessed origin.
- **Chain conditions.** A changed owner is refused (403) and no quorum is refused (503), with zero supervisor hits after
  the change.
- **Transport failures.** An untrusted certificate or an unresolvable name fails closed (a mutation gives
  outcome-unknown), while the native path keeps working.
- **Signer and schema.** A signer answer for another request is refused before any fetch. The origin and dashboard
  schemas are strict.

**Not shown by me.** I ran no real-browser test. Bundling the helper into a page belongs to the browser worker's rig, and
I did not use their site files. It is the browser worker's integration test to run in Chromium:
- the explicit origin works;
- unlisted origins, swapped records, a stale owner and no quorum all fail;
- no Enclave domains are contacted.

## Concurrent change I adapted to

`network/lease-reader.mjs` was substantially rewritten by another worker (uncommitted). `agreed()` now also refuses blocks
that go stale during the read, has its own deadline, and re-rounds on newer blocks. My use of
`agreed(read, failures)` with `read(client, blockNumber)` is compatible. One test now accepts the reader's own 503 for a
block that ages out (my gateway check remains as the second line). I did not edit that file.

## Remaining integration and gaps

- **CLI** (CLI worker): `enclave logs/attest/restart/app-token/cpu-profile` on `ManagementClient`, using the interface
  contract.
- **Browser** (browser worker): the dashboard UI on `management-browser.mjs`. Its lease must come from the site's own
  quorum reader; persist the returned floor; show the trust statement (WebPKI vs SPKI) and "check status" on
  outcome-unknown; and run the real-browser test above.
- **Production:** set `MANAGEMENT_GATEWAY=1` in the host/control image; run `management-host.mjs` beside the supervisor
  with its keys, `stateDir` and at least two RPCs; deploy the updated directory server; obtain a WebPKI certificate and
  DNS name for any browser origin. None of this is done.
- **Unchanged gaps:**
  - SessionVault credentials only (no EOA or SIWE per-request credential);
  - logs are a tail with no follow mode;
  - no measured host binding of the management key;
  - rate limiting is only the in-flight bound;
  - no live end-to-end run.

---

# Addendum (2026-10-20): fixes for the independent review (work/claude-management-independent-review-result.md)

**Reproduction.** All three of the reviewer's scratch reproductions reproduced before I repaired anything:
- `stall.mjs`: the owner got 429 with 16 slots held;
- `repro.mjs`: 16 forged keys produced 16 `agreed()` calls;
- `floor.mjs`: the new operator's record was refused as stale.

## Fixes

- **F1 (high): admission.** `management-gateway.mjs` now has staged, bounded admission:
  - **Before authorization:** global 64 and 4 per source (IPv6 by /64). Chunked bodies, and any declared length the
    operation cannot carry, are refused at once; the one small body has a 2 s deadline.
  - **Chain authorization:** global 8; per source 2; per deployment 4; per key 2; a per-source rate of 30/min with a
    burst of 10. A reserve of 4 slots is kept for session keys that authorized within 15 min.
  - **Refuse-only memory (15 s):** a deployment that is not leased to this runner, and a signer that is not a vault, are
    refused without a chain read.
  - **Forwarding:** separate long and short pools, with 4 per deployment.

  This does **not** make the gateway immune to a distributed flood (stated in the doc).
- **F2 (medium): rollback floors.**
  - A record's sequence may not exceed its `issuedAt`, which may be at most 60 s ahead.
  - Floors are kept per (network, runner, operator): one file each natively, and a bounded composite in the browser that
    refuses rather than forgets.
  - A new operator is never blocked by a former one, rollback within an operator is still refused, and a returning
    operator keeps its own floor.
- **F3: claims made precise.** The doc and client header now separate the two dependencies. The endpoint needs no DNS
  or CA. Authorization still needs two agreeing HTTPS RPCs through `LeaseReader` (DNS and WebPKI unless they are literal
  IPs with IP-SAN certificates); local-node support is pending with `LeaseReader`'s owner. Nothing claims complete
  independence.
- **F4: browser origin.** `browserManagementRequest` re-verifies the endpoint's signed envelope and takes the origin
  only from it. Substituted origins or records, a missing envelope, and withdrawn, native-only or expired records are
  refused before the signer runs or any fetch.
- **F5: replay guard.** The gateway's own `strictReplayGuard` never evicts a live nonce and refuses with 503
  `replay_capacity` when full. The supervisor's legacy guard in `session-api-auth.mjs` is outside my scope and unchanged
  (documented).
- **F6: other ingresses.** The supervisor accepts the management base only on loopback **with**
  `MANAGEMENT_GATEWAY_TOKEN`, which the gateway sends as `x-enclave-management-gateway`. It is added per request, never
  to the global bases.
- **F7: production seam removed.** `MANAGEMENT_SUPERVISOR_SELFTEST` is gone from `supervisor.js`. Tests use a test-only
  process fixture, `test/helpers/management-supervisor.mjs`, that runs the unmodified supervisor:
  - a local JSON-RPC for chain reads, as `BASE_RPC`;
  - a local app manager, as `VMMGR_URL`;
  - a seeded `STATE_FILE`;
  - `test/helpers/loopback-only-fetch.mjs`, a preload that refuses non-loopback fetches.
- **F8: parity.** Documented as future work: EOA/SIWE credentials, log follow, and deletion, topup, listing and domains.

## Tests and verification

- **New adversarial tests:** 7 for F1, F2, F4 and F5. The two actual-supervisor tests were rewritten onto the fixture
  and now also cover F6: a missing token, a wrong token, another runner's base, and the token from a non-loopback peer.
- **Mutation checks:** run in a 76 MB isolated copy with `node_modules` symlinked; the copy is deleted. 12 of 13 single
  mutations were caught. The survivor is F4's derivation, which the separate origin-equality check covers; each of the
  two F4 checks is caught on its own.
- **Final run:** sequential (`--test-concurrency=1`), stable files only: **123 of 123 pass**, exit 0
  (`/tmp/claude-mgmt-review-final.log`). The files were `management-plane` (37), `public-directory`, `session-api-auth`,
  `session-authority-pins`, `native-client`, `bootstrap-supervisor`, `direct-only-supervisor`, `private-app-auth` and
  `wasm-cpu-profile`. No supervisor processes were left running.

## Still open

- Distributed-flood resistance.
- `LeaseReader` local-node support (F3).
- The supervisor's legacy replay eviction (F5, in `session-api-auth`).
- EOA/SIWE credentials and log follow (F8).
- Production activation: `MANAGEMENT_GATEWAY` with its token, the host launcher, directory deployment, and browser
  certificates.

Stable API changes are appended to `work/management-interface.txt`. The only breaking one is the native
`floorKey(runner, operator)`; the browser helper stays compatible with the current site.
