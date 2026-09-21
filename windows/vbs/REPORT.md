# Consumer-hardware confidential node: VBS enclave feasibility, measured

Status: spikes (a) and (c) of the consumer-tier handoff DONE on real hardware (2026-09-20); the
attestation verifier's chain implemented end to end against evidence from that box, with
negative tests; spikes (b) and (d) answered from public sources (section 7). Everything below is
measured on the machine in section 1 unless it says otherwise. Companion files: `tools/` (log
parser, verifier, TPM readers), `enclave/` (the minimal enclave + host + benchmark), `evidence/`
(one boot's log, quote, EK certificate and enclave report, which the verifier accepts).

## 0. The answer in six lines

1. **A VBS enclave loads, runs, and attests on Windows 11 Pro 25H2 (26200.8875) on a consumer
   Ryzen mini PC**, built with Visual Studio Build Tools 2026 (toolset v145) and SDK 26100, under
   test signing. The enclave's report is signed by the per-boot VSM identity key (IDKS) that
   the boot loader measures into PCR 12, and **that signature verifies with the key extracted
   from the measured-boot log** (RSA-PSS, SHA-256, salt 32).
2. **The chain closes to the TPM**: a TPM quote over PCRs 7/12/13/14 (with our nonce) verifies,
   and the log replays to exactly the quoted values. PCR 0 does NOT replay from this firmware's
   log; the verifier pins it instead. The quoting key is bound to the EK by a MakeCredential /
   ActivateCredential round trip, proven on the box (section 10, 2026-09-21).
3. **The AMD fTPM's EK certificate chains to AMD's root** (`CN=AMDTPM`, fingerprint in section
   5), and the certificate names the manufacturer, so "on-die only" is an enforceable check.
4. **Memory-encryption state is not visible in the Windows boot log**, nor anywhere else a
   user-mode agent can read: no SIPA record carries it, and TSME's enabled bit lives in an MSR.
   Spike (c) is negative. The only Windows path is AMD Secure Launch (DRTM), which logs a
   `TSME_RB_FUSE` event and needs a DRTM-capable platform.
5. **Code inside VTL1 runs at native speed on the host's memory**: 56-58 GB/s streaming a 1 GB
   VTL0 buffer, single-threaded, same as VTL0; AVX-512F and VNNI are enabled in the enclave
   (XCR0 = 0xE7 on both sides). The one cost is first touch: ~2 s for the first pass over
   1 GB (the hypervisor maps host pages into VTL1 on demand), then native.
6. **Not established here**: Windows 11 Home (this box is Pro; no public statement either way),
   Trusted Signing eligibility (section 7), and anything about a discrete GPU (this box has an
   iGPU and no CUDA).

## 1. The test box

GMKtec NucBox K11: Ryzen 9 8945HS (Hawk Point, Zen 4, 8c/16t), Radeon 780M iGPU, 112 GB DDR5,
AMI firmware 1.01 (2025-02-18). Windows 11 Pro 25H2 build 26200.8875, Windows PowerShell 5.1.
VBS running with HVCI (`Win32_DeviceGuard`: status 2, services running 2); hypervisor present;
Hyper-V role NOT installed (enclaves need only VBS). TPM: AMD fTPM 6.10.0.7, TPM 2.0 rev 1.59,
"Ready For Attestation", no Pluton device. **Secure Boot OFF** (it was off when we got the box;
test signing requires it off, production nodes need it on). No BitLocker. Reached over SSH as a
local admin (`ssh minipc`); every command below ran that way.

Toolchain already present: Visual Studio Build Tools 2026 18.7 (MSVC 14.51.36231, "v145"),
Windows SDK 10.0.26100 with `veiid.exe` 26100.8249, the enclave CRT (`VC\Tools\MSVC\<ver>\lib\x64\enclave\`,
`Windows Kits\10\Lib\10.0.26100.0\ucrt_enclave\`), `signtool`, git, Python 3.14. Microsoft's
tooling repo pins toolset v143 (VS 2022) and its own CI broke on VS 2026 (issue #206); passing
`/p:PlatformToolset=v145` built its HelloWorld sample without source changes.

## 2. Spike (a): the enclave loads (on Pro)

Recipe that worked, in order. Each item after the first cost time to discover.

1. `bcdedit /set testsigning on`, reboot. (Secure Boot must already be off; BitLocker off or
   recovery key in hand.) The next boot's log records `TESTSIGNING = 1` at the OS-loader
   boundary, so a verifier sees dev mode; the report itself has no such flag.
2. Signing certificate with the three EKUs (code signing `1.3.6.1.5.5.7.3.3`, enclave
   `1.3.6.1.4.1.311.76.57.1.15`, author `1.3.6.1.4.1.311.97.<...>`). Over SSH,
   `New-SelfSignedCertificate` into `Cert:\CurrentUser\My` fails with `0x80070005` (no
   interactive key isolation for a network logon), and `signtool /f x.pfx` fails the
   "Private Key filter" for the same reason. What works: make the cert with OpenSSL
   (`enclave/test-cert.cnf`; NO basicConstraints, or Windows reports `TRUST_E_BASIC_CONSTRAINTS`),
   `certutil -p <pw> -importpfx` into the MACHINE store, add it to `LocalMachine\Root`, and sign
   with `signtool sign /ph /fd SHA256 /sm /sha1 <thumbprint>`.
3. `signtool` exits with code 2 after "VBS enclave support is changing" (a warning), which MSBuild
   treats as failure; the post-build step needs `& if not errorlevel 3 exit /b 0`.
4. `$(WindowsSDKVersionedBinRoot)` is empty under Build Tools 2026, so `veiid.exe` ran as
   `"\x64\veiid.exe"`; pass `/p:WindowsSDKVersionedBinRoot=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0`.
5. A raw-API enclave (no code generator) needs: `#include <ntenclv.h>` BEFORE `<winenclaveapi.h>`
   plus a forward `typedef struct _TRUSTLET_BINDING_DATA* PTRUSTLET_BINDING_DATA;` (the SDK header
   references a type it does not declare); link the enclave CRT libs BEFORE `vertdll.lib`
   (otherwise `memcpy` is multiply defined); host links `onecore.lib` for `LoadEnclaveImageW`.
   Flags as the dev guide says: `/ENCLAVE /INTEGRITYCHECK /GUARD:MIXED /NODEFAULTLIB`, `/MT`.
6. `veiid.exe` then `signtool`, in that order, after every link.

Result (`enclave/rawhost.c` output): `IsEnclaveTypeSupported(VBS)=1`, `CreateEnclave` (256 MB),
`LoadEnclaveImageW`, `InitializeEnclave` (2-4 threads), `GetProcAddress`, `CallEnclave` all
succeed; `EnclaveGetAttestationReport` returns a 936-byte package; `EnclaveGetEnclaveInformation`
reports our FamilyId/ImageId/SVN, `Flags = 0` (not debuggable), `PlatformSvn = 2`.

Microsoft's HelloWorld sample (VbsEnclaveTooling, code generator + SDK NuGets) also built and
signed with the same fixes; its console host blocks on `_getch()` under SSH, so the raw host
above is the one we used for evidence.

## 3. The attestation chain, measured

What a node sends and what the verifier checks (`tools/verify_vbs_report.py`, 32 checks):

```
EK cert  --chains to-->  AMD root (pinned)            check 1: genuine, on-die TPM
TPM quote(nonce, PCR 7/12/13/14) signed by AIK       check 2: log is what the TPM measured
boot log --replays to--> quoted PCRs                  (PCR 0 pinned, not replayed)
boot log PCR12 SIPA fields                            check 3: VBS on, HVCI, no debug, ...
boot log PCR12 VSM_IDKS_INFO  --verifies-->  enclave report (RSA-PSS)   check 4: this enclave,
report.EnclaveData == verifier nonce, identity, Flags, modules                  this boot
```

Facts established on the box:

- **Report format** (SDK `ntenclv.h`): 24-byte package header, signed statement = 224-byte
  `VBS_ENCLAVE_REPORT` (64-byte EnclaveData, 152-byte identity) + one `VBS_ENCLAVE_REPORT_MODULE`
  per loaded module (ours listed `rawenclave.dll`, `ucrtbase_enclave.dll`, `vertdll.dll` with
  their UniqueIds), then a 256-byte signature. Scheme 1 = SHA-256 / RSA-PSS; salt length 32.
- **The signing key is the IDKS from the same boot's log.** Verification with the IDK (the
  decryption key, also in the log) fails, as does verification against the previous boot's IDKS:
  the IDKS changed between boots 62 and 64 on this box (`IDK_GENERATION_STATUS = 0`, i.e. the
  cached key is used only if its sealed blob unseals; the test-signing change altered PCRs). A
  verifier therefore needs the log of the boot the report came from, every time.
- **Log replay vs live TPM** (`tools/pcrread.c` via TBS): PCRs 1-7 and 11-14 replay exactly;
  **PCR 0 does not** (log 38eb..., TPM 711c...). AMI/AGESA extends PCR 0 with something it does
  not log (no `EV_EFI_HCRTM_EVENT` present). Policy: pin PCR 0 per firmware version.
- **Quote** (`tools/tpmquote.c`): `TPM2_CreatePrimary` of a restricted RSA-2048 signing key under
  the NULL hierarchy (no owner auth needed; ephemeral per boot), `TPM2_Quote` with a 32-byte
  nonce over PCR 0/7/12/13/14; `TPMS_ATTEST` magic/type/nonce verified, PCR digest equals
  SHA-256 of the live values, signature verifies. The AMD fTPM's `firmwareVersion` and
  `clockInfo` fields decode to odd values and are not used.
- **The verifier recomputes every SIPA record's digest** from its event data before trusting a
  field. Without that, an edited log with untouched digests replays to the quoted PCRs and lies
  (found by the tamper test; fixed).
- Negative tests, all REJECT: production policy on this dev box (test signing on, Secure Boot
  off); report replayed against the previous boot's log; report with a tampered nonce byte; EK
  certificate from a software CA; quote with a flipped PCR-digest byte; log with
  `VSM_LAUNCH_TYPE` edited to 0.

## 4. Spike (c): memory-encryption state on Windows, negative

- The boot log has no memory-encryption record. All SIPA IDs on this build decode (section 5 of
  the research notes: `SMT_STATUS`, `HYPERVISOR_BOOT_DMA_PROTECTION`, `SI_POLICY_SIGNER`,
  `VBS_VSM_NOSECRETS_ENFORCED`, `IDK_GENERATION_STATUS`, ...); the only encryption-related
  fields are pagefile and dump encryption. Grep of every string in two logs: nothing.
- CPUID 0x8000001F on the box: `SME` supported (EAX bit 0), C-bit 51, no SEV. That is
  capability, not state; TSME-enabled is `MSR C001_0010[23]`, kernel-only. No WMI class, event
  log entry, or `Win32_DeviceGuard` property reports it (hypervisor event 129 reports IOMMU
  state, nothing about memory encryption).
- The one Windows mechanism that measures it: AMD Secure Launch (System Guard DRTM) logs
  `SIPAEV_AMD_SL_TSME_RB_FUSE` (event type 0x8003) in the DRTM log. That needs a
  DRTM-capable platform (PSP + firmware + Windows System Guard), typically Ryzen PRO /
  Secured-core; this box has no DRTM events. So on Windows, memory encryption is attestable
  only through DRTM, which is exactly the class of hardware the handoff already prefers.
- On Linux the measured OS reads the MSR itself, as the handoff says; nothing here changes that.

## 5. The other verifier checks, on this box

| check (handoff sec. 4) | what the box gives | verdict |
|---|---|---|
| 1. TPM genuineness | EK cert subject empty, SAN `tpmManufacturer=id:414D4400`, issuer `CN=PRG-HPT, O=Advanced Micro Devices, OU=Engineering`, AIA -> `CN=AMDTPM` self-signed root (2014-2039), sha256 fingerprint `67BD2472A546751CACA5F358A78F80727531671338960A9BCFDFBE6A34D0C6A1`; `openssl verify` OK; OCSP at `ftpm.amd.com/pki/ocsp` | enforceable; pin the root from AMD, not from AIA |
| 2. TPM type | manufacturer id in the EK cert SAN (AMD `414D4400`, Intel `494E5443`); no Pluton on this part | enforceable; Pluton preference = Ryzen PRO / newer |
| 3. VBS/HVCI, Secure Boot, IOMMU | log: `VSM_LAUNCH_TYPE=1`, `VBS_VSM_REQUIRED=1`, `VBS_HVCI_POLICY=1`, `CODEINTEGRITY=1`; PCR 7 `SecureBoot=0` on this box; hypervisor event 129 "I/O remapping enabled, hardware present"; BUT log `HYPERVISOR_BOOT_DMA_PROTECTION=0` and no `VBS_IOMMU_REQUIRED` | VBS/HVCI enforceable now; IOMMU needs the node to set `RequirePlatformSecurityFeatures` so the log carries `VBS_IOMMU_REQUIRED`; Secure Boot must be turned on in firmware |
| 4. Enclave identity | AuthorId (from the signer), UniqueId (image hash), FamilyId, ImageId, SVN, Flags in the signed report; modules list | enforceable; publish (AuthorId, ImageId, min SVN) |
| 5. Memory encryption | not attestable (section 4) | state honestly |
| 6. PCIe link state | `Get-PnpDeviceProperty DEVPKEY_PciDevice_CurrentLinkSpeed/Width/MaxLinkSpeed/Width` works from user mode (NVMe gen4 x4, NICs gen2 x1, iGPU reports gen4 x16 fabric) | readable, but host-reported: VTL0 supplies it, the enclave cannot read config space. Raises cost, proves nothing |
| extra | `SMT_STATUS=1` is measured | usable for a side-channel policy (require SMT off, or price it) |

## 6. What VTL1 costs the masked trusted half (benchmark)

`enclave/benchhost.c` streams a 1 GB VTL0 buffer three times from inside the enclave and from
the host, same kernels (`enclave/benchkern.h`), 1/2/4 threads. Box DRAM ceiling ~58 GB/s.

| kernel | host 1 thr | enclave 1 thr | host 4 thr | enclave 4 thr |
|---|---|---|---|---|
| scalar 64-bit xor-sum | 35.7 GB/s | 1.6 GB/s (first touch) | 58.1 | 41.3 |
| AVX2 `maddubs` int8 dot | 57.1 | 56.3 | 57.9 | 56.8 |
| AVX-512 VNNI `vpdpbusd` | 55.8 | 56.6 | 56.4 | 56.9 |

- XCR0 = 0xE7 in both VTLs: the secure kernel enables AVX, AVX-512 and the ZMM state; CPUID.7
  is identical (AVX512F, VNNI present). The engine's int8 VNNI refill kernel runs unchanged.
- The 1.6 GB/s row is the first pass over the buffer from VTL1: 2.0 s for 3 GB, i.e. the
  hypervisor faulting 262k host pages into the enclave's view (~7 us/page). After that, native.
  Map the weights once and keep the enclave alive (the same "one engine" rule as the phone).
- One thread saturates DRAM. For the masked tier's refill (`u = r.W`, one pass over the public
  weights per pad batch), a 27 GB q8 model costs ~0.5 s per batch at this bandwidth, inside the
  enclave, with the weights in ordinary host memory. The enclave's own memory (256 MB here,
  512 MB in Microsoft's sample) only needs to hold pads and secrets.
