# Enclave control services

Nan hosts the control API, fleet discovery, attestation, certificate coordination,
accounts and billing. The authoritative DNS service runs separately on nan-relay.
Application traffic uses [TUNA](../network/README.md); Enclave's public SNI, TCP,
UDP and egress relay daemons have been removed. The historical directory and
service names remain for operational continuity.

Guest TLS keys remain in the application guest. The host adapter routes encrypted
connections from a TUNA provider to the existing local tenant ingress. The fleet
tunnel in `tunnel.js` carries control requests only. `/x/...` and application
WebSocket connections on the control API return HTTP 410.

## Control API

Run `REGISTRY_ADDRESS=0x... node api-relay.js`, or use `ENCLAVES` for a static fleet.
`API_RELAY_BIND=127.0.0.1` and a local TLS reverse proxy are the production layout.
`TRUSTED_OPERATORS` restricts registry discovery; attestation and live leases
separately determine whether a host may serve a deployment. `TRUSTED_PROXY`
controls forwarded-header trust and `CORS_ORIGINS` lists authorized browser origins.

| Route | Purpose |
|---|---|
| `/enclaves`, `/availability`, `/route` | Fleet evidence, capacity and placement |
| `/v1/deployments`, `/v1/deployments/:id/...` | Ledger reads and authorized host control |
| `/v1/fleet-tunnel` | Host attachment and control request transport |
| `GET /v1/network/tuna` | Unexpired provider allocations for eligible lease holders |
| `POST /v1/network/tuna` | Registered operator's signed allocation publication |
| `GET /v1/relays` | Compatibility alias for the TUNA map; `relays` is empty |
| `/v1/auth/*` | Enclave-issued authentication, pinned to the serving host |
| `/v1/sessions/*` | Wallet sessions: relayer, keeper and index for SessionVaults (`sessions.mjs`, its own hot key `SESSIONS_RELAYER_KEY`; [design](../docs/design/sessions.md), §15-16) |
| `/health` | Control API and fleet freshness |
| `/mcp` | Platform tools for coding agents |

The control API terminates its own TLS and sees control request bodies. Application
TLS goes through the TUNA path and is verified against guest attestation.

## DNS and deployment

`dns-relay.js` answers application A/AAAA and raw-port SRV records from
`TUNA_MAP_URL` (default `https://api.enclave.host/v1/network/tuna`). Missing or
expired allocations produce no address, with no fallback to old relay IPs.
DNS-01 TXT challenges and box control names remain supported. See the file's
configuration comments and [TUNA operations](../network/README.md).

`deploy.sh` ships the API to Nan and DNS to `DNS_HOST` (default nan-relay). It
requires a successful TUNA cutover preflight before updating the service files.
Host configuration and secret-bearing environment files are not overwritten.
Deploy host adapters separately, fund their native NKN wallets, verify every
running app through its provider, then change DNS and retire old data services.

### Platform certificates (`certs.js`)

`POST /v1/certs/issue` — a lease-holding enclave trades a **CSR** for a CA
certificate on its deployment's own hostname (`<label>.app.enclave.host`, and
`<label>.tcp.enclave.host` when `TCP_ZONE` is set). The private key is
generated in the CVM and never leaves it; the relay sees the CSR and the
certificate only, and signs nothing itself. What moves to the relay is the
**CA account**: the ZeroSSL EAB pair stops being a fleet-wide secret on every
box, one account per CA is registered once and kept encrypted in
`AUTH_DATA_DIR/certs.json`, and the relay paces the shared CA rate limits that
no single enclave can see. Full design: [`docs/platform-certs.md`](../docs/platform-certs.md).

- **Refuses every name it cannot vouch for** — an apex, `api.`/`www.`/`mcp.`,
  a second-level label, a label that is not a deployment id prefix, a hostname
  outside our zones with no verified `domains.js` record — before any key or
  ledger work. A **verified custom domain** is issued for its deployment's
  lease holder (the dns-01 answer goes to the delegated alias in our zone);
  `/internal/tls-ask` stays as the routing-side gate (see `domains.js`).
- **Auth** = `opSig` (required: a personal_sign of
  `enclave-certs-issue:<name>:<endpoint>:<spkiHash>:<ts>` by the endpoint's
  registered EnclaveRegistry operator) + optional `sig` =
  `HMAC-SHA256(hex-decode(CERTS_KEY), "<name>:<endpoint>:<spkiHash>:<ts>")`,
  sent only by a box whose SECRET is the real fleet secret and verified
  whenever the relay holds `CERTS_KEY` (a wrong one is 401, never ignored);
  a relay without `CERTS_KEY` cannot check it and authorizes by `opSig` +
  lease alone, saying so once per endpoint in its journal.
  `spkiHash` = sha256 of the CSR key's DER SubjectPublicKeyInfo, computed by
  the relay from the CSR it parsed: the tuples authorize a name **for a key**.
  Every signature present is single-use (409 on replay), `ts` ±10 min, then
  the ledger must show `endpoint` holding the deployment's **live lease**
  (`secrets.js` rule, shared via `fleet-auth.js`).
