# windows-vbs-enclave/v1: the evidence a Windows consumer node presents, and what binds it

The contract between three pieces built separately: the Windows node agent
(`windows/node/agent.mjs` + `windows/node/tpmattest.c`), the relay's verifier
(`relay/vbs-verify.mjs`, tunnel mode `vbs`) and the enclave engine
(`windows/enclave-engine/`). Sibling of `android-avf-pvm/v2` (relay/avf-binding.mjs):
same tunnel handshake, one extra round for the TPM credential.

## Keys generated INSIDE the enclave, at start, per boot
- `transportKey`: Ed25519, SPKI DER (44 bytes). Signs the binding transcript; its
  fingerprint is the tunnel's `transportKeyFp`.
- `padKey`: X25519 public key, 32 bytes, hex. The dealer encrypts pad seeds to it.
Neither private key ever leaves VTL1. The enclave refuses to sign a transcript
it did not build from its own keys.

## Handshake on the fleet tunnel (relay/tunnel.js)
1. Agent dials `wss://<relay>/…` with headers `x-metal-name: <name>`, `x-metal-attest: 1`.
2. Hub -> `{t:"challenge", nonce: b64(32 bytes)}`.
3. Agent -> `{t:"vbs-keys", ek: b64(EK certificate DER), ekChain: [b64 DER…] (optional intermediates), aikPub: b64(TPMT_PUBLIC of the quoting key), aikName: b64(TPM2B_NAME contents, 34 bytes: 0x000B || sha256)}`.
4. Hub runs TPM2_MakeCredential(EK public, AIK name, credential = 32 random bytes) and
   -> `{t:"vbs-credential", credentialBlob: b64(TPM2B_ID_OBJECT contents), secret: b64(TPM2B_ENCRYPTED_SECRET contents)}`.
   A hub without vbs policy answers `{t:"attest-result", ok:false, reason:"VBS attach is not enabled on this relay"}`.
5. Agent builds the transcript and asks the enclave to attest it, the TPM to activate the credential and to quote:
   ```
   bound     = "enclave-vbs-bind-v1\n" || spki(44) || padKey(32 raw) || nonce(32)
   challenge = sha256(bound)                                (32 bytes)
   ```
   - Enclave report: `EnclaveGetAttestationReport(challenge)`; the VBS_ENCLAVE_REPORT's
     EnclaveData field carries `challenge` in its first 32 bytes (the rest zero).
   - Enclave signature: Ed25519 over `bound` with transportKey.
   - TPM quote: PCR selection sha256 {0, 7, 12, 13, 14}, `extraData = challenge`.
   - TPM ActivateCredential(AIK, EK, credentialBlob, secret) -> the 32-byte credential.
6. Agent -> `{t:"attest", rad:{format:"windows-vbs-enclave/v1", transportKey: b64 SPKI, padKey: hex64, body: b64(JSON below)}, operatorSig?}`.
   ```json
   { "report":     "b64 VBS_ENCLAVE_REPORT package (24-byte header + report + var data)",
     "signature":  "b64 Ed25519 signature over bound",
     "log":        "b64 TCG measured-boot log of the CURRENT boot (C:\\Windows\\Logs\\MeasuredBoot, newest)",
     "quote":      { "attest": "b64 TPMS_ATTEST", "sig": "b64 RSASSA-PKCS1v15-SHA256 signature", "aikPub": "b64 TPMT_PUBLIC" },
     "credential": "b64 the 32 bytes recovered by ActivateCredential",
     "ek":         { "cert": "b64 DER", "chain": ["b64 DER", "…"] },
     "pcr0":       "hex sha256 of PCR 0 as read live (the log does not replay it on AMI firmware)",
     "platform":   { "osBuild": "26200.8875", "edition": "Pro", "testSigning": true, "secureBoot": false, "vbsRunning": true } }
   ```
   `platform` is informational: the verifier takes every fact from the log and the report, never from here.