- Not measured: CallEnclave round-trip latency, enclave-to-VTL0 callbacks, and behavior under a
  concurrent game (this box has no discrete GPU).

## 7. Spikes (b) and (d), from public sources (research agent, 2026-09-20; URLs in the notes)

**(b) Trusted Signing eligibility: probably yes, no longer blocked by age.** Trusted Signing was
renamed **Artifact Signing** and went GA in January 2026 (USA, Canada, EU, UK for organizations).
The "incorporated more than 3 years ago" rule was a 2025 public-preview restriction; the docs
commit of 2026-04-01 removed it, the current quickstart has no age requirement, and a Microsoft
employee answered on Q&A in August 2026 "no minimum org age restrictions". Caveats that remain:
identity validation takes 1-20 business days, failures are not explained and cannot be
expedited, and a January-2026 US LLC without a D-U-N-S number failed organization validation in
August 2026, so keep the state registration, the domain registration and the address consistent
and get a D-U-N-S number first. The **VBS enclave** certificate profile exists as a Public
Trust type ("Used to sign virtualization-based security enclaves on Windows"), the Basic SKU
($9.99/month, 5,000 signatures) includes one profile of each type, and free/trial/sponsored
Azure subscriptions are refused. The certificate carries the production Author EKU
(`1.3.6.1.4.1.311.97.<4 octets>`), is renewed daily and valid 72 hours. An Individual path exists
(US/Canada, government ID + face check) but the CN would be the person's name, not the company.

