# Independent review: the uncommitted management plane (2026-10-20)

**Reviewer:** Claude.

**Repository:** `enclave`, working tree.

**Reviewed (read-only):**

- `network/management-{auth,browser,client,gateway,host,outcome,record,routes}.mjs`;
- the `supervisor.js` diff (the derived management base and `MANAGEMENT_SUPERVISOR_SELFTEST`);
- `docs/network/independent-management.md` and `test/management-plane.test.mjs`;
- the dependencies these rely on, to the extent needed:
  - `windows/node/session-api-auth.mjs`;
  - `network/lease-reader.mjs` (as it is now: the `LeaseReader` worker is editing it);
  - `network/socks-connect.mjs` (`DirectHttpsAgent`);
  - `relay/net-guard.mjs`;
  - the supervisor's restart, app-token and cpu-profile handlers;
  - `contracts/SessionVault.sol` (session liveness);
  - the current site caller (`site/js/core/independent-management.js`, which the browser worker owns and is actively
    editing; read as a snapshot only).

**Not done:** no source edits, commits, broad suite, mutation runs, production access, SSH, Wine, GUI or chain writes.

**Run:**

- the focused existing suite: `node --test --test-concurrency=1 test/management-plane.test.mjs`, which gave **30 of 30
  passing** (no stale-fixture failures were seen);
- three scratch reproductions under `/tmp/mgmt-repro/`, which import the repository modules read-only; the code is below.

**This is a review, not a security certification.** Section "Limits" lists what was not covered.

## Summary

There is **no authorization bypass** among the classes asked about. No path was found that lets a non-owner, another
runner, another chain, a stale lease, or a replayed or altered request cause the supervisor to act or answer. Within
the reviewed code, the per-request signature, its single-use nonce and the one-snapshot quorum decision hold.

Against the **primary objective, censorship resistance**, two defects are confirmed by reproduction, and there is one
claim gap:

| # | Severity | Finding |
| --- | --- | --- |
| F1 | **High (availability / censorship)** | Anyone on the internet can lock every owner out of the gateway. 16 unauthenticated connections with a stalled body (no crypto at all) take every in-flight slot for 10 s, renewable indefinitely. Requests signed with a throwaway key also each trigger a full multi-RPC chain snapshot. |
| F2 | **Medium (availability / censorship)** | Floor poisoning. A record's `sequence` is unbounded (any safe integer) and floors are keyed per **runner**, not per operator. One record with `sequence = 2^53-1`, signed while a key is the runner's operator, makes every client that saw it refuse all later records for that runner forever, including a new operator's after rotation or transfer. |
| F3 | **Medium (claim accuracy / censorship)** | "No DNS name" and "if DNS or the CA path fails, the native path still works" hold for the **endpoint** only. Authorization, both client-side and at the gateway, needs two HTTPS RPC origins validated by WebPKI. `LeaseReader` refuses http and offers no SPKI-pinned or local-node option. |
| F4 | Low (defence in depth) | `browserManagementRequest` sends to `endpoint.origin` without checking that it equals the operator-signed `endpoint.record.browser.origin`. The current site caller is safe. |
| F5 | Low | `replayGuard` evicts **unexpired** nonces once it holds over 100k entries, and forged-key requests fill it. Exploiting it also needs a captured header. |
| F6 | Low / informational | With `MANAGEMENT_GATEWAY=1`, the supervisor accepts the management base on **every** ingress (relay tunnel, `PUBLIC_URL`), not only from the gateway. There, its own single-client, 5 s-cached check applies, and it releases a nonce on refusal. |
| F7 | Informational | `MANAGEMENT_SUPERVISOR_SELFTEST` lives in the production supervisor and replaces chain reads from an environment JSON. |
| F8 | Informational (feature parity) | Only SessionVault sessions of the **one pinned factory** work; there is no EOA or SIWE credential (documented). Logs are a tail only (documented). |

## Confirmed findings

### F1. Pre-authentication exhaustion of the gateway's in-flight slots, and chain-read amplification (High)

**Evidence** (`network/management-gateway.mjs`):

- **Line 84-85.** The global in-flight counter (`maxInFlight = 16`) is checked and incremented **before** routing,
  header checks, body reading, signature checking or chain authorization.
