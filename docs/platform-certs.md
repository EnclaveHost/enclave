# Platform certificates — the CA account on the relay, the key in the CVM

`relay/certs.js` issues CA certificates for the platform's **own** zones
(`<label>.app.enclave.host`, optionally `<label>.tcp.enclave.host`) on behalf of
the enclave that holds the deployment's lease. The enclave makes the key and the
CSR; the relay owns the CA accounts, answers dns-01, and hands the certificate
back. This page is the design in two pages: why it is shaped this way, what the
relay holds and refuses, and how to configure it. Customer-owned hostnames are a
different flow and stay where they are: [custom-domains.md](custom-domains.md).

## Why the key stays in the CVM, and why the account moves out

Two designs preceded this one, and each had exactly one thing wrong with it.

**Until 2026-07-11, Caddy on the relay minted app-zone certificates** (on-demand
TLS, gated by `/internal/tls-ask`). Simple, and wrong in the one way that
matters: the relay then *held the TLS private keys* for every app hostname, so
the relay operator — by construction an untrusted box outside the attestation
boundary — could terminate any app's traffic. It was retired for that reason.

**Since then every enclave has run its own ACME client** (`supervisor.js`
`acmeIssue`): key, CSR, order, dns-01 and download all inside the CVM. The key
never leaves, which is right. The cost is the **CA credential**: ZeroSSL needs
an External Account Binding, so the platform's EAB pair reaches *every* box —
as a Tinfoil fleet secret on the cloud boxes, and on metal boxes through
`metal/config.json` → fw_cfg, a file the box operator can read outside the CVM.
Whoever holds that pair can register accounts and order certificates for any
name they can answer dns-01 for; N copies of it is N places to leak it, and a
self-hosted seller can never be given it at all. Every enclave also sees only its
own orders, so nobody can pace the CA rate limits that are shared across the
zone (Let's Encrypt's 50 certificates per registered domain per week is one
budget for `enclave.host`, spent by every seller).

This route keeps the good half of each. **The key stays in the CVM** — the
relay receives a PKCS#10 CSR and returns a certificate; it generates no key,
signs nothing itself, and could not terminate the app's TLS with anything it
holds. **The CA account moves to the relay** — one account per CA, registered
once, the EAB pair placed in one env file on one box, and one process that sees
every order in the zone and can pace them.

```
   CVM (trusted)                                relay box (untrusted)
   ──────────────                                ─────────────────────
   generate P-256 key                            certs.js
   build CSR  CN=name, SAN=[name]   ── POST /v1/certs/issue ──▶  authorize name (our zones only)
   sign the tuple over sha256(SPKI): opSig (+ fleet HMAC)        parse CSR from DER, refuse anything else
                                                                  verify opSig (sig if sent) over THAT key, ts, replay
                                                                  ledger: endpoint holds the lease
                                                                  ACME: ZeroSSL (EAB) → Let's Encrypt
                                                                  dns-01 TXT ──▶ dns-relay /v1/txt
   install cert + key            ◀── 200 {certPem, notAfter, ca} ─  cache (name, SPKI) until 2/3 lifetime
```

## What the relay holds

| Thing | Where | Protection |
|---|---|---|
| CA account keys (one per CA) | `AUTH_DATA_DIR/certs.json` `accounts` | AES-256-GCM under a subkey of the sealing root (`CERTS_KEY`, else `SECRETS_KEY`), AAD = the CA directory URL |
| In-flight orders | `certs.json` `orders` | public data (order URL, finalize URL, the CSR); a finalized order the CA is still processing, kept ≤ 1 h so the next ask resumes it |
| The platform EAB pair | `api-relay.env` `ACME_EAB_KID` / `ACME_EAB_HMAC` | host file permissions; no longer on any enclave |
| Issued certificates | `certs.json` `certs` | public data; cache keyed by `(name, sha256(SPKI))` |
| `CERTS_KEY` | `api-relay.env` | a **derived** key, `HMAC(SECRET, "enclave certs v1")`; the relay never holds the fleet `SECRET`. Optional: without it the relay cannot verify a fleet HMAC and refuses requests that carry one |
| `DNS_TXT_KEY` | `api-relay.env` | the derived TXT-push key the DNS daemon already checks |

Never: a certificate's private key, or the fleet `SECRET`.