**(d) TrenchBoot upstream status: not merged, Intel only, AMD consumer parts not working.**
The Secure Launch series is at v16 (2026-05-15, 38 patches on top of v7.0); it is not in
Linux 7.1, 7.2, or the 7.3 merge window. Maintainers asked for it to be split; the first
split-out (a TPM header/`tpm-buf` reorg, July 2026) has no maintainer replies yet. Every version's
cover letter says "Intel TXT support ... AMD SKINIT is pending the common infrastructure". The
AMD SKINIT RFC (v2, April 2025) depends on that series and has not moved. GRUB's slaunch series
(v4, April 2025) is not merged either. On AMD hardware specifically: TrenchBoot's own HCL says
"AMD Zen or newer CPUs will likely not work in the current stage of development"; Zen 2+ needs
the PSP DRTM service (AMD pub 58453), which an OEM BIOS setting gates (a Framework 13 with a
non-PRO 7040 reports "DRTM Enabled = 0" with no BIOS option), and AMD markets DRTM /
Secured-core / Memory Guard as PRO features "requiring OEM enablement". Net: a Linux DRTM
appliance on consumer AMD is not available today; on Intel it means out-of-tree kernel and GRUB
patches, and vPro/TXT parts. Design A should be built without DRTM and state that SMM and early
firmware remain in the chain.

