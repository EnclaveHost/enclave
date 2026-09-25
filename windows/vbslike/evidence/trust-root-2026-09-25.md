# The report's trust root on nucbox-k11, and what the host's own boot log says about it

enclave-d1, 2026-09-25 ~05:20 UTC. Read-only on the host: no key was created, no PCR extended, no setting changed.
Tools: `ops/tpm-pcr-read.ps1` (TPM Base Services) and `verify/tcglog/tcglog.py`.

## The question

A VBS report is "software-attested" in the pinned paravisor's own words (`tpm_device/src/ak_cert.rs:19-25`). If a
customer is to trust it, its signing key has to chain to something the ordinary Windows host OS cannot control.
Nothing in the openvmm a7b0bd4 tree names that key or checks its signature.

Microsoft documents the chain for VBS **enclave** reports (Azure Attestation, "Virtualization-based security (VBS)
protocol"): trust runs "from a root of trust (TPM) to the launch of the hypervisor and secure kernel", and once the
TPM and the hypervisor's health are bound, "we can trust the Virtualization Based Security (VBS) enclave IDKs
provided in the Measured Boot Log". Microsoft does not document this chain for VM reports (`HvCallVbsVmCallReport`),
which is what our paravisor obtains.

## Verified on the host (measured, reproducible)

| # | observation | how |
|---|---|---|
| V1 | The host's current SRTM log is byte-identical to the MeasuredBoot file the canary captured: 90554 bytes, sha256 `0c23255ae491fd935eda951d0f107a0d7bb619b64db84de4648c62250b35363d`, host boot 2026-09-24T21:57:47Z | `Tbsi_Get_TCG_Log_Ex(SRTM_CURRENT)` vs `C:\Windows\Logs\MeasuredBoot\0000000067-0000000000.log` |
| V2 | Replaying that log's SHA-256 digests gives exactly the TPM's PCRs 0-14, and every Windows tagged event's data hashes to its logged digest | `tcglog.py replay` against `TPM2_PCR_Read` output |
| V3 | Negative controls both detected: one byte of the IDKS key changed (data no longer hashes to its digest), and the IDKS event's digest changed (PCR 12 no longer matches) | `tcglog.py replay` |
| V4 | The secure kernel logged two RSA-2048 public keys in event 37, PCR 12: `VSM_IDK_INFO` modulus sha256 `6c431a02c837d4b4…aeffde`, and `VSM_IDKS_INFO` modulus sha256 `3d7304ddd4f0ff42…77e75f`, exponent 65537 | `tcglog.py keys` |
| V5 | **Secure Boot is OFF.** The SecureBoot variable measured into PCR 7 is `00`, and `Confirm-SecureBootUEFI` returns False | `tcglog.py policy`, PowerShell |
| V6 | **Test signing is ON for the OS loader.** `TESTSIGNING=01` in events 31 and 32 (PCRs 12 and 13, the section that also records hvloader, the hypervisor and secfw), and `bcdedit /enum {current}` shows `testsigning Yes`. The boot manager's section (events 28 and 29) records `00` | `tcglog.py policy`, bcdedit |
| V7 | Hypervisor debug `00`, boot debugging `00`, kernel debug `00`, VSM launch type `1`, VBS_VSM_REQUIRED `01`, HVCI policy `1`, Microsoft boot chain required `1`, VSM no-secrets enforced `00`. DRTM PCRs 17-22 are at their reset value, so there was no dynamic launch | `tcglog.py policy`, PCR read |
| V8 | The production VBS-enclave engine `vbs\ee\ee-engine.dll` is signed only by a self-signed `CN=EnclaveTestSigning` (thumbprint `4ABCFA77…CA18`) | `Get-AuthenticodeSignature` |

## What these establish, and what they do not

- **V1-V4 are local consistency, not a remote proof.** The PCRs were read by a process on the host. A customer
  cannot rely on that. They need a TPM2_Quote over those PCRs, with their nonce, signed by an attestation key
  that chains to the TPM's endorsement certificate. **Not obtained.** Doing so creates or uses an attestation key
  in the host TPM; that is a host-security action, proposed below and not taken.
- **V4 gives candidate signing keys, not the signer.** Whether `VSM_IDKS` (or anything else) signs the paravisor's
  VbsReport is **untested**. The report's `signature[256]` field (`hvdef/src/vbs.rs:61-72`) is the size of an RSA-2048
  signature. That is consistent with IDKS and proves nothing. Testing it needs real report bytes, and the probe
  that would capture them is parked.
- **V5, V6 and V8 are a measured gap in the trust root itself.** Microsoft's documented chain requires the
  hypervisor and secure kernel to be "signed by the correct official Microsoft authorities and configured in a
  secure way". This host boots with Secure Boot off and test signing on, and it has to: the production enclave
  engine is test-signed (V8). A verifier holding to Microsoft's requirements should reject this host's boot state.
  It is recorded as a GAP, not as a verdict on what an attacker can do with it. Whether test signing lets
  host-controlled code reach IDKS or obtain IDKS-signed reports is **unknown**.

## Consequence for the proof

- The trust root is NOT established on this host as it is configured today.
- The precise missing property: a boot state that a verifier can accept (Secure Boot on, test signing off). That
  cannot coexist with the current test-signed production enclave engine.
- Changing Secure Boot or test signing is excluded from this lane by standing instruction. It also affects
  production, so it is **Steven's decision**.
- Independently of that decision, still needed: a signed TPM quote bound to a verifier nonce (host-security
  action, decision needed), and real report bytes to test the signer (probe parked).

`host_excluded` stays `no`. Admission settings unchanged.
