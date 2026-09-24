# Verifier fixtures: authentic, public, offline

Every file here is public evidence captured from its source on 2026-09-24 (UTC), with the exact URL,
time and sha256 recorded in `SOURCES.json`. Nothing here is a secret: attestation reports, VCEK
certificates, CRLs, TLS certificates, Sigstore bundles and release digests are all published so that
strangers can verify them. No private key of any kind is in this directory.

| set | silicon | what it is | what a passing test proves |
|---|---|---|---|
| `genoa-tinfoil/` | AMD Genoa, report v3 | the hosted-fleet FORMAT (`sev-snp-guest/v2`) as Tinfoil's shim serves it on a public inference host, its VCEK from AMD KDS directly AND from Tinfoil's proxy, and the shim's TLS certificate | the verifier walks a genuine PSP signature to AMD's pinned Genoa root offline, applies the hosted-format binding rule (report_data[0:32] = sha256(TLS SPKI), certificate `hatt` SAN = sha256(format+body)), and agrees with `@tinfoilsh/verifier` on the same bytes |
| `turin-m4a/` | AMD Turin, report v5 | a domain document from the isolation M4a hardware run (warden-host): ABI/2 binding over the transport key, the nonce and the runtime identity, app id in `report_data[32:64]`, plus its VCEK | the verifier handles the Turin TCB layout and 8-byte hardware id, a v5 report, the domain-format binding (ABI/1 and ABI/2 as caller-supplied bytes), and the app-naming half |
| `amd/` | all three lines | AMD's CRLs for Milan, Genoa, Turin | the ASK in use is not on the ARK-signed CRL (Genoa's CRL really does revoke the pre-2022 ASK, serial 020001); nextUpdate is the collateral-freshness clock |
| `release/` | n/a | the latest release's digests and GitHub artifact attestations (Sigstore v0.3 bundles) for both flavors | provenance verifies against OUR release policy (repo, workflow path, tag ref pattern, OIDC issuer, predicate type, subject digest) with a pinned Sigstore root; every field of that policy is mutated independently |
| `sigstore/` | n/a | the Sigstore public-good trusted root, fetched through TUF `targets.json` and hash-checked | the root the provenance step pins was taken from Sigstore's own TUF repository, not from a third-party bundle |

Re-capture: `node verifier/cli.mjs capture --help` (writes a new set beside these; never overwrite a
committed set, add a dated one). The AMD ARK/ASK chains live in `../amd/*-cert_chain.pem` (pinned in
`relay/snp-verify.mjs`, cross-checked against google/go-sev-guest's embedded copies on 2026-09-24).