**(c) again, from the sources: no Windows indicator of TSME.** Nothing in the Windows Security
app, `Win32_DeviceGuard`, msinfo32, Azure Attestation's claim set, the SIPA log, or the Hyper-V
event log reports SME/TSME state; the 2026 press consensus after AMD's AGESA 1.2.7.0 change was
"impossible to detect on Windows". Worse for the tier: in June 2026 AMD removed the TSME option
from non-PRO Ryzen 9000 firmware (then said it would reinstate it) and described Memory Guard as
"for Ryzen PRO ... where supported in silicon"; the AGESA change also hid the SME CPUID flag, so
CPUID is not even a reliable "not supported" signal. On Linux, ground truth is
`MSR C001_0010[23]` or the PSP's `tsme_status` sysfs file (what fwupd's HSI "Encrypted RAM"
reads). The non-PRO 8945HS product page lists no Memory Guard.

## 8. What this does NOT establish, and what is next

- **Home.** This box is Pro. Microsoft gates enclaves on build and VBS only, never on edition,
  and nobody has published a Home result either way. The recipe in section 2 runs unchanged on a
  Home machine; it is a one-hour test once one is available.
- **Production signing.** Everything here is test-signed. The AuthorId in the report is derived
  from our OpenSSL certificate; a Trusted Signing (now "Artifact Signing") VBS-enclave profile
  replaces it and removes the test-signing/Secure-Boot-off requirement.
