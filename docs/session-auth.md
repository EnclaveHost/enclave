# Session authentication — why the token is asymmetric

## The problem it fixes

Login proves wallet ownership with a SIWE signature that the enclave verifies
cryptographically (`verifyMessage` in `supervisor.js`). That part is sound. The
issue was the *session token* minted after login.

It used to be an HS256 JWT keyed on the fleet `SECRET`:

```js
// OLD — forgeable by the operator
token = SignJWT({}).setSubject(claimed).sign(SECRET)   // HS256
jwtVerify(token, SECRET)                               // same symmetric key verifies
```

With HS256 the **minting key equals the verifying key equals a value the operator
provisions**. `SECRET` is a bare Tinfoil secret injected at runtime (not baked
into the measured image) and is the same value fleet-wide. So a human operator
holds it, and anyone holding it can mint a valid token for **any** wallet —
`setSubject(anyone).sign(SECRET)` — without ever touching the SIWE signature
check. The signature only gated *issuance*; the token itself was a bare MAC.

That let the operator clear exactly the application-layer access control the
token enforces: list a wallet's deployments, pull an app's stdout/stderr logs,
and hit the data path of a deployment marked `private`. It did **not** break the
hardware guarantees (RAM/VRAM confidentiality, in-enclave-terminated TLS) — but
it sat in direct tension with "Don't trust the operator. Measure it.": your
*identity* to the service rested on a secret the operator picked.

## The fix: sign in-enclave, verify with the public half

The session token is now **ES256**, signed by an EC P-256 private key that is
**minted inside the CVM at boot** (`initSessionKey` in `supervisor.js`), exactly
like the TLS-bridge key. The private half never leaves the enclave, so the
operator — who still holds `SECRET` — cannot mint a session token. The public
half is published so anyone can verify a token (and confirm the operator did not
mint it) while holding no secret:

- `GET /v1/session-jwks` — the public verification key as a JWKS.
- `GET /v1/attestation` — carries a `sessionKey` object binding that key to the
  attestation, so a client that trusts the attestation document trusts the key.

The private key is persisted to its **own tmpfs** (`SESSION_KEY_DIR`, default
`/mnt/ramdisk/enclave-session`, never host disk) so a container restart within a
CVM boot keeps sessions valid. A full relaunch mints a fresh key — at which point
the shim TLS pin also rotates and clients re-attest + re-login anyway.

### Why this is trustworthy

The root of trust is the **attestation measurement**, not any operator-held
secret. The measured, public, audited enclave code is what generates the key and
never exports the private half. Clients already pin the enclave's attested TLS
key after verifying the RAD (`pinTls(att.tlsKeyFingerprint)`); the session key is
published through that same attested channel.

### Alg-confusion is handled

`verifySessionToken` accepts **only** `ES256` verified against the EC public key,
with `algorithms: ['ES256']` pinned, so an attacker cannot get a token of any
other `alg` (e.g. an `HS256` token they hope will be verified against the EC
public key as an HMAC secret — the classic alg-confusion) accepted. There is no
`HS256`/`SECRET` verification path at all.

## The second carriage: opening a private app in a browser

A private deployment (`isPublic = false` on-chain) serves only its owner, and the
proof was a bearer header. A browser's **top-level navigation cannot send one**,
so clicking a link to your own private app answered a bare `401` JSON blob — the
app was reachable by `curl` and by the CLI, and not by the person who paid for it.

The fix adds a second *carriage* for the same owner check, never a second *rule*:
an `enclave_app` cookie on the app's own origin. `POST /v1/deployments/:id/app-token`
trades a session for it (owner-only), and the site's `/authorize` page drives the
round trip.

**Wallet code never runs at the app origin.** A tenant serves that origin, and the
supervisor already treats it as hostile — `tenantHeaders` kills WebAuthn there so
a hostile app cannot invoke `enclave.host`'s passkeys. A "connect your wallet"
page at `<label>.app.enclave.host` would both train users to sign on
tenant-controlled origins and hand every tenant a same-origin template to
imitate. So the enclave bounces a navigation to `enclave.host`, which holds the
wallet code and which no tenant can serve; the app origin only ever receives an
already-minted token, in a URL **fragment** (no server log, no `Referer`).

**The audience is the whole security boundary.** The app token is signed by the
same in-enclave key, with the same `iss`/`kid`, as a control-plane session — only
`aud = "app:<id>"` separates them. So:

- `verifySessionToken` rejects **any** token that carries an `aud`. Without that,
  a token sitting in a cookie on a tenant origin would also open
  `/v1/deployments`, `/logs` and `/secrets`.
- `verifyAppToken(token, id)` pins `audience` at verification, so a token minted
  for one deployment cannot open a sibling on the same enclave.
