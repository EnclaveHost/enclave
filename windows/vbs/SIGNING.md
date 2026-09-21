# Signing the enclave: test signing today, Artifact Signing for production

The enclave image (`windows/enclave-engine/ee-engine.dll`) must carry a signature the Secure Kernel
accepts before `LoadEnclaveImageW` will map it into VTL1. Two regimes:

## Today: test signing (development tier)
`build.cmd` signs with the OpenSSL-made certificate in the box's LocalMachine store (thumbprint
`4ABCFA77FE9723604412D57733A62AC500DACA18`, EKUs code-signing + VBS enclave + a private author OID),
which the box accepts only because `bcdedit /set testsigning on` and Secure Boot is off. The report's
`AuthorId` is derived from that certificate; the boot log records `TESTSIGNING = 1`, and the relay
admits such a node only under `METAL_VBS_ALLOW_TESTSIGNING=1` as tier **vbs-dev** (badge: development,
unsigned).

**This is switched on in production today** (2026-09-21, `/etc/nan-relay/api-relay.env` on `nan`),
because the tier had to be demonstrable before the signing account exists. What limits it is not the
flag but the allowlist beside it: `METAL_VBS_ENCLAVE_MEASUREMENTS` names exactly one build,
`ce450a96a8f32f2bc7a4821583057f4e6cef8ca6a5d742c0af4047fb41d30b3c` =
sha256(FamilyId ‖ ImageId ‖ AuthorId) of our test-signed enclave, so a stranger's test-signed
enclave computes a different key and is refused. Every such node is badged "vbs enclave (dev)" and
carries tier `vbs-dev` on its row. **Remove the flag in the same change that lands the steps below**;
a production-signed build needs no relaxation.

## Production: Artifact Signing (formerly Trusted Signing), VBS enclave profile
What REPORT.md section 7 established: the service went GA in January 2026 (US, Canada, EU, UK
organizations), the 3-year-history rule is gone since 2026-04-01, the Basic SKU ($9.99/month, 5,000
signatures) includes one certificate profile of each type, and the **VBS enclave** profile is a Public
Trust type whose certificate carries the production Author EKU, so the enclave's `AuthorId` becomes
Microsoft-validated identity rather than our self-made one. Free, trial and sponsored Azure
subscriptions are refused; identity validation takes 1-20 business days.

Steps that need the company's Azure account (Steven), in order:
1. Azure: create a **Code Signing Account** (Basic) in a supported region; create an **Identity
   Validation** for Enclave Host, Inc. (D-U-N-S recommended; the validation e-mail goes to the
   registered agent); wait for `Completed`.
2. Create a certificate profile of type **VBS enclave** on that account, bound to the identity.
3. Give the signing principal (a service principal for CI, or the operator's user) the role
   `Trusted Signing Certificate Profile Signer` on the account.
4. On the signing machine: Windows SDK 26100 (`signtool`), the Trusted Signing client package
   `Microsoft.Trusted.Signing.Client` (NuGet) for `Azure.CodeSigning.Dlib.dll`, and an Azure login
   (`az login` or a client secret in `AZURE_*`).
5. Sign with `windows/vbs/tools/sign-release.cmd` (below): it fills `metadata.json` from the
   environment and calls `signtool sign /v /fd SHA256 /ph /dlib ... /dmdf metadata.json` on the
   DLL that `veiid.exe` already stamped. The `/ph` page hashes are mandatory for enclaves.
6. Re-read the enclave's identity from a report on the box (`ee-host.exe` + `attest`, or
   `relay/vbs-verify.mjs` on the evidence) and pin `sha256(FamilyId||ImageId||AuthorId)` in the
   relay's `METAL_VBS_ENCLAVE_MEASUREMENTS`; turn test signing off and Secure Boot on
   (`bcdedit /set testsigning off`, firmware setting); verify the boot log flips `TESTSIGNING = 0`
   and `SecureBoot = 1`, at which point the relay admits the node as tier **vbs**.

What this does not change: the ImageId/FamilyId/SVN in `ee-main.cpp`'s `__enclave_config` (ours),
the report format, or the verifier. Only the AuthorId's provenance and the two boot-log facts.

Environment for `sign-release.cmd`:
```
ARTIFACT_SIGNING_ENDPOINT   https://<region>.codesigning.azure.net   (e.g. https://eus.codesigning.azure.net)
ARTIFACT_SIGNING_ACCOUNT    the Code Signing Account name
ARTIFACT_SIGNING_PROFILE    the VBS-enclave certificate profile name
ARTIFACT_SIGNING_DLIB       path to Azure.CodeSigning.Dlib.dll (from the NuGet package, bin\x64)
AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET   or an az login session
```