- **EK binding of the quoting key: CLOSED** (section 10). `TPM2_MakeCredential` (verifier,
  `tools/makecredential.py`) / `TPM2_ActivateCredential` (node, `windows/node/tpmattest.c`) round
  trip proven on this box; the verifier's warning is a real check with `--credential`.
- **PCR 0.** Pinned per firmware version, not replayed. A firmware update changes it.
- **Memory encryption and DRTM.** Negative on this platform (section 4).
- **The GPU half.** Untested here; the masked worker needs CUDA on a discrete card.
- **Enclave lifetime.** `DeleteEnclave` without `TerminateEnclave` returns 0; the benchmark host
  does it right.

Next steps in order: a node agent that emits {log, quote, EK, report, credential} as one
evidence bundle (the TPM half is `windows/node/tpmattest.c`); turn Secure Boot on and confirm the log flips `SecureBoot=1` and the
`HYPERVISOR_BOOT_DMA_PROTECTION` bit once `RequirePlatformSecurityFeatures` is set; run the
recipe on a Home machine; Artifact Signing.

## 9. Files

| path | what |
|---|---|
| `tools/tcglog.py` | TCG log parser: replay, SIPA decode (wbcl.h names), IDK/IDKS extraction, digest recomputation |
| `tools/verify_vbs_report.py` | the verifier (sections 3, 5); `--allow-testsigning`, `--pin-pcr0` |
| `tools/pcrread.c`, `tools/tpmquote.c` | raw TPM 2.0 over Windows TBS: PCR read; CreatePrimary + Quote |
| `../node/tpmattest.c`, `../node/build-tpmattest.cmd`, `../node/README.md` | the node's TPM tool (keys / activate / quote / pcr / log over stdin), its build, the grammar |
| `tools/makecredential.py` | `TPM2_MakeCredential` reference, pure Python (`--selftest`) |
| `tools/credential_roundtrip.py` | drives tpmattest.exe end to end; wrote `evidence/credential-roundtrip.txt` |
| `enclave/rawenclave.c` | the enclave: `__enclave_config`, `GetReport`, `Bench` |
| `enclave/rawhost.c`, `enclave/benchhost.c`, `enclave/benchkern.h` | host apps: attestation round trip; VTL1 vs VTL0 bandwidth |
| `enclave/build.cmd`, `enclave/test-cert.cnf` | the build/sign recipe and the test certificate template |
| `evidence/` | boot 64 of the test box: log, live PCRs, EK cert + AMD chain, quote, enclave report + nonce; `credential-roundtrip.txt` and the `credential-quote-*` / `credential-aik-tpmt-public.bin` files from section 10 |

