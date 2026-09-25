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
- The guest recomputes the digest from its OWN `id`, ticket and seal key, never from response fields.
- The guest trusts only its PINNED keys. `keyId` may select one, but only if it names exactly one pinned key; otherwise the guest tries each pinned key. A key offered by the response is never used.
- The signature covers `sha256(sealed)` (ephPub ‖ iv ‖ ciphertext ‖ tag), so with GCM it binds the plaintext exactly. The one-use ticket and the per-request seal key make an old signed response unreplayable for another request (enclave-d1).

## The binding (report_data)

```
report_data[0:32]  = sha256("enclave-secrets-release-v1\n" ‖ id ‖ sha256(transportSpki) ‖ ticket ‖ runtimeId ‖ sealKey)
report_data[32:64] = AppID          (filled by the monitor, never by the release client)
```

- Every field after the domain line is a fixed 32 bytes: `id` is the raw bytes32, and the SPKI is hashed (the guest's TLS key is P-256, 91 bytes).
- It has its OWN domain. The guest's public attestation endpoint signs Bind2 (`"enclave-bind-v2\n" ‖ spki ‖ nonce ‖ runtimeId`) over ANY caller nonce, and the host sees the ticket, so Bind2 over the ticket would be an oracle. Neither preimage can produce the other: Bind2's starts with a DER SPKI (`0x30…`), this one with the domain line.
- The deployment id is inside the binding, and HOST_DATA must equal it. AppID names an APP, so without this a lease holder hosting two tenants of one app could route A's ticket into B's guest (enclave-d1's confused deputy). The guest must refuse to boot unless the deployment it serves matches HOST_DATA.

## What the relay checks at release (all fail-closed)

- The ticket exists, is unexpired and was issued for this `id`. It is **consumed on first presentation, whatever the verdict**, with ONE exception (enclave-d1): when the relay itself cannot answer yet (a 503: `warming`, `busy`, `prediction_unavailable`, `component_unavailable`, `catalog_unreachable`, `prediction_failed`, `predictor_unconfigured`, `ledger_unconfirmed`, `config_unresolvable`, `collateral_unavailable`), the ticket is KEPT and the guest retries with the same ticket and evidence within the TTL. Those answers depend only on the deployment's record, never on the ticket or the evidence, so answering them first is no oracle (the config is resolved before the ticket is consumed and released only after the evidence verifies). Budget: the guest's attempt times out at 25 s; the relay spends at most one agreed record read (6 s per provider, the ledger address cached 10 min), the 10 s prediction wait, and the verifier. A burned ticket is DoS only, and it is logged.
- The lease is still held by the ticket's endpoint, and the relay still holds that endpoint eligible. The record this rests on (runner, lease, `appRef`, `isPublic`, `configCid`) is re-read by id through two or more AGREEING RPCs (`confirmRow`, `SECRETS_RELEASE_CATALOG_RPCS`); a disagreement or an unreachable provider is `503 ledger_unconfirmed`.
- The deployment is enabled for release (`SECRETS_RELEASE_DEPLOYMENTS`: `*`, or a list of ids for a staged rollout). An unlisted id gets neither a ticket nor a release (403 `release_not_enabled`).
- The relay has a PREDICTION for the deployment's catalog version (see "Measurements: predicted"): the AppID, and per admitted domain release a (runtime id, measurement) pair. No prediction is a refusal: 503 when the relay cannot predict now (`busy`, `prediction_unavailable`, `component_unavailable`, `catalog_unreachable`, `prediction_failed`, `predictor_unconfigured`), 403 when the version cannot have one (`version_not_admitted`, `underivable`, `not_catalog`).
- The runtime the guest states is an admitted release's runtime (403 `runtime_not_admitted` otherwise), and only THAT release's measurements are allowed for it: a runtime and a measurement are admitted as one pair.
- The TCB floor (`SECRETS_RELEASE_MIN_TCB`) and the VMPL pin (`SECRETS_RELEASE_VMPL`, the monitor's) are REQUIRED policy, passed to the verifier explicitly: a provider can't omit them.
- The guest-evidence verifier returns `verified`, given:
  - `allowedMeasurements` = the predicted measurements for the guest's runtime (never a value the host or the guest stated);
  - `expectedBinding` = the binding above, recomputed from the document's stated transport key and runtime and from the request's ticket and seal key;
  - `expectedAppId` = the predicted AppID;
  - `expectedHostData` = the deployment id;
  - `bindingDomain` = `enclave-secrets-release-v1`.
- Then the relay re-reads the verified report itself:
  - SIGNING_KEY = VCEK;
  - the guest POLICY's DEBUG bit (19) is clear, and VMPL = the pin;
  - the MEASUREMENT is one of the predicted ones for the guest's runtime;
  - `report_data` = the binding ‖ AppID;
  - HOST_DATA = id;
  - CHIP_ID non-zero, and ∈ the ticket's chips.
- The response is the deployment's config plus its secrets, sealed.
  - The config is what the tier delivers today: the supervisor's split (`overrideConfigFields`: the options envelope decides when it names `config` or `configCid`, else the catalog VERSION does) and, within that source, the manager's rule (`wasm_manager.py`: "if both arrive the CID wins and the inline field is ignored"; beside a CID the inline field is only the routing manifest). So: the envelope's `configCid`, else its `config`; else the version's `configCid`, else its inline `config`. It is null only when neither source names one. (Corrected 2026-09-25: the earlier text put an inline field before its CID, which on a rev-7 large-config version would have released the routing manifest as the app's config.)
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

- The policy: `SECRETS_RELEASE_MIN_TCB`, `SECRETS_RELEASE_VMPL`, `SECRETS_RELEASE_DEPLOYMENTS`, and the predictor's pins: a reviewed toolchain commit and reviewed, non-debug domain releases with fail-closed firmware only (`SECRETS_RELEASE_DOMAIN_RELEASES`), its known-answer test passing on the relay host.
- Scope: this release serves the per-app guests guestd builds (M4a image assembly; AppID = the DERIVE.md bundle id) running the **M2 runtime shape**: dominit plus the front, with no SVSM, and a report read through configfs-tsm at VMPL0. So `SECRETS_RELEASE_VMPL=0` (enclave-5d, from source).
  - When M4b becomes a per-app path, the VMPL becomes per measurement: allowlist entries of the form `<measurement>@<vmpl>`, so each image is judged at its own level.
  - Re-check the guest POLICY value (0x30000: DEBUG off) against `run-domain.sh` at deploy time; the relay refuses DEBUG regardless.
- The guest side landed and reviewed (enclave-5d):
  - the boot check that the served deployment id equals HOST_DATA;
  - the release client as measured platform code, with [32:64] filled by the monitor;
  - the enumeration of every report path;
  - the guest validating the relay's TLS;
  - the release document stating no `nonce`.
- `SECRETS_RELEASE_SIGNING_KEY` set, and its public key pinned in the measured front. Custody (enclave-d1):
  - generated ON the api-relay host (nan), never copied through a workstation;
  - kept in its OWN file and given to the relay as `SECRETS_RELEASE_SIGNING_KEY_FILE` (preferred over the inline
    `SECRETS_RELEASE_SIGNING_KEY`, so the seed is never copied into the env file or any backup of it; setting both is
    refused). The file is one line of 64 hex (an Ed25519 seed), a regular file with no group or other permission bits,
    owned by the relay's user or root; anything else is refused. The public key is the raw 32-byte Ed25519 key, and the
    key id the relay puts in each response is the first 16 hex of its sha256 (check vector: seed 0x66 repeated gives
    public key 34b4d904…a746, key id f7b7676c94df7e8f);
  - a key of its own, distinct from `RELAY_TXT_KEY`, `DNS_TXT_KEY`, `SECRETS_KEY` and `CERTS_KEY`. The relay refuses a seed equal to any of them.
  - **The production key (S3b, enclave-63, 2026-09-25 18:38:21Z on nan):** public key
    `d6c8a95966710fb52f4f753458362869ee26cf84aee08d27900c53a5b3fcc81d`, sha256 `06212e5d…8b97`, key id `06212e5df9c3779a`;
    the seed in `/etc/nan-relay/secrets-release-signing.seed` (0600, owned by `enclave-api-relay`, generated on nan with no
    copy off it). It is NOT yet configured: no `SECRETS_RELEASE_SIGNING_KEY(_FILE)` in api-relay.env, the release OFF. No
    standby key was generated (Codex's decision: ONE key). A standby would NOT be revocation: guests pinning {active, standby}
    keep accepting the active key after a leak, so switching the relay to the standby revokes nothing; the key id is a
    selector, not a revocation. Planned rotation is a separate design.
  - **Revocation is only by a new measured front:** the pinned set is in the image, so a leaked release key stays valid for every deployed guest until those guests are re-imaged. Plan a rotation as "ship a front pinning {old, new}, switch the relay to new, ship a front pinning {new}".
- Every provider below, wired and reviewed.

Rate: a ticket request is limited per client IP. A release is limited per its ticket's ENDPOINT, looked up without being consumed, so many guests behind one host address don't share one bucket. An unknown ticket is limited per IP.

## Measurements: predicted (`relay/measurement-predict.mjs`)

A release admits exactly the guest the relay PREDICTS for the deployment's catalog version. Nothing the lease holder, guestd or the guest states is ever its own allowlist: the report's measurement, AppID and runtime are compared against the prediction, never added to it. (This replaces the earlier `SECRETS_RELEASE_MEASUREMENTS` / `SECRETS_RELEASE_RUNTIME_IDS` lists and the open "(a) or (b)" question: it is (b).)

The pipeline, per catalog version:
1. The version, read from the chain by the relay through two or more independent RPCs that must AGREE (the address book's `appCatalog` too, unless `APP_CATALOG_ADDRESS` pins it; one lying provider cannot make the relay predict another app): `cid`, `memMb`, `ports`, read live on every release, before any cache. Only an approved, unyanked version of a listed app; a PENDING version only for a private deployment (`forPrivate = !isPublic`, exactly the supervisor's `approvalVerdict`); a rejected one never.
2. The derivation record, by the supervisor's own rule (`isolationPolicyFor`, `isolationHttpPortOf`, `isolationDerivation`): `enclave-catalog-bundle/1`, or `/2` for one declared `http:N` port; policy `{cpuPercent 100, memMiB max(128, memMb), vcpus 1}`; `runtimeId` = the admitted release's own `template/rt/runtime.json`. The test suite checks the rule against the supervisor's functions at the toolchain commit, and against guestd's real records (their `recordSha256`).
3. The component, fetched by CID and verified against it by guestd's own fetcher (`fetch-cid.py` → `wasm/ipfs_fetch.py`, CAR verification), through any trustless gateway (availability only). A raw-CID component is kept and re-verified against its CID on every read.
4. The bundle, by the catalog contract's reference implementation (`derive_reference.py`); AppID = `sha256(bundle)`. The AppID excludes the runtime (DERIVE.md); the record does not.
5. Per admitted release: `expected-measurement.sh --pin <release id>`, which verifies the release against that id, reassembles the guest image with M4a's own `assemble-app-image.sh` and computes the launch measurement with sev-snp-measure. The release's verified runtime must equal the record's.

Pins and self-checks:
- The toolchain is ONE git commit (`SECRETS_RELEASE_PREDICT_COMMIT`), extracted from the object store into a private directory (`git archive`): no working tree, untracked file or later edit is executed.
- sev-snp-measure is pinned by digest (`SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256`: its entry script and every file of the `sevsnpmeasure` package, `node relay/measurement-predict.mjs digest <exe>` prints it), checked every time the toolchain is used.
- The host tools it drives (python3, node, go ≥ 1.24, cpio, gzip, sev-snp-measure 0.0.13) are checked by a KNOWN-ANSWER test: the measurements of real M4a guests (`KNOWN_ANSWERS`, from VCEK-signed canary reports), recomputed at relay start, before the first prediction and every 6 h. A mismatch disables prediction (every release refused) until a later test passes. A gateway failure during the test is inconclusive: never a first pass, and a pass survives inconclusive re-tests for 24 h at most. Pre-seed the known answers' components into the predictor's `components` directory at install (they are raw-CID, re-verified against their CIDs on every read), so the test never needs the gateway. At least one known answer's release must be installed; `release-0181bce3` (id `5c3561f9…`) and `release-6757d139` (id `6f14ce75…`) are the two with known answers today.
- The supervisor's rule is pinned: `SUPERVISOR_RULE_SHA256` is the digest of its three rule functions (identical at 0181bce3 and c42612c0), and the suite fails when a tier supervisor (or the working tree's) carries another rule.
- Several admitted releases are allowed (`SECRETS_RELEASE_DOMAIN_RELEASES`): a guest keeps the measurement of the release it was built from, so the set spans a release change.

Bounds: one reconstruction at a time and at most 4 waiting (`busy` beyond that, never a guess); every tool call is time-bounded (240 s) with its process group killed; output capped; component size capped (256 MiB); answers cached per (commit, records, releases), LRU 256; a refusal cached for 60 s only; `busy` never cached. A ticket starts the prediction; a release waits at most 10 s for one still being computed, then answers `503 warming` with its ticket kept. Measured: 12 to 26 s cold, about 0.2 s cached.

Env: `SECRETS_RELEASE_PREDICT_REPO` (a git clone holding the commit), `SECRETS_RELEASE_PREDICT_COMMIT`, `SECRETS_RELEASE_PREDICT_RELEASES` (`id=dir,…`: every installed release, the known answers' included), `SECRETS_RELEASE_DOMAIN_RELEASES` (the admitted ids), `SECRETS_RELEASE_PREDICT_GATEWAY` (https), `SECRETS_RELEASE_SEV_SNP_MEASURE` (the pinned executable) and `SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256`, `SECRETS_RELEASE_PREDICT_WORK` (private), `SECRETS_RELEASE_CATALOG_RPCS` (two or more https Base RPCs on distinct hosts; mainnet.base.org refused these reads on 2026-09-25, publicnode and drpc answered).

Rollout (enclave-d1): `SECRETS_RELEASE_DEPLOYMENTS` starts as the canaries' ids only, never `*`; each further deployment is listed when its owner's step is reviewed.

Lab validation: `docs/security/measurement-prediction/` (the script, the canaries' attestation documents, and the recorded runs).

`GET /v1/secrets/release-status?id=0x…` answers `{id, listed}` from `SECRETS_RELEASE_DEPLOYMENTS` only, so a supervisor can choose the guest image without a second copy of the owner's decision (enclave-5d, d1's option (i)). It is public (deployment ids are public on chain), rate-limited, and 503 `release_off` while the release is off or not fully configured, without naming what is missing.

## Providers (all wired in `relay/api-relay.js`)

- `verifyGuestEvidence`: the VENDORED verifier's `verifyGuestDomainEvidence` (`verifier/consumer.mjs`, bundled into `relay/vendor/enclave-verifier-node.mjs`): exactly `verifyEvidence`'s SNP branch, restricted to `sev-snp-guest-domain-v1` (anything else is `unsupported`); AMD collateral from KDS through the reverify cache directory. A parity test runs it against `verifyEvidence` on the synthetic release reports.
- `expectedGuestFor` / `predictorProblems`: the measurement predictor (above).
- `confirmRow`: the deployment's record by id through two or more agreeing RPCs.
- `runtimeIdOf`: sha256 of the stated runtime identity's canonical JSON.
- `versionConfigFor`: the confirmed `appRef`'s catalog version `{config, configCid}` (`versionConfigCid` on catalog rev ≥ 7; a revert there means none) through the same agreeing RPCs.
- `prewarmCollateral`: the vendored `prewarmSnpCollateral`, BEFORE the ticket is consumed: the report's VCEK, the product's chain and the CRL through the same adapter the verifier then reads (a stale CRL counts as missing). An outage is `503 collateral_unavailable` with the ticket kept (enclave-d1: before S5, when a KDS or CRL outage would otherwise churn real apps). It judges nothing.
- `resolveConfigCid`: the CID's bytes fetched and verified against the CID by the platform's own fetcher (the predictor's pinned toolchain: `fetch-cid.py` → `wasm/ipfs_fetch.py`), 1 MiB cap, returned as text for the release to parse; kept per CID.

Before turning the release on:
- The predictor's host prerequisites on nan (above), and its env set and reviewed.
- Rollout condition: the lease holder must attach with VCEK verification (`METAL_REQUIRE_VCEK`), or it proves no chip.

## Tests

- `test/measurement-predict.test.mjs`: the derivation rule against guestd's real records and (when the commit is present) the supervisor's functions; every refusal code; the cache, dedupe, busy and timeout bounds; the toolchain executed from the commit only; the known-answer test disabling and re-enabling prediction; the kept component re-verified against its CID.

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