## What it refuses (fail closed, before any CA is contacted)

The operator constraint is that this service may only ever issue for names in
the zones the platform owns. It is enforced by the route, in this order, and a
refusal never costs an issuance:

1. **Name** — must be exactly one label directly under `APP_ZONE` or `TCP_ZONE`,
   and the label must be a deployment id prefix (8–64 hex). A customer domain,
   `enclave.host`, `app.enclave.host` itself, `api.`/`www.`/`mcp.`, a
   second-level label, or a label like `box` is `403` (`not_platform_zone` /
   `bad_label`). `domains.js`'s `isReservedHostname` is the first cut: a name
   it does *not* reserve is somebody else's by definition.
2. **CSR** — parsed from the DER, not trusted from the caller: version 0; a
   subject that is exactly `CN=<name>`; a key that is EC P-256 or RSA ≥ 2048;
   exactly one attribute (`extensionRequest`) holding exactly one extension
   (`subjectAltName`) holding exactly one `dNSName == name`; a verifying
   self-signature. Anything else is `400 bad_csr`. The parser assumes hostile
   bytes: lengths are computed without shifts and checked against the bytes
   that remain before anything is sliced, minimal DER encoding is required,
   children must advance and fan-out/depth are capped, and nothing it hits can
   escape as anything but a 400. It runs before the signatures because both
   signed tuples name the key: `spkiHash = sha256(DER SubjectPublicKeyInfo)`,
   computed here, never taken from the caller.
3. **Fleet key (optional)** — `sig = HMAC-SHA256(hex-decode(CERTS_KEY),
   "<name>:<endpoint>:<spkiHash>:<ts>")`. Only a box whose `SECRET` is the real
   fleet secret sends one (`FLEET_SECRET_PRESENT` on the supervisor side); a
   seller box registered with only its operator key sends none — the operator
   signature and the lease are the authorization. A sig that is sent must
   verify (`401 bad_sig`). A relay without `CERTS_KEY` cannot check the factor
   at all: it does NOT refuse such requests (that would lock first-party boxes
   out of the platform account while their own CA path is the one failing);
   the operator signature and the lease authorize them alone, and the relay
   says so once per endpoint in its journal. `ts` within ±10 min (`422`).
   **Every** signature present is single-use — `opSig` always, `sig` when sent
   — so a captured request replays with neither factor dropped (`409`).
4. **Operator key** — `opSig` must be a personal_sign of
   `enclave-certs-issue:<name>:<endpoint>:<spkiHash>:<ts>` by the operator that
   registered `endpoint` in EnclaveRegistry. The fleet key proves only "a
   holder of the fleet key"; naming another box's endpoint needs that box's key
   (the `secrets.js` rule). Because the tuple names the key, a signature over
   one CSR does not open another CSR for the same name (`403 wrong_operator`).
   An unregistered endpoint has nobody to authorize it (`403`).
5. **Lease** — the ledger row the label names must have `runner ==
   keccak256(endpoint)` with `leaseUntil` in the future; a fresh re-read covers
   a claim newer than the 10 s ledger cache. An ambiguous prefix is no row
   (`403 not_found` / `not_lease_holder`).

Only then does an order start.

## Issuance, cache, pacing

* **CA slots, in order**: ZeroSSL (`https://acme.zerossl.com/v2/DV90`, with the
  EAB pair) then Let's Encrypt (`https://acme-v02.api.letsencrypt.org/directory`,
  no EAB). The failover rules are the supervisor's (`acmeIssue`, commit
  `6acb760f`): a CA-level failure (directory/nonce/account trouble, 5xx, HTML
  where problem+json belongs, a timeout, validation that never completes) cools
  the slot off for 2 minutes and falls over; a name-level refusal (rateLimited,
  an authz that became invalid) moves to the next CA without cooling; a CA that
  timed out this round gets one immediate second chance if a later CA reached
  its endpoints and refused only the name. Every HTTP call is bounded (20 s).
  One deliberate departure from the supervisor: a **finalized order the CA
  still reports `processing`** at the 90 s poll deadline is *not* a CA failure.
  The relay persists it (`orders`, keyed by `(name, spkiHash)`: CA, order URL,
  finalize URL, the CSR) and answers `202`; the next ask for the same key
  resumes polling that order (honouring `Retry-After`) instead of starting
  another one at the next CA — abandoning it orphaned a ZeroSSL certificate
  *and* spent a Let's Encrypt token from the zone's shared budget. Only
  `invalid` or a CA-level error falls over; a record older than 1 h is dropped.