- **Lines 95-100.** The body is read inside that slot, waiting up to `bodyReadMs` (default 10 s, line 60) for a body that
  never arrives.
- **Line 91.** `isSessionHeader` checks only the header's shape.
- **Lines 111-118.** `verifyRequestSignature` (`management-auth.mjs:33-45`) verifies the signature against the P-256 key
  **carried in the header**. Any stranger with a fresh key and an arbitrary vault address passes it, spends their own
  nonce (line 114), and reaches `authorize()` (line 118): a full `LeaseReader.agreed` snapshot over every configured RPC.
- **The doc** says "Rate limiting is only the in-flight bound". That bound is itself the denial vector, because it is
  taken before authentication.
- **The HTTPS server** (lines 196-197) sets `requestTimeout: 30000` and `headersTimeout: 10000`. Neither cuts a request
  whose headers are complete and whose body is pending, within the 10 s body bound. There is no per-source or
  per-connection limit.

**Reproduction A: no signature at all** (`/tmp/mgmt-repro/stall.mjs`; it ran here):

1. The real `createManagementHandler` is served over plain HTTP, with a fake reader and an unused upstream.
2. 16 raw TCP connections each send
   `POST /v1/deployments/<id>/cpu-profile` with `Authorization: EnclaveSession v1 vault=0x77…,sid=0x88…,ts=1,n=abcdefgh,x=AAA…,y=AAA…,sig=AAA…`
   and `Content-Length: 17`, and then never send the body.
3. A 17th request (standing in for the owner) is sent.

Output:

```
{"ownerLikeRequestStatus":429,"stats":{"inFlight":16,"mutating":0},"agreedCalls":0,"note":"no signature was valid; the 16 bodies never arrived"}
{"after10s":{"inFlight":0,"mutating":0}}
```

Re-opening the 16 connections every 10 s keeps every owner of every deployment on this runner refused. This needs no
key, no chain read and no knowledge beyond the deployment-id format.

**Reproduction B: throwaway keys trigger chain reads** (`/tmp/mgmt-repro/repro.mjs`):

1. A fake reader's `agreed()` counts its calls, waits 2 s (a slow or rate-limited quorum) and refuses.
2. 16 GETs are sent, each signed with a fresh P-256 key, a random vault and sid, over the real management base.

Output:

```
{"agreedCallsAfter200ms":16,"seventeenthRequestStatus":429,"msUntilRefused":214}
{"floodStatuses":[503,…×16],"totalAgreedCalls":16}
```

