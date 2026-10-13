# Remote-attestation specifications and reference verifiers: reference note

Companion to `independent-verifier-plan.md`. Compiled 2026-09-23/24 by a research pass over primary sources
(registry and API JSON for versions, specification PDFs read with `pdftotext`). Items that could not be
confirmed from a primary source are marked **unconfirmed** with the URL that was checked.

## 1. AMD SEV-SNP

**SEV-SNP Firmware ABI Specification, AMD pub 56860.** Current: Rev 1.59 PUB, 2026-08-26
(https://docs.amd.com/v/u/en-US/56860_PUB_SEV_SNP; PDF https://www.amd.com/content/dam/amd/en/documents/epyc-technical-docs/specifications/56860.pdf).
Layouts in Rev 1.59: Table 27 ATTESTATION_REPORT (VERSION 00h, now 6h; POLICY 08h; SIGNATURE_ALGO 34h, 1h =
ECDSA P-384 with SHA-384; CURRENT_TCB 38h; PLATFORM_INFO 40h, Table 28; REPORT_DATA 50h (64 B); MEASUREMENT 90h
(48 B); HOST_DATA C0h; ID_KEY_DIGEST E0h; AUTHOR_KEY_DIGEST 110h; REPORT_ID 140h; REPORTED_TCB 180h;
CPUID_FAM/MOD/STEP 188h-18Ah; COMMITTED_TCB 1E0h; LAUNCH_TCB 1F0h; LAUNCH_MIT_VECTOR 1F8h; CURRENT_MIT_VECTOR 200h;
new in 1.59: CURRENT_ETCB 220h, LAUNCH_ETCB 240h, COMMITTED_ETCB 260h; signature at 2A0h; report 0x4A0 bytes).
TCB_VERSION: Table 5 (Milan/Genoa) 63:56 MICROCODE, 55:48 SNP, 47:16 reserved, 15:8 TEE, 7:0 BOOT_LOADER;
Table 4 (Turin, family 1Ah) 63:56 MICROCODE, 55:32 reserved, 31:24 SNP, 23:16 TEE, 15:8 BOOT_LOADER, 7:0 FMC;
Table 3 (Venice) 63:24 reserved, 23:16 SNP, 15:8 TEE, 7:0 FMC. Table 148: ECDSA P-384 signature, R at 000h, S at
048h, each 576 bits zero-extended little-endian. go-sev-guest v0.15.0 aligns with Rev 1.58 and parses report
versions 2..5 (`MaxSupportedReportVersion = 5`); version-6 reports from 1.59 firmware are not yet covered there.

**VCEK Certificate and KDS Interface Specification, AMD pub 57230.** Current: Rev 1.05 PUB, 2026-09-03
(https://docs.amd.com/v/u/en-US/57230). Base `https://kdsintf.amd.com`: `vcek/v1/{product}/{hwID}?blSPL=&teeSPL=&snpSPL=&ucodeSPL=`
(order-independent), `vcek/v1/{product}/cert_chain` (ASK then ARK, PEM), `vcek/v1/{product}/crl` (also the CRL DP
in the certificates). Rate limiting is documented ("Error 429 Too Many Requests"). VLEK under `/vlek/v1/`. Keys: ARK
and ASK RSA-4096 RSASSA-PSS; VCEK ECDSA P-384. Extension OIDs 1.3.6.1.4.1.3704.1.1 structVersion, .1.2 productName,
.1.3.1 blSPL, .1.3.2 teeSPL, .1.3.3 snpSPL, .1.3.4-.1.3.7 spl_4..7, .1.3.8 ucodeSPL, .1.4 hwID. Turin: hwID is 8
octets and the query adds `fmcSPL` (OID 1.3.6.1.4.1.3704.1.3.9, `OidFmcSpl` in tinfoilsh/go-sev-guest; upstream
google/go-sev-guest PR 198 still an open draft on 2026-09-02). The 8-octet/fmcSPL statement is **unconfirmed** by a
direct read of Rev 1.05 (only Rev 0.51 is mirrored); it is confirmed in practice by KDS answering the Turin URL form
`relay/snp-verify.mjs` builds (warden-host, fixture `turin-m4a`).

**ARK/ASK roots.** https://www.amd.com/en/developer/sev.html links EULA-gated bundles
`https://download.amd.com/developer/eula/sev/ask_ark_{naples,rome,milan,genoa,prod_turin}.cert`; the same chains come
from KDS `cert_chain`. AMD publishes no fingerprint list (**unconfirmed**). go-sev-guest embeds the PEMs via
`go:embed` in `verify/trust/trust.go` (`ask_ark_milan.pem`, `ask_ark_genoa.pem`, `ask_ark_turin_vcek.pem` and the VLEK
variants) and requires `SHA384WithRSAPSS` on ASK/ARK signatures (salt length 48). Our pins in
`relay/snp-verify.mjs` were re-compared to those three files on 2026-09-24: all match.

**Reference verifiers.** google/go-sev-guest v0.15.0 (2026-06-09), Apache-2.0. virtee/sev crate 8.0.0 (2026-05-27),
Apache-2.0. virtee/snpguest v0.10.0 (2025-11-13, adds `fetch crl`), license **unconfirmed**. AMDESE/sev-tool
Apache-2.0, archived 2023-07. virtee/sev-snp-measure v0.0.13 (2026-05-22), Apache-2.0 (launch-digest calculator,
Turin vCPU types; used by `metal/build-image.mjs`). igvmmeasure: coconut-svsm/svsm `tools/igvmmeasure` (MIT); parser
crate `igvm` 0.4.0 (MIT).

## 2. Intel TDX

Intel TDX DCAP Quoting Library API Rev 0.91 (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf,
2026-09-09). Appendix A.3 Version 4 quote: header 48 B (Version u16 = 4; Attestation Key Type 2 = ECDSA-P256; TEE Type
0x81; QE Vendor ID 939A7233-F79C-4CA9-940A-0DB3957F0607; User Data 20 B); body 584 B: TEE_TCB_SVN 16, MRSEAM 48,
MRSIGNERSEAM 48, SEAMATTRIBUTES 8, TDATTRIBUTES 8, XFAM 8, MRTD 48, MRCONFIGID 48, MROWNER 48, MROWNERCONFIG 48,
RTMR0..3 48 each, REPORTDATA 64 (quote offsets: MRTD 184, RTMR0 376, RTMR1 424, RTMR2 472, RTMR3 520, REPORTDATA
568-631, SIG_LEN at 632). A.4 Version 5 (header, body descriptor, TDX 1.0 and 1.5 bodies). `supervisor.js parseTdxQuote`
matches these offsets.

DCAP / QVL: intel/SGXDataCenterAttestationPrimitives DCAP_1.27.1 (2026-08-11), BSD-3-Clause. PCS API v4
(https://api.portal.trustedservices.intel.com/content/documentation.html): `https://api.trustedservices.intel.com/sgx/certification/v4/{pckcert,pckcerts,pckcrl,tcb,qe/identity,qve/identity,qae/identity,fmspcs,tcbevaluationdatanumbers}`
and `.../tdx/certification/v4/{tcb,qe/identity}`; read endpoints need no key; 429 with `Retry-After`. Root:
https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem (CN=Intel SGX Root CA,
2018-05-21 to 2049-12-31), SHA-1 8bd31eb1d63ce37382c0ffaa0d8200a3011ad6ff (reproduced), SHA-256
44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3. Intel Trust Authority (https://docs.trustauthority.intel.com)
`/appraisal/v2/attest`, composite TDX+GPU tokens. Verifiers: google/go-tdx-guest v0.3.1 (Apache-2.0);
edgelesssys/go-tdx-qpl AGPL-3.0 (untagged); Phala `dcap-qvl` 0.6.3 (2026-08-31), MIT, pure Rust.

## 3. NVIDIA GPU confidential computing

nvtrust latest release 2026.06.04.001 (Attestation SDK / Local GPU Verifier v2.7.3, PPCIE verifier v1.7.3), Apache-2.0.
The Python SDK is deprecated (security patches only after 2026-03-15, end of support 2026-09-15); replacement is the C++
NVAT SDK https://github.com/NVIDIA/attestation-sdk (Apache-2.0, release 2026.06.09, `nvattest`, `libnvat`). NRAS
`https://nras.attestation.nvidia.com` `/v3/attest/gpu`, `/v4/attest/gpu` (EAT claims 3.0 on v4, Blackwell from 3.5,
Bearer auth from 4.0.6), JWKS `/.well-known/jwks.json`. RIM `GET https://rim.attestation.nvidia.com/v1/rim/{id}`
(CoRIM; ids like `NV_GPU_CC_DRIVER_GB100_580.65.06`), OCSP `https://ocsp.ndis.nvidia.com/`. Roots published only in-repo
(`guest_tools/gpu_verifiers/local_gpu_verifier/src/verifier/certs/`): `verifier_device_root.pem` CN=NVIDIA Device
Identity CA, P-384, SHA-256 102bf659d5419614c9d8e6aecebc80454eb26b1df6a769ac720b9a690b167b48; `verifier_RIM_root.pem`
CN=NVIDIA CoRIM signing Root CA, SHA-256 12977b5115acb0381179279fffeb5a8c4d264971ebb32298023a465fa41df5d1. Report = SPDM
GET_MEASUREMENTS signed by the per-GPU attestation key. Modes (Deployment Guide DU-12302-001_v7.1, April 2026): Hopper
CC or Protected PCIe; Blackwell CC single or multi-GPU; `--set-cc-mode on|off|devtools`.

## 4. Android AVF / pVM

https://android.googlesource.com/platform/packages/modules/Virtualization/+/main/docs/vm_remote_attestation.md: two
stages (RKP VM attested to the RKP server, which checks the UDS-rooted DICE chain against factory-registered keys; then
each pVM attested against the RKP VM), yielding an RKP-backed chain plus a pVM-only private key.
`AVmPayload_requestAttestation(const void* challenge, size_t challenge_size, AVmAttestationResult**)`, challenge at most
64 bytes (`ATTESTATION_ERROR_INVALID_CHALLENGE`), P-256 key, DER certificates. Leaf extension OID
1.3.6.1.4.1.11129.2.1.29.1: `AttestationExtension ::= SEQUENCE { attestationChallenge OCTET STRING, isVmSecure BOOLEAN,
vmComponents SEQUENCE OF VmComponent }`, `VmComponent ::= SEQUENCE { name UTF8String, securityVersion INTEGER, codeHash
OCTET STRING, authorityHash OCTET STRING }`. The doc gives no relying-party procedure. Google roots
https://android.googleapis.com/attestation/root; revocation https://android.googleapis.com/attestation/status; RKP is the
only provisioning mechanism from Android 16.

## 5. Sigstore / provenance

Bundle: sigstore/protobuf-specs v0.5.2 (Apache-2.0); media types `application/vnd.dev.sigstore.bundle+json;version=0.1|0.2`
and `application/vnd.dev.sigstore.bundle.v0.3+json` (single leaf certificate). Fulcio OIDs
(https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md) 1.3.6.1.4.1.57264.1.x: .1-.6 deprecated raw (Issuer,
Trigger, SHA, Name, Repository, Ref); .8 Issuer V2; .9 Build Signer URI; .10 Build Signer Digest; .11 Runner
Environment; .12 Source Repository URI; .13 Source Repository Digest; .14 Source Repository Ref; .15 Identifier; .16
Owner URI; .17 Owner Identifier; .18 Build Config URI; .19 Build Config Digest; .20 Build Trigger; .21 Run Invocation
URI; .22 Visibility; .23 Deployment Environment; .24 Token Subject (.8+ are DER UTF8String). Rekor v1
`rekor.sigstore.dev` in parallel with Rekor v2 `log2025-1.rekor.sigstore.dev` (GA 2025-10-10, yearly shards). TUF at
https://tuf-repo-cdn.sigstore.dev: root version 15 (expires 2026-11-20, threshold 3 of 5); consistent snapshots, so
`timestamp.json` -> `<n>.snapshot.json` -> `<n>.targets.json` -> `targets/<sha256>.trusted_root.json` (targets v14 on
2026-09-24, fixture `sigstore/trusted_root.json`). sigstore-js: npm `sigstore` 5.0.0, `@sigstore/verify` 4.1.2,
Apache-2.0; sigstore-go v1.3.0 (2026-07-30), Apache-2.0. GitHub attestations API
`GET /repos/{owner}/{repo}/attestations/sha256:{digest}` (unauthenticated for public repos);
`gh attestation verify` flags `--signer-workflow`, `--cert-identity`, `--cert-oidc-issuer`, `--deny-self-hosted-runners`.
in-toto Statement v1 `https://in-toto.io/Statement/v1`; SLSA provenance v1 `https://slsa.dev/provenance/v1`.
`@freedomofpress/sigstore-browser` 0.1.14: package.json says MIT, the shipped LICENSE file is Apache-2.0 (treat as
Apache-2.0: ship the notice); deps crypto-browser ^0.1.7, tuf-browser ^0.1.11, @noble/curves ^2.0.1.
Tinfoil: predicate types (https://docs.tinfoil.sh/verification/predicate) `sev-snp-guest/v1`, `tdx-guest/v1`,
`snp-tdx-multiplatform/v1` (register 0 SNP launch measurement, 1 TDX RTMR1, 2 TDX RTMR2), `hardware-measurements/v1`.
tinfoilsh/measure-image-action ("Private Deployment Build Action"): **AGPL-3.0**, latest v0.13.1 (2026-09-22); the
repository pins v0.9.2 by SHA and runs it only in CI, which carries no distribution obligation. tinfoilsh/tinfoil-js
`@tinfoilsh/verifier` latest 1.2.1, Apache-2.0 from 1.1.9 (AGPL-3.0-or-later through 1.1.8).

## 6. Cryptographic libraries for a browser and Node verifier

WebCrypto `SubtleCrypto.verify`: RSASSA-PKCS1-v1_5, RSA-PSS (`saltLength` free, so SHA-384 with salt 48 for ASK to VCEK
works; hash bound at `importKey`), ECDSA P-256/P-384/P-521, HMAC, Ed25519 (Chrome 137, Firefox 129, Safari 17);
`digest` SHA-256/384/512. No X.509 parser: `@peculiar/x509` 2.1.0 (MIT) or `pkijs` 3.4.1 (BSD-3-Clause), or the ASN.1
inside `@freedomofpress/crypto-browser`. `@noble/curves` 2.4.0 and `@noble/hashes` 2.4.0 (MIT). Node
`crypto.X509Certificate` (`verify`, `checkIssued`, `fingerprint256`, `publicKey`, `raw`); `crypto.verify` with
`padding: RSA_PKCS1_PSS_PADDING, saltLength`.

## 7. Windows VBS enclaves / TPM

`EnclaveGetAttestationReport` (winenclaveapi.h, vertdll.dll):
https://learn.microsoft.com/en-us/windows/win32/api/winenclaveapi/nf-winenclaveapi-enclavegetattestationreport;
`VBS_ENCLAVE_REPORT_PKG_HEADER` + `VBS_ENCLAVE_REPORT` {ReportSize, ReportVersion=1, EnclaveData[64], ENCLAVE_IDENTITY}
+ VARDATA + signature by a VBS-specific key (https://learn.microsoft.com/en-us/windows/win32/api/ntenclv/ns-ntenclv-vbs_enclave_report).
Azure Attestation VBS protocol (https://learn.microsoft.com/en-us/azure/attestation/virtualization-based-security-protocol).
TCG EK Credential Profile for TPM 2.0, Level 0, Version 2.7 (2026-03-16). No open-source standalone VBS report verifier
was found; `relay/vbs-verify.mjs` is first-party.

## Licensing obligations (browser bundle)

| item | SPDX | obligation when bundled |
|---|---|---|
| go-sev-guest, virtee/sev, sev-snp-measure, go-tdx-guest, nvtrust, attestation-sdk, sigstore-js, sigstore-go, protobuf-specs, @tinfoilsh/verifier >= 1.1.9, @freedomofpress/sigstore-browser (LICENSE file), crypto-browser | Apache-2.0 | ship LICENSE and any NOTICE; mark modified files |
| coconut-svsm igvmmeasure, igvm crate, dcap-qvl, @noble/curves, @noble/hashes, @peculiar/x509, tuf-browser | MIT | copyright and permission notice in the bundle's notices |
| DCAP (QVL), pkijs | BSD-3-Clause | copyright and license text; no endorsement using the names |
| sev-tool | Apache-2.0 (archived) | avoid, unmaintained |
| go-tdx-qpl, measure-image-action, @tinfoilsh/verifier <= 1.1.8 | AGPL-3.0 | never bundle; the action runs only in CI |
| snpguest | unconfirmed | check before use |