- **CSR** is validated from the DER: exactly `CN == name` and one SAN
  `dNSName == name`, EC P-256 or RSA ≥ 2048, no other attribute or extension,
  verifying self-signature. A CSR for any other name is a 400.
- **Replies**: `200 {name, certPem, notBefore, notAfter, ca, cached}`;
  `202 {name, retryAfterSec}` while the order runs (the request waits
  `CERTS_SYNC_WAIT_MS`, 8 s — under the supervisor's 30 s `CERTS_HTTP_MS`),
  while a CA is still processing a finalized order (persisted and resumed on
  the next ask, never abandoned for the next CA), while the CAs are cooling
  off, or while the caller is paced; `4xx {error, message}`; `503 certs_disabled`.
- **CAs**: ZeroSSL (`ACME_EAB_KID`/`ACME_EAB_HMAC`, the platform pair) first,
  Let's Encrypt as the fallback — the supervisor's failover rules (CA-level
  failure cools a slot 2 min, name-level refusal moves on, second chance for
  a CA that timed out while the other proved the network). dns-01 is answered
  through the DNS daemon's `/v1/txt` with `DNS_TXT_KEY`.
- **Env** (`/etc/nan-relay/api-relay.env`; `DNS_API`, `DNS_TXT_KEY`,
  `APP_ZONE` and one of `CERTS_KEY` / `SECRETS_KEY` required, else the route
  answers 503):

  | variable | |
  |---|---|
  | `CERTS_KEY` | 64-hex, `HMAC-SHA256(fleet SECRET, "enclave certs v1")` — derived on a box that has `SECRET`; the relay never holds `SECRET`. OPTIONAL: without it sig-bearing (first-party) requests are refused and only opSig-only requests issue; the account store is then sealed under `SECRETS_KEY` |
  | `DNS_API`, `DNS_TXT_KEY` | the DNS daemon's push API and its derived key (same values the enclaves use) |
  | `APP_ZONE` | `app.enclave.host`; `TCP_ZONE` optional |
  | `ACME_EAB_KID`, `ACME_EAB_HMAC` | the platform ZeroSSL pair (one-time placement here; without it the ZeroSSL slot is skipped) |
  | `ACME_CONTACT` | account contact (bare address gets `mailto:`) |
  | `ACME_DIRECTORY`, `ACME_DIRECTORY_2` | directory overrides for the two slots (tests point them at mocks) |
  | `AUTH_DATA_DIR` | the shared activation switch: accounts + cert cache live in `certs.json` there |

  Deriving the key on a box that holds `SECRET`:
  `node -e 'console.log(require("node:crypto").createHmac("sha256", process.argv[1]).update("enclave certs v1").digest("hex"))' "$SECRET"`.
  `deploy.sh` never touches the env file (host state); add the keys and restart
  `enclave-api-relay`.

### MCP server (`mcp.js`)

The coding-agent front door, served from the same process: MCP over Streamable
HTTP (stateless JSON-RPC over POST), dispatched by Host (`MCP_DOMAIN`, default
`mcp.enclave.host`) and by path (`/mcp` on the API host). The app-subdomain
branch runs first, so a tenant app's own `/mcp` path is never shadowed.

- **~25 tools covering the full platform surface**: guides, pricing /
  availability / GPU capacity, the on-chain app catalog (`list_apps`,
  `get_app`), deployments (list/get/logs/restart/attestation), SIWE sign-in
  (`auth_nonce`/`auth_login`), signed uploads (`upload_token`), claim hints,
  and transaction builders (`plan_deploy`, `build_fund`, `build_stop`,
  `build_resume`, `build_upgrade`, `build_publish`).
- **No keys, ever** — the relay's standing invariant extends to MCP. Builders
  validate against live chain state (approval gates, share minimums, the GPU
  cap, publisher-fee snapshots — the CLI's own checks) and return **unsigned**
  Base transactions `{chainId, to, data, value}`; the agent signs with the
  user's wallet. Signature flows (SIWE, upload tokens) take locally produced
  signatures. Session tokens ride per-call `token` params or the Authorization
  header and stay enclave-verified upstream.
- **Wallet sessions** (`docs/design/sessions.md`): `session_request` returns the
  grant link for an agent's P-256 key, `session_status` reads an owner's vault,
  sessions and delegation, `build_delegate` returns the owner's unsigned
  `setDelegate` transaction, and `session_end` signs a session out. Given
  `session: {vault, sid}`, the builders return `calls`, each with a digest for
  the agent's key to sign (P-256 over SHA-256 of the digest), instead of wallet
  transactions, and `session_execute` sends the signed calls through the
  sessions relayer. Still no keys on the server.
- Read tools self-loop through this relay's own gateway (loopback), so they
  return exactly what external clients see; catalog/ledger reads use
  `BASE_RPC` behind the same address-book repointing as everything else.
- The canonical endpoint is the bare host: `https://mcp.enclave.host` (any
  path on that Host serves MCP). Serving it needs a Caddy site block on the
  fronting box (`reverse_proxy 127.0.0.1:8100`, same as the API host) and a
  DNS record pointing at it; `/mcp` on the API host is a path-dispatched
  alias that works with no extra config.
- Connect: `claude mcp add --transport http enclave https://mcp.enclave.host`