* **Accounts** are registered once per CA (serialized behind one promise, so
  a burst of first asks cannot register twice and persist a mismatched
  kid/key) and kept. If the CA answers `accountDoesNotExist` — or
  `unauthorized`/`malformed` on `newOrder`, the first kid-bearing call — the
  persisted account is dropped, logged, re-registered once and the order
  retried; before that a dead account failed every name on its slot, silently.
* **dns-01** goes through the DNS daemon's authenticated `/v1/txt` with
  `DNS_TXT_KEY`, at `_acme-challenge.<name>`, and is deleted win or lose.
* **Cache**: `(name, sha256(SPKI))` → certificate, served with `cached: true`
  until two thirds of its lifetime; a re-ask with the same key costs no
  issuance. A new key for the same name replaces the record.
* **202**: a duplicate ask joins the running order; if the order outlives the
  request's wait (`CERTS_SYNC_WAIT_MS`, **8 s**) the reply is `202
  {retryAfterSec}` and the enclave's retry finds the cache, the running order,
  or a persisted one to resume. That wait is **coupled to the supervisor's
  `CERTS_HTTP_MS` (30 s)**: the relay must answer well inside the enclave's
  timeout, or the enclave aborts the POST, counts it as a CA failure and walks
  its in-enclave slots while the relay's order keeps running. The supervisor
  for its part stores the minted key in `pending` *before* the POST, so a
  timeout re-presents the same key and hits the cache / the in-flight order.
  `202` is also the answer while every CA is cooling off, while a name is in
  failure backoff (1 min doubling to 1 h), and when the caller's own bucket is
  empty. Outcomes are recorded inside the order's own promise, so a failure
  that lands *after* the `202` went out still counts: the next ask is answered
  from the backoff record, not with a fresh order.
* **Pacing**: per endpoint, a burst of 20 and 20/hour; per CA, ZeroSSL 60/hour
  and Let's Encrypt a burst of 25 refilling 40/week — under the 50/week the whole
  zone shares, so one renewal wave cannot spend the allowance.
* A name that no CA will issue is `502 issue_failed` with the CA's reason, then
  backoff.

## Restarts

The enclave keeps what it was issued. Every installed certificate is written,
**with its private key**, to `ACME_STORE_DIR` (`/var/lib/enclave/acme`, the
Tinfoil ramdisk: memory-backed, survives a container restart within one CVM
boot, gone on a CVM relaunch) as `<sha256(name)>.json`, alongside the ACME
account per CA (`accounts.json`) and the per-name per-CA rate-limit dates
(`ratelimits.json`). At boot `acmeRestore` reloads every unexpired record and
rebuilds its TLS context *before* the first reconcile, which then sees the name
as held and asks nobody for it (`[acme] restored N certificate(s) from
ACME_STORE_DIR`); the account is reused rather than re-registered (Let's
Encrypt also limits new registrations to 10 per IP per 3 h); and a CA that
answered `rateLimited` with "retry after <date>" is not asked for that name
before that date, though the other CAs still are. The store is a cache: a
persist failure never fails an issuance, and a record for a name no deployment
here claims is pruned at the next reconcile. The rule is the session key's and
the TLS bridge's — **memory-backed only, never host disk**: the supervisor
refuses any directory that is not under `/mnt/ramdisk` or `/dev/shm` or a
`tmpfs` per `statfs`, unless `ACME_STORE_ALLOW_DISK=1` says so explicitly
(metal/dev). This is what stopped 2026-08-27 from recurring: a release repoints
the fleet, every container restarts, and before the store every name was
re-issued from scratch — ZeroSSL hung for hours, Let's Encrypt's five
duplicates per name per week had gone on the day's restarts, and a box served
no certificate on any of its names. The platform slot benefits too: a
restored name is never re-asked, and the relay's `(name, SPKI)` cache is only
for the in-flight order the enclave's `pending` map re-presents.

## Configuring the API relay (nan)

Everything lives in `/etc/nan-relay/api-relay.env` (host state; `deploy.sh`
never writes it). The route answers `503 certs_disabled` until `DNS_API`,
`DNS_TXT_KEY`, `APP_ZONE`, one of `CERTS_KEY` / `SECRETS_KEY` (the at-rest
sealing root for the account blobs; `SECRETS_KEY` is already there for
`secrets.js`) and the `AUTH_DATA_DIR` activation switch are present. Without
`CERTS_KEY` the route runs for opSig-only (seller) requests and refuses any
request that carries a fleet HMAC — place `CERTS_KEY` before the first-party
fleet is repointed.

```
AUTH_DATA_DIR=/var/lib/enclave-relay        # already set for accounts/billing/secrets/domains
CERTS_KEY=<64 hex>                          # HMAC-SHA256(fleet SECRET, "enclave certs v1"); optional until first-party boxes send sig
DNS_API=http://127.0.0.1:8153               # the dns-relay push API (DNS_API_PORT, default 8153; same value the enclaves use)
DNS_TXT_KEY=<64 hex>                        # HMAC-SHA256(fleet SECRET, "enclave dns-txt v1") — the dns.env value
APP_ZONE=app.enclave.host
TCP_ZONE=tcp.enclave.host                   # optional
ACME_EAB_KID=...                            # the platform ZeroSSL pair: ONE-TIME placement, here and nowhere else
ACME_EAB_HMAC=...
ACME_CONTACT=ops@enclave.host
```

Derive `CERTS_KEY` on a box that holds the fleet `SECRET` (the same recipe as
`DNS_TXT_KEY` and `SECRETS_KEY`), then copy only the hex:

```
node -e 'console.log(require("node:crypto").createHmac("sha256", process.argv[1]).update("enclave certs v1").digest("hex"))' "$SECRET"
```

Then `systemctl restart enclave-api-relay` and look for
`[certs] enabled — zones ... ; CAs zerossl -> letsencrypt ... fleet factor
verified` in the journal (`fleet factor NOT CHECKED (CERTS_KEY unset …)` means
the sealing root is `SECRETS_KEY` and first-party boxes are authorized by
operator signature + lease only, without the fleet factor). The
first issuance registers each CA account (`[certs] zerossl: account registered
at ...`); after that the accounts are read from `certs.json`.

Once every enclave has moved to this route, the EAB pair can be **removed from
the fleet secrets and from `metal/config.json`** — that removal is the point of
the exercise, and it is a separate, deliberate step (enclave release first, then
the fleet repoint, then drop the secret).

## How this relates to `/internal/tls-ask`

`/internal/tls-ask` is Caddy's on-demand-TLS decision hook. For platform zones
it has been dead weight since the in-enclave client landed (Caddy no longer
mints those). It **stays** for the customer-domain flow, where it is the last
gate between a request and a certificate for a name we do not own: it answers
only from `domains.js`'s verified/active records and says no for our own zones
no matter what any record claims. `/v1/certs/issue` is the mirror image — it
says yes *only* for our own zones — and the two never overlap: a customer
hostname is `403` here, a platform hostname is `400`/`403` there.

| | `/internal/tls-ask` | `/v1/certs/issue` |
|---|---|---|
| names | customer-owned, verified in `domains.js` | `<label>.APP_ZONE` / `TCP_ZONE` only |
| caller | Caddy on the relay box (internal) | the lease-holding enclave |
| who runs ACME | the enclave (`supervisor.js`) | the relay (`certs.js`) |
| where the key is | the CVM | the CVM |
| CA credential | the enclave's own account (no EAB needed for a delegated customer name, or Let's Encrypt) | the platform account on the relay |

## Tests

`node --test test/certs.test.mjs` — two mock ACME servers (EAB-checking,
JWS-verifying, signing the caller's CSR with openssl) and a mock `DNS_API`;
never a real CA. Covers every refusal above, the DER checks (including the
crafted-length patterns that used to loop the parser), the key binding of both
tuples, replay with either factor dropped, the failover rules (5xx cool-off +
fallback, rateLimited → next CA, nonce timeout → second chance), a `processing`
order resumed on the next ask, a purged account re-registered once, serialized
first registration, a failure recorded after the `202`, a relay without
`CERTS_KEY`, the encrypted account record, the cache, and the 202 paths.
`test/acme.test.mjs` imports `issueSig` / `issueMessage` from `relay/certs.js`
so the supervisor's wire format is pinned against the relay's, byte for byte.
