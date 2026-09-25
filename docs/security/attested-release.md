# Attested release of config and secrets to a per-app SNP guest

Contract v1.2 (v1.1 plus the relay's response signature). The relay side is `relay/secrets-release.mjs` (enclave-99); the guest side is enclave-5d's. The binding and the seal were reviewed by enclave-d1. It is OFF unless `SECRETS_ATTESTED_RELEASE` is set, and even then it answers `503 release_unconfigured` until every provider is wired (see "Not wired yet").

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
           (NO `nonce`: the ticket is bound in report_data, and a release report must never pass for an ordinary attestation)
→ 200 {id, sealed: base64, sig: base64(64 bytes), keyId}
```

**v1.2: every response is SIGNED by the relay.** The seal gives confidentiality but no origin: its key is public (the request carries it) and the host carries the ticket. So anyone able to terminate TLS as the relay (a mis-issued certificate) could seal a forged `{config, secrets}`, and a forged config carries an attacker's egress allowlist (enclave-5d).

```
digest = sha256("enclave-secrets-release-v1 response\n" ‖ id (raw 32) ‖ ticket (32) ‖ sealKey (32) ‖ sha256(sealed, the raw bytes))
sig    = Ed25519(the relay's release key, digest)        ← over the 32-byte DIGEST, not the preimage
keyId  = sha256(the raw 32-byte Ed25519 public key), hex, first 16 characters (a selector; the guest may also try each pinned key)
```

- The release key is relay-only: `SECRETS_RELEASE_SIGNING_KEY`, a 32-byte seed in hex. It is REQUIRED.
- Its public key is compiled into the measured front as a pinned SET, so rotation is possible. There is no key-fetch endpoint: pinning only, never trust on first use.
- The guest verifies `sig` BEFORE it opens the seal, and refuses on a missing or bad signature. A mis-issued certificate is then a DoS at worst.

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
- The TCB floor (`SECRETS_RELEASE_MIN_TCB`) and the VMPL pin (`SECRETS_RELEASE_VMPL`, the monitor's) are REQUIRED policy, passed to the verifier explicitly: a provider can't omit them.
- The guest-evidence verifier returns `verified`, given:
  - the measurement allowlist (`SECRETS_RELEASE_MEASUREMENTS`; fail-closed firmware only);
  - `expectedBinding` = the binding above, recomputed from the document's stated transport key and runtime and from the request's ticket and seal key;
  - `expectedAppId` = the relay's derivation;
  - `expectedHostData` = the deployment id;
  - `bindingDomain` = `enclave-secrets-release-v1`.
- Then the relay re-reads the verified report itself:
  - SIGNING_KEY = VCEK;
  - the guest POLICY's DEBUG bit (19) is clear, and VMPL = the pin;
  - `report_data` = the binding ‖ AppID;
  - HOST_DATA = id;
  - CHIP_ID non-zero, and ∈ the ticket's chips.
- The response is the deployment's config plus its secrets, sealed.
  - The config follows the supervisor's precedence (`overrideConfigFields`): the envelope's `config`, else the envelope's `configCid`, else the catalog VERSION's config, else the version's `configCid`. It is null only when none of them names one.
  - `config` is the config's JSON VALUE (an object or array). The guest's `ENCLAVE_CONFIG` is its compact serialization.
  - Text fetched by CID, or a version's config text, is parsed here. A value that is itself a JSON string, or anything that isn't an object or array, is refused (422 `bad_config`), never passed on.
  - An unresolvable CID gives 503, never a partial answer.

```
plaintext = JSON {id, envelopeSha256, config, secrets, issuedAt}      (config: a JSON value or null; issuedAt: an ISO-8601 UTC string)
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

Chips accumulate across in-place re-attaches under the same transport key while the previous record is still registered (`snpChipsAfter`), so a multi-socket box's other chip doesn't produce a false refusal. A new key starts over, and a detach deletes the record. SNP boxes attaching through the hub mint their transport key per boot inside the CVM, so a chip set never outlives the boot that proved it. The chips are internal to the hub and never appear in `/enclaves`.

CHIP_ID binds the **physical chip, not the endpoint**: two registered endpoints on one machine are indistinguishable. That is acceptable only when they share an operator.

## Preconditions before `SECRETS_ATTESTED_RELEASE` may be turned on (enclave-d1)

- The policy: `SECRETS_RELEASE_MIN_TCB`, `SECRETS_RELEASE_VMPL`, and a measurement allowlist holding reviewed, non-debug per-app guest images only.
- Scope: this release serves **M2-path** per-app guests only. They have no SVSM, and the front reads its report through configfs-tsm at VMPL0, so `SECRETS_RELEASE_VMPL=0` (enclave-5d, from source).
  - When M4b becomes a per-app path, the VMPL becomes per measurement: allowlist entries of the form `<measurement>@<vmpl>`, so each image is judged at its own level.
  - Re-check the guest POLICY value (0x30000: DEBUG off) against `run-domain.sh` at deploy time; the relay refuses DEBUG regardless.
- The guest side landed and reviewed (enclave-5d):
  - the boot check that the served deployment id equals HOST_DATA;
  - the release client as measured platform code, with [32:64] filled by the monitor;
  - the enumeration of every report path;
  - the guest validating the relay's TLS;
  - the release document stating no `nonce`.
- `SECRETS_RELEASE_SIGNING_KEY` set, and its public key pinned in the measured front.
- Every provider below, wired and reviewed.

Rate: a ticket request is limited per client IP. A release is limited per its ticket's ENDPOINT, looked up without being consumed, so many guests behind one host address don't share one bucket. An unknown ticket is limited per IP.

## Not wired yet (the release answers 503 until these land)

- `verifyGuestEvidence`: the relay's vendored verifier (`relay/vendor/enclave-verifier-node.mjs`) exports the consumer API only. It needs a rebuild that also exports the domain-path `verifyEvidence`, with a `bindingDomain` field in the verdict, and KDS collateral fetched by CHIP_ID (the guest's `certs` are optional).
- `runtimeIdOf`: `isolation/contract/runtime.mjs` `runtimeId`, bundled for the relay.
- `appIdFor`: the DERIVE.md derivation for the deployment's catalog version and shares, over component bytes fetched by CID and CAR-verified, cached per version.
- `resolveConfigCid`: a `configCid`, fetched and checked against its CID (returning text or a value; the relay parses it).
- `versionConfigFor`: the catalog version's `{config, configCid}` for the deployment's version.
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
- `test/fixtures/secrets-release-guest-vectors.json`: enclave-5d's guest vectors (isolation/app-config-m1 0e9a6f08). This side reproduces their binding and seal and opens their blob, and theirs does the same with this side's.
- Mutations of the checks, all caught (counted in the commit messages).
