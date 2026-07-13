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