Re-run the verifier on the evidence:
```
python3 tools/verify_vbs_report.py --log evidence/measuredboot-64.log --report evidence/enclave-report.bin \
  --nonce evidence/enclave-nonce.bin --quote evidence/quote-attest.bin --quote-sig evidence/quote-sig.bin \
  --quote-nonce evidence/quote-nonce.bin --aik evidence/quote-key-tpmt-public.bin --ek evidence/ek-cert.der \
  --ek-roots evidence/amd-ftpm-ek-chain.pem --allow-testsigning --pin-pcr0 711c1943ccff765a589a31b0347ce1b7356b0661f9ef7dabfbe9c622340b0433
```

## 10. EK binding closed: ActivateCredential (2026-09-21, still boot 64)

Section 8's first open item. The quoting key now provably lives in the TPM whose EK certificate the
verifier checks: the verifier wraps a random secret for (EK public, Name of the quoting key) with
`TPM2_MakeCredential`; only the TPM that holds that EK's private half, and only for that exact key,
can unwrap it with `TPM2_ActivateCredential`; the node returns the secret. Built and run on the box
of section 1 (boot 64, the boot `evidence/` comes from), elevated over SSH.

Pieces:
- `windows/node/tpmattest.c`: the node-side tool the agent drives over stdin/stdout (`keys`,
  `activate`, `quote`, `pcr`, `log`; grammar at the top of the file and in `windows/node/README.md`),
  raw TPM 2.0 over TBS, built with `windows/node/build-tpmattest.cmd`. The AIK is a restricted
  RSA-2048 signing key from `CreatePrimary` in the NULL hierarchy, made at startup and kept loaded.
