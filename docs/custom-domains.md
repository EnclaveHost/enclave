# Custom domains — how a customer's hostname reaches their enclave

Customer-facing setup lives on the site (Develop → Guide → **14 Custom
domains**). This is the operator/maintainer half: what the pieces are, why the
certificate flow looks the way it does, and what to check when a domain will not
go live.

## The shape

```
                        ┌──────────────── relay box (untrusted) ─────────────┐
shop.example.com  ──────┤ relay.js: peek SNI, splice raw TLS bytes           │
     CNAME              │   hostname → deployment  (api-relay /v1/domains/map)│
cc1f4f3f.app.enclave.host   deployment → enclave    (on-chain lease)          │
                        └───────────────────────┬───────────────────────────┘
                                                │ /x/<id>/https (ciphertext)
                                    ┌───────────▼──────────────────────────┐
                                    │ supervisor.js, INSIDE the CVM        │
                                    │  · ACME (dns-01) mints the cert      │
                                    │  · TLS terminates here               │
                                    │  · guest gets ENCLAVE_HOSTS          │
                                    └──────────────────────────────────────┘
```

Nothing about a custom hostname is special once the ClientHello is routed: it
lands on the same `/x/<id>/https` bridge, terminated by the same in-enclave TLS,
as the deployment's own subdomain. The feature is really three questions
answered separately — *whose name is this*, *where does it route*, and *who may
mint a certificate for it* — and the value is in keeping them separate.

| Question | Answered by | Authority |
|---|---|---|
| Whose name is this? | `relay/domains.js` | owner's EIP-191 signature, checked against the ledger's `owner`, plus a TXT token in their zone |
| Where does it route? | `relay/relay.js` | hostname→deployment from the domain store; deployment→enclave from the on-chain lease |
| Who may mint a cert? | `/internal/tls-ask` + `desiredCertNames` | the record's status, which only DNS can advance |

The split is the point. A map cannot name an enclave and an enclave cannot name
a domain, so neither side alone can point a customer's hostname anywhere.

## Files

| File | Role |
|---|---|
| `relay/domains.js` | records, hostname validation, DNS verification sweep, owner API, lease-holder fetch, `tlsAskAllowed` |
| `relay/api-relay.js` | mounts `/v1/domains/*`, extends `/internal/tls-ask`, resolves a custom Host on the HTTP path |
| `relay/relay.js` | SNI routing for custom hostnames; the plaintext `:80` → https redirect |
| `supervisor.js` | pulls the names, mints certs (dns-01 via the delegated alias), `sniDecide`, `ENCLAVE_HOSTS`, the 421 Host check |
| `wasm/wasm_manager.py` | forwards `hosts` to the guest as `ENCLAVE_HOSTS` |
| `site/components/deployments/` | the dashboard Domains section |

## Why dns-01 with a delegated CNAME, and not tls-alpn-01

tls-alpn-01 is the obvious fit for an SNI-passthrough edge: the relay already
parses the ClientHello, so it could route an `acme-tls/1` handshake to a
challenge terminator in the CVM, and the customer would need one record fewer.

It is still the wrong choice here, for one reason:

**CVMs have no disk.** A key never touches host-backed storage — a key nobody
can exfiltrate. Issued certificates survive a *container* restart in the
memory-backed store (`ACME_STORE_DIR`, see `docs/platform-certs.md`
"Restarts"), but a CVM relaunch still re-mints every key and re-issues every
certificate. Only Let's Encrypt and Google Trust Services offer tls-alpn-01, and
both cap *duplicate* certificates (same exact name set) at **5 per week**. That
is why the platform runs on ZeroSSL, whose ACME has no such ceiling. A custom
domain on tls-alpn-01 would go dark partway through a bad week of relaunches,
and the customer would be looking at a refused handshake on *their* brand.

So custom domains ride the existing dns-01 path: the platform certificate
service first (`docs/platform-certs.md` — since 2026-09-02 it authorizes a
verified custom domain against its record and the deployment's lease, and
answers the challenge at the alias itself, under the platform's ZeroSSL
account), then the in-enclave CA slots as the fallback. The customer publishes:

```
_acme-challenge.shop.example.com.  CNAME  _acme-challenge.cc1f4f3f.app.enclave.host.
```

and `acmeChallengeName()` pushes the TXT at the far end of it, into the zone
`relay/dns-relay.js` already serves. CAs follow that CNAME as a matter of
course; the record is permanent and survives renewals untouched.

### Why the alias is the deployment's own challenge name

Not cosmetic. `dns-relay.js` authorizes an **operator-signed** TXT push at
`_acme-challenge.<label>.<zone>` exactly when `<label>` is a hex prefix of a
deployment the pusher holds the live on-chain lease for. Reusing that name means
a self-hosted seller box — which holds no fleet secret — can mint its tenants'
custom-domain certificates with the authority it already has. A per-domain alias
would have needed a new authorization rule over there.

Concurrent orders on one alias are fine: the challenge store keeps a *set* of
values per name (`MAX_TXT_VALUES = 8`) and a DELETE removes one value, not the
name.

