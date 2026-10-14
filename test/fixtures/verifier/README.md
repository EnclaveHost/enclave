# Verifier fixtures: authentic, public, offline

Every file here is public evidence captured from its source on 2026-09-24 (UTC), with the exact URL,
time and sha256 recorded in `SOURCES.json`. Nothing here is a secret: attestation reports, VCEK
certificates, CRLs and TLS certificates are all published so that
strangers can verify them. No private key of any kind is in this directory.

| set | silicon | what it is | what a passing test proves |
|---|---|---|---|
| `genoa-Cloud Provider/` | AMD Genoa, report v3 | a genuine report captured from a public Genoa host (Cloud Provider's inference host, 2026-09-24; that host's document format is no longer one this verifier judges), its VCEK from AMD KDS directly AND from a KDS proxy, and the host's TLS certificate | the verifier walks a genuine PSP signature to AMD's pinned Genoa root offline and refuses every single-field forgery; the suites present the report as an ABI/2 domain document whose binding is its own report_data (`test/helpers/genoa-capture.mjs`), so the binding rules are tested elsewhere, on evidence made for this verifier |
| `turin-m4a/` | AMD Turin, report v5 | a domain document from the isolation M4a hardware run (warden-host): ABI/2 binding over the transport key, the nonce and the runtime identity, app id in `report_data[32:64]`, plus its VCEK | the verifier handles the Turin TCB layout and 8-byte hardware id, a v5 report, the domain-format binding (ABI/1 and ABI/2 as caller-supplied bytes), and the app-naming half |
| `amd/` | all three lines | AMD's CRLs for Milan, Genoa, Turin | the ASK in use is not on the ARK-signed CRL (Genoa's CRL really does revoke the pre-2022 ASK, serial 020001); nextUpdate is the collateral-freshness clock |
| `pvm-evidence/` | Pixel 10 pVM (AVF) | two real `enclave-pvm-app-evidence/v1` envelopes from the owner's client-verified device run and one real v2 envelope (signed X25519 app key for the browser's sealed channel) from the browser-channel run (see its SOURCE.md) | the consumer adapter and the admission gate verify real device evidence with client-supplied pins through the owner's `verifyPvmAppEvidence` (skipped where that module is absent), and refuse the real-envelope forgeries (foreign nonce, swapped key, foreign chain, wrong app, wrong runtime, expired leaf) |

Re-capture: add a dated set beside these, never overwrite a committed one; a live metal box's fresh document is
`GET https://api.enclave.host/v1/enclaves/<name>/attestation?nonce=<64 hex>`. The AMD ARK/ASK chains live in `../amd/*-cert_chain.pem` (pinned in
`relay/snp-verify.mjs`, cross-checked against google/go-sev-guest's embedded copies on 2026-09-24).