Every forged request costs the host one full agreed snapshot: ledger row, registry entry and `isVault`, on every RPC,
with `LeaseReader`'s rate-limit retries on top. That spends the operator's RPC rate budget (often shared with the
supervisor's own chain reads) and holds the slots for as long as the chain read takes.

**Impact.** This is censorship of owner management by any third party: status, logs, attestation, app token, CPU
profile and restart. It also degrades the host's chain access.

**Fix directions** (the authors' choice):

1. **Take no global slot before authentication.** Read headers and body under a separate, small, per-source-bounded
   pool, and charge the shared slots only after the signature verifies and a cheap pre-filter passes.
2. **Limit per source address:** connections and requests per window.
3. **Add a cheap pre-filter that can only refuse, never authorize.**
   - A periodically refreshed set of deployment ids this runner currently holds, from agreed snapshots, plus a
     positive and negative `isVault` cache.
   - A request for an id not in the set, or from a known non-vault, is refused before any chain read.
   - The authorizing snapshot stays per request, as now.
4. **Use separate pools** for long streams (logs, restart) and short reads, so authorized long work cannot starve
   everything else.

**Test plan** (convert the two reproductions):

- (a) With 16 stalled-body unauthenticated connections open, an authorized owner request still gets its answer (not
  429).
- (b) N forged-key requests cause at most a bounded number of `agreed()` calls (zero, with the holding-set pre-filter).
- (c) An owner's request is served while (b) is running.
- (d) Per-source limits refuse the 17th concurrent connection from one address without affecting another address.

### F2. Floor poisoning through an unbounded record sequence (Medium)

**Evidence:**

- **`management-record.mjs:66`.** `sequence` is only checked to be a safe integer ≥ 1. Nothing relates it to
  `issuedAt` or `now`. The host's own code uses `sequence = issue time in ms` (`management-host.mjs:27-32, 76`), but
  validation does not require it.
- **`management-record.mjs:120`.** Any record whose sequence is below the floor is refused for good.
- **Floors are keyed per runner, not per operator.**
  - Native: `management-client.mjs:86`, key `recordHash({chainId, deployments, registry, runner})`.
  - Browser: `management-browser.mjs:30` (`managementFloorKey`), the same key.
  - Clients persist the highest sequence they have seen (`management-client.mjs:100`).

**Reproduction** (`/tmp/mgmt-repro/floor.mjs`; it ran here). Two random operator keys, `managementFor` and
`signManagementRecord` as in the repository:

```
accepted sequence 9007199254740991 (issuedAt 1792457423233 )
honest record of the NEW operator refused: stale management record (a newer one was seen)
```

**Impact.**

- Any key that is the runner's operator at some moment can make every client that fetches records for that runner refuse
  all of that runner's records afterwards, **across operator rotation or transfer**. That includes a compromised key
  later rotated out, a malicious operator before a sale, or a buggy clock.
- The runner id is `keccak256(endpoint)`, so the host keeps it after rotation.
- Recovery needs every client to delete its floor state by hand.
- The `2^53-1` ceiling also means nobody can ever publish above the poisoned floor.

**Fix directions** (the authors' choice):

- Require `sequence <= issuedAt` (the host already signs `sequence === issuedAt`). Since `issuedAt <= now + 60 s` is
  already enforced, a sequence can then never run ahead of real time.
- And/or key floors by `(network, runner, operator)` (a new operator starts a fresh floor), or reset the floor when the
  lease's `runnerOperator` changes.

**Test plan:**

- (a) A record with `sequence > issuedAt` is refused by `validateManagementRecord`.
- (b) After the poisoned record, a rotation to a new operator still lets the new operator's record be accepted, on both
  the native client and `browserManagementEndpoint`.
- (c) An equal-sequence equivocation is still refused, and rollback below a legitimate floor is still refused.

## Claim gap

### F3. The native path is free of DNS and CA only for its endpoint, not its authorization (Medium)

**Evidence:**

- **The doc** says (`docs/network/independent-management.md:4-5`) that management needs no "… address book or a DNS
  name". Line 47 says the native path "Depends on the chain and the operator signature". Lines 58-59 say "If DNS or the
  CA path fails, the native path still works".
- **`management-client.mjs:3`** says "No Enclave API, fleet tunnel, address book or DNS name participates."
- **But both sides authorize through `LeaseReader`:**
  - the client: `management-client.mjs:76`;
  - the gateway: `management-host.mjs:69`.
- **`network/lease-reader.mjs:32`** refuses any RPC that is not `https:`, and line 86 requires at least two distinct
  hosts.
- Those TLS connections use Node's default CA store, with no SPKI pin. So under DNS or CA interference with the RPC
  names, the client cannot resolve the lease and the gateway cannot authorize.
- An owner's own local Base node over loopback http is refused, so the most censorship-resistant configuration is not
  available.
- **The literal-IP SPKI path is correct for the management endpoint:**
  - the record's literal public address;
  - SPKI checked before any owner byte (`DirectHttpsAgent`, `socks-connect.mjs:70-77`, hands the socket over only after
    `verifyPeer`);
  - no SNI for an IP;
  - literal-IP directory origins (`management-client.mjs:79`).
- **Test 25** ("native SPKI path still works without DNS or a CA") exercises the transport with scripted RPC clients, so
  it does not cover the RPC dependency.

**Fix directions:**

- State precisely that the endpoint needs no DNS or CA, but chain authorization needs two reachable HTTPS RPCs (DNS
  and WebPKI unless they are literal-IP with IP-SAN certificates).
- Optionally support SPKI-pinned literal-IP RPCs, or an explicit local-node quorum member.

**Test plan:**

- (a) Doc and test wording assert only the endpoint property.
- (b) If pinned RPCs are added: a quorum of two literal-IP SPKI-pinned RPCs authorizes with DNS resolution failing for
  every name.

## Lower-severity items

**F4. Browser endpoint origin is trusted as given** (`management-browser.mjs:98-119`).

- `browserManagementRequest` checks that `lease.runner` and `lease.runnerOperator` match `endpoint.record`, but fetches
  `endpoint.origin + target` (line 119).
- It does not check that `endpoint.origin === endpoint.record.browser?.origin`, or that the record is v2, not withdrawn
  and not expired.
- The only current caller passes `browserManagementEndpoint`'s own result, so `origin` comes from the verified record
  (`site/js/core/independent-management.js:170-179`; snapshot of a file under active edit).
- **If a future caller passes a substituted origin** (from storage, a URL parameter or a stale object), the owner's signed
  request goes to that origin. It is valid for 60 s at the real gateway (unspent nonce), so for `appToken` the substitute
  could relay it and obtain the owner's app token.
- **Fix:** derive the origin inside `browserManagementRequest` from `endpoint.record.browser.origin`, and refuse a
  non-v2, withdrawn or expired record before calling the signer.
- **Test:** `{...endpoint, origin: 'https://evil.example'}` is refused before `signer` and before `fetch` are called.

**F5. Replay guard eviction** (`windows/node/session-api-auth.mjs`, `replayGuard`, line 195).

- Above `max` (100k) live entries, it deletes the oldest **unexpired** nonces.
- Forged-key requests fill it, because the gateway claims a nonce after a self-consistent signature (gateway line 114).
- Replaying an evicted owner nonce still needs the owner's signed header. The native path pins SPKI, and the browser
  path relies on WebPKI. So this matters only alongside a TLS compromise.
- **Fix:** refuse (fail closed) when full, or bound entries per vault.
- **Test:** fill the guard, then replay a recent nonce, and expect refusal.

**F6. The supervisor accepts the management base on every ingress** (`supervisor.js:3510`; the doc's "MANAGEMENT_GATEWAY=1
adds the base").

- A management-base header delivered through the relay tunnel or `PUBLIC_URL` is checked by the supervisor's own
  `createSessionApiAuth`. That uses its `chainClient` and a 5 s cache, not the quorum, and it releases the nonce on
  refusal (`session-api-auth.mjs:351`).
- Only owner-signed bytes verify, so this is no third-party bypass. But the gateway's guarantees (quorum, route table, no
  cookie, single forward) are not the only gate for such a header.
- **Fix:** accept the management base only on loopback connections from the gateway.
- **Test:** a management-base request to the supervisor from a non-loopback socket is refused with
  `MANAGEMENT_GATEWAY=1`.

**F7. Self-test hook in production** (`supervisor.js:8880-8920`).

- When `MANAGEMENT_SUPERVISOR_SELFTEST` is set, chain reads, `vmReq` and `provisionTenant` are replaced from an
  environment JSON, and the process serves on loopback.
- Setting the environment already means controlling the host, and `ISOLATION_DATAPATH_SELFTEST` is the existing
  precedent.
- **Suggestion:** refuse it when `PUBLIC_URL` or registry configuration is present.

**F8. Feature-parity notes (documented).**

- The gateway accepts only vaults of `pins.sessionVaultFactory`, like pinned supervisors. Unpinned supervisors accept
  `DEFAULT_FACTORIES` (v2 and v1).
- There is no EOA or SIWE per-request credential, and logs have no follow mode.

## Checked and found sound (with evidence)

**Owner, runner, chain and stale lease.**

- One agreed snapshot covers: the ledger row; the registry entry (active, with the same operator); `isVault` from the
  pinned factory; the session (key hash, scope, `live`, expiry); the vault owner; and `held` or the delegation storage
  slot (`management-auth.mjs:53-82`).
- The decision (`management-auth.mjs:88-110`) requires all of these:
  - the row id equals the request's;
  - `active`;
  - `row.runner` equals this runner;
  - `leaseUntil > now`;
  - registry active, with `host.operator === row.runnerOperator`;
  - the key hash matches;
  - live and unexpired, with the scope;
  - the holder is the vault (with `held & envs`) or the vault's owner (with production scope and a granted delegation).
- `freshUntil = min(lease end, block time + maxBlockAge, session expiry, deadline)`, checked again before any upstream
  request exists (gateway line 126).
- `LeaseReader.agreed`'s result carries `timestamp` in ms and `blockNumber` as a string, matching the decision's
  arithmetic (`lease-reader.mjs:72-74, 186`). The authorization's field names do not collide with its reserved fields.
- Session liveness matches the contract: `SessionVault._live` is `block.timestamp <= expiresAt`, with no "0 = never"
  case.

**Signature, body, path and nonce.**

- The signature covers the method, `enclave-management.invalid/<runner>` plus the exact target (deployment id and query),
  the body hash, ts, nonce, vault and sid (`session-api-auth.mjs:114-116`).
- The route table admits only the exact targets and bodies (`management-routes.mjs:145-195`). Prefixes, encodings, extra
  parameters, dot segments and admin paths return 404 (also tests 6 and 19).
- The gateway spends the nonce once the signature verifies and never releases it (line 114).
- The supervisor also claims it globally across bases, so a forwarded header cannot be replayed to the supervisor
  directly.
- The chain id is not in the signed message. It inherits that from the existing `EnclaveSession v1` format; the runner
  base and the per-chain pins bind it in practice.

**Mutations sent twice.**

- Clients are single-flight per operation (`management-client.mjs:130-134`), and the gateway locks per operation and
  deployment (lines 121-124).
- The supervisor's `rec._restarting` holds until the relaunch ends, whether or not the gateway or client disconnects
  (`supervisor.js:7790-7812`), so a resend after an unknown outcome gets `restart_in_progress`.
- Outcomes are conservative:
  - an absent or unreadable `forwarded` header counts as forwarded (native `:144`, browser `:128`);
  - every 5xx, cut-off, malformed success or profiler 409 is unknown (`management-outcome.mjs`);
  - there are no retries.

**Local and private endpoint steering.**

- Records require a public literal address (`isBlockedHost` refuses loopback, RFC1918, CGNAT, link-local, ULA,
  documentation, multicast, `::/96` including v4-mapped, and NAT64 unwrapped).
- The upstream must be loopback http, origin only (gateway lines 31-36).
- Directory origins must be literal IPs for the native client.

**Untrusted records and CORS.**

- A record must be signed by the lease's current `runnerOperator`, on the pinned chain and ledger. Equivocation and
  rollback are refused, and the client also refuses when the registry operator differs (`lease-reader.mjs:255-262`
  withholds the lease).
- The browser origin must be a public DNS name with no wildcard (`management-record.mjs:38-59`).
- The gateway answers CORS only for exact listed dashboard origins, refuses any other `Origin` (including `null`) before
  authorization, never sets allow-credentials, and exposes only the `forwarded` header.

**Data leakage.**

- Gateway logs carry the operation, a short id and the reason, never tokens or bodies.
- Error bodies are fixed strings before authentication, and RPC errors are mapped to a generic message
  (`management-auth.mjs:120`).
- Responses are `no-store` and `nosniff`, and only selected headers are forwarded (no `set-cookie`).
- The app token is the supervisor's per-deployment, audience-pinned, private-only, 12 h token (`supervisor.js:211-215,
  7374-7381`).

**Stream deadline and recheck.**

- A cut timer at `freshUntil`; rechecks every `recheckMs`, one at a time, each a new agreed snapshot that can only extend
  up to the hard bound; an abort on refusal or chain failure; cleanup on every exit (gateway lines 127-173).
- The client stops reading at `min(record expiry, lease validity)` (native `:205`), and the browser's abort covers both
  the fetch and the body read.

**Transport claims.**

- Native results are labelled `native-spki` and `host-management-record`; browser results are labelled `browser-webpki`.
  No SPKI check is claimed for the browser.
- Attestation is described as host-reported data. Neither path claims to verify a tenant's SNP proof.

## Limits

- **Not reviewed:**
  - `public-directory.mjs` and `directory-server.mjs` (record admission and replication);
  - the site UI as a whole (only its use of the helper);
  - `work/management-interface.txt`;
  - `LeaseReader` beyond the contract the gateway relies on (it is under concurrent edit);
  - the supervisor's `ownerAuth` and `mayAct` beyond the three handlers named.
- **Not tested:** real TLS and DoS behaviour at scale, per-source behaviour behind NAT, and the real RPC providers'
  rate limits. F1's amplification factor is stated qualitatively.
- **Not covered:** cryptographic primitives and viem or Node internals were assumed correct.
- **Scratch files:** the reproductions are under `/tmp/mgmt-repro/` (`stall.mjs`, `repro.mjs`, `floor.mjs`); they import
  the repository modules unchanged and can be rerun with `node <file>` from the repository root.