## Status machine

```
        attach                DNS proves out              enclave reports a cert
  ─────────────────▶ pending_dns ─────────────▶ verified ─────────────────▶ active
                          │  ▲                     │  ▲                        │
     24 failed checks     │  │  5 consecutive failed checks (DEMOTE_STRIKES)   │
                          ▼  │                     │  └────────────────────────┘
                        failed└─────────────────────                issuance failed
```

* **verified** is what opens routing *and* certificate authorization. A verified
  name with no certificate yet fails closed at the enclave (`sniDecide` refuses
  it) rather than at the relay — one story for "unknown name", not two.
* **Demotion is deliberately slow.** DNS is not reliable enough to withdraw a
  customer's live routing on one bad answer, and an *indeterminate* lookup (our
  own resolvers unreachable) is not a strike at all.
* **failed** is not terminal — it is re-checked hourly, and a manual re-verify
  resets it immediately.

## Configuration

| Where | Variable | Notes |
|---|---|---|
| api-relay | `AUTH_DATA_DIR` | the shared activation switch; unset ⇒ 503 |
| api-relay | `SECRETS_KEY` | reused for the fleet-HMAC half of the enclave fetch (same party, same deployments — a second fleet key would be a second thing to rotate) |
| api-relay | `CUSTOM_DOMAINS=0` | explicit opt-out |
| api-relay | `DOMAIN_EDGE_IPS` | pins the addresses an apex must resolve to; default is **learned** by resolving our own app zone, so it survives an edge change |
| api-relay | `RESERVED_ZONES` | zones nobody may attach (default `enclave.host,nan.host`, plus every `APP_DOMAIN`) |
| relay.js | `DOMAINS_API` | api-relay origin to poll the routing map from; unset ⇒ custom domains do not route on that box |
| relay.js | `REDIRECT_HTTP_PORT` | plaintext port answering 301 (default 80; `0` disables) |
| supervisor | `DOMAINS_API` | defaults to `SECRETS_API` |

Both halves must be on before the dashboard offers the section: the relay's
`domainsEnabled()` AND every serving runner's `availability.customDomains`. The
fleet-AND is strict on purpose — a lease landing on a runner without the feature
would leave the customer's own domain refusing handshakes with nothing on the
dashboard to explain why.

## Rollout order

1. **Relay first.** `initDomains` + the routes are inert without runners; the
   fleet-AND keeps the dashboard section hidden.
2. **Enclave release**, then the fleet repoint. Runners begin advertising
   `customDomains: true` and pulling their names.
3. **`DOMAINS_API` on the SNI relay** (`/etc/nan-relay/tcp-relay.env`) + restart.
   Until this, a verified domain has a certificate but nothing routes its SNI.
4. The wasm-manager change is additive — an older manager ignores `hosts`, so
   the app simply does not get `ENCLAVE_HOSTS`. No skew risk.

## Diagnosing a domain that will not go live

```bash
# what the relay thinks — status, last error, CAA warning, the CA's own words
#   (needs the owner's signature; the dashboard is usually the faster path)

# does the map route it?
curl -s https://api.enclave.host/v1/domains/map | jq '.domains["shop.example.com"]'

# would we authorize a certificate for it? (loopback-only, on the relay box)
curl -si 'http://127.0.0.1:8080/internal/tls-ask?domain=shop.example.com' | head -1

# what the CA will see when it follows the delegation
dig +short _acme-challenge.shop.example.com CNAME
dig +short TXT $(dig +short _acme-challenge.shop.example.com CNAME)

# the customer's own records
dig +short shop.example.com
dig +short _enclave-challenge.shop.example.com TXT
dig +short shop.example.com CAA

# and the handshake itself — a REFUSAL here means no cert is held yet
openssl s_client -connect shop.example.com:443 -servername shop.example.com </dev/null 2>&1 | head -20
```

A refused handshake on a verified domain is the expected state while issuance is
in flight, exactly as it is for app-zone names after a release (see
`enclave-inenclave-app-tls`): the fail-closed rule means a pending certificate is
a hard refusal, not a warning page.

## Things deliberately not done

* **Wildcards.** They need dns-01 in the customer's own zone (or a second
  delegation), and the blast radius of a mis-attached wildcard is a whole zone
  rather than one name. Attach each hostname.
* **Certificates that outlive a CVM boot.** They outlive a *container* restart
  now (the tmpfs store, `ACME_STORE_DIR`; a custom domain's record is dropped
  the moment the domain is detached), but persisting across a relaunch would
  need sealing to something stable across releases, and the platform's answer
  to "where do we keep the key" is still *in memory* — re-issuance on relaunch
  is the cost of that, and ZeroSSL's lack of a duplicate ceiling is what makes
  it affordable.
* **Serving a name before its certificate exists.** See `sniDecide`: the bridge
  pair is a wildcard for our zone, so on a customer's hostname it is not merely
  unauthenticatable but plainly invalid.