- `tools/makecredential.py`: `TPM2_MakeCredential` reference in pure Python (RSA-OAEP-SHA256 with
  label `IDENTITY\0`, KDFa `STORAGE` / `INTEGRITY`, AES-128-CFB iv 0, HMAC-SHA256). `--selftest`
  checks the AES against FIPS-197 C.1 and, where `cryptography` is installed, CFB and OAEP
  against it; `openssl pkeyutl` decrypts its OAEP output with that label.
- `tools/credential_roundtrip.py`: the proof, driving the tool exactly as the agent will; the
  transcript is `evidence/credential-roundtrip.txt` (25 checks, VERDICT PASS).

Facts established on the box:

1. **The EK certificate is not in TPM NV on this AMD fTPM.** `TPM2_NV_ReadPublic(0x01C00002)`
   returns `TPM_RC_HANDLE` (rc `0x8b`); the TPM's NV index list is `0x01410001-3, 0x01800100,
   0x01810008, 0x01820002, 0x01880001, 0x01880011`, nothing under `0x01C0xxxx`. Windows fetched
   the certificate from AMD's service at provisioning (the certificate's AIA and CRL point at
   `ftpm.amd.com`) and keeps it in the registry cert store
   `HKLM\SYSTEM\CurrentControlSet\Services\TPM\WMI\Endorsement\EKCertStore`
   (`Get-TpmEndorsementKeyInfo` lists it under `AdditionalCertificates`; `ManufacturerCertificates`
   is empty). The platform crypto provider's `PCP_EKCERT` property is an `HCERTSTORE` onto that
   store (8 bytes, not DER); the tool enumerates it with crypt32 and takes the certificate whose
   DER carries the persisted EK's modulus (`ReadPublic 0x81010001`). The bytes are identical to
   `evidence/ek-cert.der` (sha256 `86b95e8a…`). The verifier need not trust this path: it accepts
   the certificate because it chains to AMD's root and because of fact 4. Also seen: persistent
   handles `0x81000001, 0x81000002, 0x81000009, 0x81010001` (the EK); `TPM_PT_NV_BUFFER_MAX` 1024.
2. **Endorsement auth.** `Tbsi_Get_OwnerAuth(TBS_OWNERAUTH_TYPE_ENDORSEMENT_20)` returns a 20-byte
   value to an elevated caller (the tool prints only the length; the registry's `EndorsementAuth`
   string is empty, so it is not stored there in the clear). The TPM accepted it:
   `TPM2_CreatePrimary` under `TPM_RH_ENDORSEMENT` with the TCG default template (RSA-2048,
   SHA-256 name, attributes `0x000300B2`, policy `8371…69aa`, AES-128-CFB, unique = 256 zero
   bytes) -> rc 0, EK Name `000b71ce…0506`, and the key's modulus is the certificate's
   (`ek-cert-match yes`), which also shows this template is the one the certificate was issued
   against. The persistent-handle fallback was not needed.
3. **PolicySecret + ActivateCredential.** Unsalted, unbound SHA-256 policy session;
   `TPM2_PolicySecret(TPM_RH_ENDORSEMENT)` with that auth -> rc 0;
   `TPM2_ActivateCredential(AIK: password session with the empty auth; EK: the policy session with
   an empty hmac field)` -> rc 0, and the recovered 32 bytes equal the credential
   `makecredential.py` wrapped (`d17976ff…fc0f` in the recorded run; an earlier run with
   `fd0d8a22…6627` passed the same way). The empty hmac field is what Part 1 19.6.5 allows for
   an empty HMAC key; the tool's fallback (HMAC with the empty key over cpHash) never ran.
4. **Negative.** The same credential wrapped for a different Name -> `TPM2_ActivateCredential`
   rc `0x9f` = `TPM_RC_INTEGRITY`. The blob is bound to the quoting key's Name, so a node cannot
   answer with any key other than the one it quotes with.
5. **Quote, verified two ways.** Random 32-byte extraData; the RSASSA-PKCS1v15-SHA256 signature
   verifies with the AIK public (integer arithmetic in the driver); `TPMS_ATTEST` magic/type
   right; PCR selection sha256 {0,7,12,13,14}; `pcrDigest` == sha256 of the PCRs read live through
   the same tool; `qualifiedSigner` == `0x000B || sha256(TPM_RH_NULL || Name(AIK))`, which pins
   the quoting key to the NULL hierarchy (a verifier can require this). Then
   `tools/verify_vbs_report.py` on that quote against the boot-64 log, with the new
   `--credential` / `--credential-expected` flags: ACCEPT, 32 checks; "quoting key is bound to
   the EK" is a PASS instead of a warning.
6. **Return codes seen.** TPM: `0x8b` (NV_ReadPublic on the absent index), `0x9f` (the deliberate
   foreign-name activation); everything else 0. TBS: none (`Tbsi_Get_OwnerAuth` succeeded). In
   every run the AIK Name the TPM returned from CreatePrimary equalled sha256 of the TPMT_PUBLIC
   (the tool refuses to start otherwise).

Command lines (box: `ssh minipc-zt`, PowerShell 5.1, elevated; everything under
`C:\Users\claude\vbs\tpm\`):
```
scp windows/node/tpmattest.c windows/node/build-tpmattest.cmd windows/vbs/tools/makecredential.py \
    windows/vbs/tools/credential_roundtrip.py minipc-zt:C:/Users/claude/vbs/tpm/