7. Hub -> `{t:"attest-result", ok, measurement, reason?}`; then the agent's `{t:"hello", name, mode:"vbs", transportKeyFp}` as any tunnel.

## What the verifier establishes (relay/vbs-verify.mjs), all required unless marked
1. EK certificate chains to a pinned hardware root (AMD `CN=AMDTPM` sha256 `67bd2472…d0c6a1`, Intel when added); SAN names tpmManufacturer `id:414D4400` or `id:494E5443` (on-die firmware TPM, never discrete or virtual).
2. Quoting key: TPMT_PUBLIC attributes include fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign (0x00050072 set); `aikName` = 0x000B || sha256(TPMT_PUBLIC bytes).
3. Credential round trip: the returned 32 bytes equal what the hub minted for (EK, AIK name). This is what proves the quoting key lives in the TPM whose EK was checked.
4. Quote: signature verifies with aikPub; magic 0xff544347, type TPM_ST_ATTEST_QUOTE; extraData == challenge; PCR digest == sha256(PCR0 || PCR7 || PCR12 || PCR13 || PCR14) where PCR7/12/13/14 are REPLAYED from the log and PCR0 is the supplied `pcr0` which must equal a pinned value per firmware version (policy).
5. Log: SIPA digests recomputed (never trusted from the log); required fields on PCR 12: VSM_LAUNCH_TYPE=1, HYPERVISOR_LAUNCH_TYPE=1, VBS_VSM_REQUIRED=1, VBS_HVCI_POLICY=1, CODEINTEGRITY=1, BOOTDEBUGGING=0, OSKERNELDEBUG=0, HYPERVISOR_DEBUG=0, SAFEMODE=0, WINPE=0, FLIGHTSIGNING=0. TESTSIGNING=0 unless policy `allowTestSigning` (dev tier: the badge says so).
6. VSM IDKS: the RSA public key in the VSM_IDKS_INFO event (0x50023) on PCR 12, from the replayed log.
7. Report: package parses (magic/size), report signed by the IDKS (RSA-PSS SHA-256, salt 32) over the report body; EnclaveData[0:32] == challenge; ENCLAVE_IDENTITY: image measurement (`UniqueId`/`ImageId`/`FamilyId`/`AuthorId`) on the policy allowlist, SVN >= minimum, flags: not debuggable (ENCLAVE_FLAG_FULL_DEBUG_ENABLED / DYNAMIC_DEBUG clear) unless dev policy.
8. Transport binding: Ed25519 `signature` over `bound` verifies with `transportKey`; `padKey` is 32 bytes; `bound` rebuilt by the hub from ITS nonce.
9. Freshness: log timestamp/boot counter consistent with the quote's clock info (warn only).
Result: `{ ok, measurement: hex(ImageId||AuthorId||SVN), reasons[], tier: "vbs" | "vbs-dev" }`.

## Policy (relay env)
- `METAL_VBS_ENCLAVE_MEASUREMENTS`: comma list of allowed `sha256(FamilyId||ImageId||AuthorId)` hex; empty = vbs attach off.
- `METAL_VBS_MIN_SVN` (default 1), `METAL_VBS_PCR0`: comma list of allowed PCR0 hex per firmware.
- `METAL_VBS_EK_ROOTS`: PEM bundle path of pinned TPM roots (default: relay/fixtures/tpm-roots.pem = AMD).
- `METAL_VBS_ALLOW_TESTSIGNING=1`: admit TESTSIGNING=1 logs and debuggable enclaves as tier `vbs-dev` (the badge and copy say "development, unsigned"). Never on the hosted relay outside a lab window.

## Badge / availability
`/availability` from the agent: `{ ok, role: "windows-vbs-node", name, gpu: "<Vulkan device name>", teeCpu: "windows-vbs-enclave", tier: "vbs"|"vbs-dev", shielded: { worker: "vulkan", protocol: "1.4.0", vramGiB } }`.
The site labels `teeCpu: windows-vbs-enclave` as the consumer tier: "VBS enclave on a consumer PC: protects against the owner's software, not physical possession" (handoff section 1).
