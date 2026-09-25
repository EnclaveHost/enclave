# Attested release of config and secrets to a per-app SNP guest

Contract v1.1. The relay side is `relay/secrets-release.mjs` (enclave-99); the guest side is enclave-5d's. The binding and the seal were reviewed by enclave-d1. It is OFF unless `SECRETS_ATTESTED_RELEASE` is set, and even then it answers `503 release_unconfigured` until every provider is wired (see "Not wired yet").

## Why

On the per-app isolation tier each app runs in its own SEV-SNP guest, and the app manager (guestd) runs on the HOST. `/v1/secrets/fetch` releases to the lease holder's supervisor, and anything the supervisor then hands the guest crosses the host in plaintext. So the deployed supervisor refuses app config and staged secrets on that tier.

This release goes to the guest itself, sealed to a key only that guest holds, after the relay has verified:
- the guest's attestation;
- the deployment;
- the app;
- the lease holder;
- the lease holder's physical chip.

## The two calls

**1. Ticket: the lease holder's supervisor** (control CVM, holds the registry operator key)

```
POST /v1/secrets/release-ticket  {id, endpoint, ts, opSig}
opSig = personal_sign(registry operator of endpoint, "enclave-secrets-release-ticket:<id>:<endpoint>:<ts>")
→ 200 {ticket: base64(32 random bytes), expiresAt}        (TTL 120 s, one use)
```

The relay requires all of the following:
- `ts` within ±300 s, and the signature used once;
- the signer is the endpoint's registered operator;
- the endpoint holds the deployment's LIVE lease, and the relay holds it eligible (U7);
- the lease holder's SNP tunnel has PROVED at least one CHIP_ID (below).

The ticket records the lease holder and its chips. The host carries the ticket to the guest; that is harmless, because the binding below makes it useless to anyone but the right guest.