ssh minipc-zt 'cmd /c C:\Users\claude\vbs\tpm\build-tpmattest.cmd'
ssh minipc-zt 'python C:\Users\claude\vbs\tpm\credential_roundtrip.py --exe C:\Users\claude\vbs\tpm\tpmattest.exe --out C:\Users\claude\vbs\tpm\credential-roundtrip.txt'
scp minipc-zt:C:/Users/claude/vbs/tpm/credential-roundtrip.txt windows/vbs/evidence/credential-roundtrip.txt
```
Local re-verification of the recorded quote (its attest, signature, nonce and AIK public extracted
from the transcript into `evidence/credential-quote-*.bin` and `evidence/credential-aik-tpmt-public.bin`):
```
python3 tools/makecredential.py --selftest
python3 tools/verify_vbs_report.py --log evidence/measuredboot-64.log --report evidence/enclave-report.bin \
  --nonce evidence/enclave-nonce.bin --quote evidence/credential-quote-attest.bin --quote-sig evidence/credential-quote-sig.bin \
  --quote-nonce evidence/credential-quote-nonce.bin --aik evidence/credential-aik-tpmt-public.bin --ek evidence/ek-cert.der \
  --ek-roots evidence/amd-ftpm-ek-chain.pem --allow-testsigning --pin-pcr0 711c1943ccff765a589a31b0347ce1b7356b0661f9ef7dabfbe9c622340b0433 \
  --credential d17976ff0e22dff21b5bebe5c47e59929d3112b6834d63b5709606807a6dfc0f \
  --credential-expected d17976ff0e22dff21b5bebe5c47e59929d3112b6834d63b5709606807a6dfc0f
```

What this still does not establish:
- The relay's JavaScript `TPM2_MakeCredential` (`relay/vbs-verify.mjs`, not touched here) has to
  produce blobs this TPM accepts; `makecredential.py` is the reference and its `--json` output
  with a fixed credential is the fixture to compare against. Nothing here exercises the relay.
- Only this AMD fTPM was tested. Intel PTT keeps the certificate in NV `0x01C00002`, which is the
  tool's first path and is untested; the cert-store path is what AMD boxes will use.
- The AIK is ephemeral by design (NULL hierarchy, one per process, nothing persisted, nothing to
  steal); every agent session redoes `keys` and `activate`.