- Both sides compute the audience from the **resolved** `rec.id`, never the raw
  URL parameter — ids are addressable by 8-hex prefix, and a prefix-derived
  audience would not match a full-id one.

That crossing cannot be seen by reading either verifier alone, so
`test/private-app-auth.test.mjs` pins it from both directions.

The cookie is `HttpOnly; Secure; SameSite=Strict`, host-only (no `Domain=`, so it
never reaches `enclave.host`), and **stripped from the request before proxying**
alongside `Authorization` — the tenant must never read its owner's token out of
`Cookie` and replay it. TTL is 12h, against a session's 7 days.

`Strict`, not `Lax`, because a cookie is *ambient* where a bearer was not. Under
`Lax` any site could navigate an owner's browser into an authenticated GET on
their private app, and the tenant could not defend itself — we strip the cookie
before proxying, so the app has no signal to distinguish that request from any
other. Strict costs nothing here: the dashboard's "open" control points at
`/authorize`, so the only cross-site navigation in the flow carries its token in
a fragment and needs no cookie; address-bar hits and bookmarks are same-site.

Two consequences worth knowing:

- **Every value sent under the cookie name is tried, not the first.**
  `app.enclave.host` is not a public suffix, so a hostile tenant can set
  `enclave_app=junk; Domain=app.enclave.host` and have the browser deliver it to
  a *victim's* app origin, ordered ahead of the real host-only cookie. It can
  never verify for someone else's deployment — the audience forbids it — so this
  was only ever denial of access, but reading the first pair alone made that
  lockout permanent.
- **There is no revocation list.** The token is stateless with no `jti`, so a
  leaked cookie is live until `exp` or the next container relaunch (which mints
  a fresh signing key and invalidates everything). Ownership, by contrast, *is*
  re-checked on every request and at redemption, so a transfer cuts off the old
  owner immediately.

### What this changed about app-zone TLS

Private deployments now mint an app-zone certificate and are served over the
in-enclave TLS bridge like public ones. Both gates that refused them
(`/x/:id/https` and the ACME desired-set) predate any browser auth path, and the
`/https` refusal was redundant besides: that bridge terminates TLS in-enclave and
feeds the decrypted request into the **same** express app, so the WAF and the
owner gate judge it exactly as they judge every other request. Access is decided
once, at `/x/:id`, not twice. A certificate proves control of a *name*, never a
right to the content behind it — and the name is 8 hex of an id that is already
public on-chain, which `HEAD /x/<id>` has always confirmed to anyone.

## No legacy path

There was never a live session to migrate, so this shipped as a hard cut: the old
`HS256(SECRET)` mint/verify path was removed outright, not flagged off. The
operator-forgeability gap is closed the moment this release is live — there is no
`SESSION_ACCEPT_LEGACY` switch and no window in which a `SECRET`-signed token is
honored.

`SECRET` stays required: it still backs the manager control-token
(`VMMGR_TOKEN`) and the DNS-push HMAC seed. It just never signs or verifies a
session token.

## Cross-enclave sessions

Session tokens are deliberately fleet-wide (SIWE domain is `enclave.host`, the
relay can't verify them, and a deployment can migrate between enclaves). Each
token now carries `iss`/`kid` = the issuing enclave's key thumbprint.

**Today (pin-to-issuer, fail-closed):** an enclave verifies its own ES256 tokens
locally; a token whose `kid` is a *different* enclave's fails closed, and the
client re-runs SIWE against whichever enclave serves it. On the current
single-enclave fleet this never triggers — every token's issuer is the one
enclave — so behavior is unchanged. As more enclaves come online, a user whose
deployment lives on a different enclave than where they logged in re-signs once
(a wallet signature; `SESSION_TTL` makes it rare).

**Follow-on (transparent roaming, not yet implemented):** attestation-anchored
peer JWKS. An enclave verifying a foreign-`kid` token fetches that peer's
`/v1/session-jwks`, verifies the peer's Tinfoil RAD with the in-process
`@tinfoilsh/verifier` (measurement matches the official release), binds the key
to the attested endpoint, caches it, then verifies. This keeps the operator out
of the trust path (the pubkey is trusted because attestation proves the peer runs
the measured code, not because a registry entry or the relay said so) while
making fleet roaming transparent. It's additive and can land without changing the
token format above.

## Out of scope (and why)

- **`VMMGR_TOKEN` (= `SECRET`)** gates tenant→manager control calls on a loopback
  port *inside* the CVM. The operator cannot deliver traffic to that port (it's
  behind the confidentiality boundary), so operator knowledge of it is not a
  forgeability path. It defends against a malicious tenant app, not the operator.
- **`DNS_TXT_KEY` (= HMAC(`SECRET`, …))** authorizes TXT pushes; the operator
  controls DNS regardless. Not tenant-data access control.
- **`ADMIN_TOKEN`** is operator power by design (provisioning), not a tenant
  identity.