**2. Release: the guest, over its OWN TLS to the relay** (a pinned single-destination path; the guest validates the relay's certificate)

```
POST /v1/secrets/release  {id, ticket, sealKey: base64(X25519 public, 32), evidence}
evidence = {format: "sev-snp-guest-domain-v1", abi: "enclave-domain-abi/2", runtime, transportKey, report[, certs]}
→ 200 {id, sealed: base64}
```

## The binding (report_data)

```
report_data[0:32]  = sha256("enclave-secrets-release-v1\n" ‖ id ‖ sha256(transportSpki) ‖ ticket ‖ runtimeId ‖ sealKey)
report_data[32:64] = AppID          (filled by the monitor, never by the release client)
```

- Every field after the domain line is a fixed 32 bytes: `id` is the raw bytes32, and the SPKI is hashed (the guest's TLS key is P-256, 91 bytes).
- It has its OWN domain. The guest's public attestation endpoint signs Bind2 (`"enclave-bind-v2\n" ‖ spki ‖ nonce ‖ runtimeId`) over ANY caller nonce, and the host sees the ticket, so Bind2 over the ticket would be an oracle. Neither preimage can produce the other: Bind2's starts with a DER SPKI (`0x30…`), this one with the domain line.
- The deployment id is inside the binding, and HOST_DATA must equal it. AppID names an APP, so without this a lease holder hosting two tenants of one app could route A's ticket into B's guest (enclave-d1's confused deputy). The guest must refuse to boot unless the deployment it serves matches HOST_DATA.

## What the relay checks at release (all fail-closed)

- The ticket exists, is unexpired and was issued for this `id`. It is **consumed on first presentation, whatever the verdict**. A burned ticket is DoS only, and it is logged.
- The lease is still held by the ticket's endpoint, and the relay still holds that endpoint eligible.
- The runtime id is in the admitted set (`SECRETS_RELEASE_RUNTIME_IDS`).
- The guest-evidence verifier returns `verified`, given:
  - the measurement allowlist (`SECRETS_RELEASE_MEASUREMENTS`; fail-closed firmware only);
  - `expectedBinding` = the binding above, recomputed from the document's stated transport key and runtime and from the request's ticket and seal key;
  - `expectedAppId` = the relay's derivation;
  - `expectedHostData` = the deployment id;
  - `bindingDomain` = `enclave-secrets-release-v1`.
- Then the relay re-reads the verified report itself:
  - SIGNING_KEY = VCEK;
  - `report_data` = the binding ‖ AppID;
  - HOST_DATA = id;
  - CHIP_ID non-zero, and ∈ the ticket's chips.
- The response is the ledger envelope's config (its inline `config`, or its `configCid` resolved by the relay; unresolvable means 503, never a partial answer) plus the deployment's secrets, sealed:

```
plaintext = JSON {id, envelopeSha256, config, secrets, issuedAt}
key    = HKDF-SHA256(ikm = X25519(eph, sealKey), salt = ticket,
                     info = "enclave-secrets-release-v1 seal\n" ‖ id ‖ ephPub ‖ sealKey), 32 bytes
sealed = ephPub(32) ‖ iv(12) ‖ AES-256-GCM(plaintext) ‖ tag(16)      (fresh eph and iv every time)
```

An all-zero X25519 shared secret (a low-order `sealKey`) is refused. Placeholder substitution (`$NAME`, `${NAME}`) is the guest's job. `test/fixtures/secrets-release-vectors.json` holds a vector of inputs, binding and sealed blob for the guest implementation to match.

## The lease holder's chip

The tunnel hub keeps a CHIP_ID from an SNP attach **only** in this case (`provenSnpChip`):
- the attach verified the report's signature against the chip's own VCEK (`vcekVerified`);
- the report says it is VCEK-signed;
- the CHIP_ID is not zero.

A measurement-only attach (`requireVcek` false) proves no chip, so its lease holder gets no ticket.

Chips accumulate across in-place re-attaches under the same transport key, so a multi-socket box's other chip doesn't produce a false refusal. A new key starts over. The chips are internal to the hub and never appear in `/enclaves`.

CHIP_ID binds the **physical chip, not the endpoint**: two registered endpoints on one machine are indistinguishable. That is acceptable only when they share an operator.

## Not wired yet (the release answers 503 until these land)

- `verifyGuestEvidence`: the relay's vendored verifier (`relay/vendor/enclave-verifier-node.mjs`) exports the consumer API only. It needs a rebuild that also exports the domain-path `verifyEvidence`, with a `bindingDomain` field in the verdict, and KDS collateral fetched by CHIP_ID (the guest's `certs` are optional).
- `runtimeIdOf`: `isolation/contract/runtime.mjs` `runtimeId`, bundled for the relay.
- `appIdFor`: the DERIVE.md derivation for the deployment's catalog version and shares, over component bytes fetched by CID and CAR-verified, cached per version.
- `resolveConfigCid`: the inner `configCid`, fetched and checked against its CID.
- Config: `SECRETS_ATTESTED_RELEASE`, `SECRETS_RELEASE_MEASUREMENTS`, `SECRETS_RELEASE_RUNTIME_IDS`.
- Rollout condition: the lease holder must attach with VCEK verification (`METAL_REQUIRE_VCEK`), or it proves no chip.

## Tests

- `test/secrets-release.test.mjs` exercises the real `verifyEvidence` against synthetic reports from a synthetic AMD-shaped chain:
  - the vectors, and the RFC 7748 §6.1 exchange through the key wrappers;
  - the seal's bindings, tamper and low-order refusals;
  - the binding's layout and its separation from Bind2;
  - the end-to-end flow with inline and CID-resolved config.
- Refusals, each releasing nothing and consuming the ticket:
  - A's ticket in B's guest;
  - Bind2 over the ticket;
  - another app;
  - an unadmitted runtime;
  - a report not over the seal key;
  - a VLEK-signed report;
  - a moved lease;
  - an ineligible holder;
  - a ticket for another deployment;
  - an unlisted measurement;
  - a low-order seal key.
- More refusals:
  - a chip mismatch;
  - OFF, missing policy or missing providers answer 503;
  - an expired ticket;
  - an unresolvable configCid.
- The relay's own checks are exercised under a verifier stub that passes everything.
- `test/tunnel.test.mjs`: a measurement-only attach proves no chip, and chip ids never reach a row.
- 13 mutations of the checks, all caught.
