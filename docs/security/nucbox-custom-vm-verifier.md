# NucBox custom type-1 isolation: the verifier's side of the contract

Dated 2026-09-25. Owner of this file: the verifier lane (verifier/ and the relay's verification path). The contract it
answers is enclave-5d's `isolation/m3/PARAVISOR-ATTESTATION-CONTRACT.md` (at 1e5d3ae1); the evidence ledger is
enclave-d1's `windows/vbslike/evidence/PROOF-CHECKLIST.md` (branch `windows/custom-vbs-like-hyperv`); enclave-53 owns the
measured build and its pins.

**Direction (Steven, relayed by enclave-d1, 2026-09-25).** The custom type-1 path, a Hyper-V partition per app with our
measured paravisor and guest, is the ONLY target for NucBox app hosting and node integration. The ee-engine VBS-enclave
backend is not restored or production-signed; test signing stays off; Secure Boot is on (boot 68). `host_excluded=no`
until evidence supports admission. No legacy enclave report may stand in for a custom-VM report.

**Status: nothing here admits anything.** No paravisor report bytes have been captured, the report's signer (IDKS) is a
hypothesis, and no measured guest image exists. Every check below is NOT ESTABLISHED until it runs on real bytes.

## What the verifier does today (tested)

- `windows-vbs-enclave/v1` (the retired backend): `unsupported` in the Node and browser builds, the verdict naming the
  backend RETIRED and saying a VBS-enclave report never stands in for a custom-VM report. The document exactly as the
  node agent built it (the whole evidence, boot log included, in `body`) is refused over the body cap before that.
- `hyperv-partition-domain/v1` (the launcher-signed T0-hv document): `unsupported`; the host is not excluded by contract.
- `windows-hv-node/v1` (enclave-5d's proposed node attach, below): registered as `unsupported` here, technology
  `windows-tpm-host`, `hostExcluded: false`: the relay judges it and it is never a confidential-compute verdict.
- Any other name, including every candidate name for the paravisor's VM report: `unsupported` as an unknown format.
- No consumer path (CLI `attest`, the enclave self-check, the relay's re-verification, the site shadow) requests Windows
  evidence at all.
- Tests: `test/verifier-nucbox-legacy-refused.test.mjs` on the REAL boot-64 enclave evidence from nucbox-k11
  (`test/fixtures/vbs/boot64-evidence.json`), and a registry scan that fails if any Windows format becomes
  `supported: true`; `test/verifier-hyperv-domain-refused.test.mjs`.

## The node's attach evidence: `windows-hv-node/v1` (enclave-5d's proposal, the relay's half is this lane's)

What it can prove, stated before it exists: the node's tunnel transport key is held by a process on a machine whose
genuine on-die TPM measured an ACCEPTED boot state, in this boot, for this relay's nonce. The node IS the host, so it
proves nothing about excluding the host, and it makes no TEE claim.

The relay will require (review sent to enclave-5d on 2026-09-25):
1. EK certificate chaining to the pinned AMD fTPM root; the credential round trip (the quoting key lives in THAT TPM).
2. A quote over PCRs {0, 7, 12, 13, 14} by that key; the TCG log replaying to the quoted {7, 12, 13, 14}. PCR 0 is quoted
   and recorded, but it has NO independent pin (a value read from this box is not a pin; enclave-d1), so the verdict
   states "platform firmware not independently attested" as an omission and never passes it.
3. The production boot state, with NO dev demotion: Secure Boot on (PCR 7), TESTSIGNING 0 in every section, the
   VBS_REQUIRED_PCR12 set (VSM and hypervisor launched, VSM required, HVCI, code integrity; no boot, kernel or hypervisor
   debugging, SafeMode, WinPE or flight signing). `METAL_VBS_ALLOW_TESTSIGNING` is not honoured.
4. The binding: bound = `"enclave-hv-node-bind-v1\n" || spki (44-byte Ed25519) || nonce (32) || sha256(statement)`;
   the quote's extraData = sha256(bound); an Ed25519 signature of the transport key over bound (possession).
5. The result: tier `hv-node`, technology `windows-tpm-host`, measurement null, no TEE badge, `hostExcluded: false` set by
   the relay; the node's /health summary kept as `hostStatement`, never read for admission. The row stays ineligible
   for isolated app hosting.
6. A same-boot record: the boot counter, the IDKS modulus sha256 from the log, the quoted PCRs, the EK and AK names, so a
   later paravisor report can be required to verify under THIS boot's IDKS.
7. In the same change, `windows-vbs-enclave/v1` refused at the relay's dispatch as a retired backend.

Tests before any deploy (relay changes on main deploy to production): the real boot-68 frame from the node's
`tpmattest` verified end to end; each of d1's negative controls refused; the real boot-64 legacy evidence refused as
retired and, re-presented as hv-node, refused on its boot state (Secure Boot off, test signing on); d1's seven negative
controls (windows/vbslike/verify/tpmquote/quote-verify.mjs: replay under a new nonce, a quote-body bit, a signature bit, a
credential never minted, one minted for another AK name, a PCR 12 record byte, an unpinned EK root) refused; a foreign
spki, a missing or wrong possession signature, a truncated log, and a quote without PCR 0 refused. The real bytes:
enclave-d1's boot-68 capture, `windows/vbslike/evidence/quote-20260925-053931/` on `windows/custom-vbs-like-hyperv`
(e97c967b): EK certificate, the AK public and name (a NULL-hierarchy primary: the same name for every run within a boot,
new each boot; enclave-d1), the activation reply with the recovered credential, the quote,
PCR 0, the boot-68 log (8ee177c4...), and the nonce and minted credential published after the session. The module is
shipped on `relay/deploy.sh`'s list and imported dynamically with an OFF fallback.

**Built, not wired (2026-09-25).** `relay/hvnode-verify.mjs` `verifyHvNodeEvidence` implements the checks above on
enclave-5d's frame (`windows/node-hv-identity` at 852f3c1d: `rad.transportKey`, body `{proves, statement, signature, log,
quote, credential, ek, pcr0, platform}`, the statement being the exact UTF-8 JSON or the 4 bytes `null`), reusing the
relay's EK, credential, quote and log primitives; `retiredFormat()` names `windows-vbs-enclave/v1` as retired.
`test/hvnode-verify.test.mjs` (5): the REAL boot-68 session (`test/fixtures/hvnode/boot68-2026-09-25`, copied from
enclave-d1's dbe615b0 with a hash-checked source record) passes every TPM and boot check in capture mode, is never
admissible as a recording, records the boot-68 IDKS (402f2281...01a9), and refuses each of d1's seven negative controls at
the named check; the real boot-64 legacy evidence re-presented as hv-node is refused on Secure Boot and test signing even
with a test-signing flag; synthetic full transcripts verify and are admissible, with the statement bound and recorded,
the "null" statement accepted, a statement claiming host exclusion changing nothing, and refusals for replay, a foreign
key, a missing or wrong possession signature, a statement swapped after binding, the retired VBS transcript (domain
separation), Secure Boot off, test signing on (flag ignored), kernel debugging, HVCI off, a quote without PCR 0, a
truncated log and a missing mint record. Five deliberate regressions (test signing or Secure Boot unchecked, possession
skipped, PCR 0 not required, the statement unbound) each fail the suite.

**The real full transcript (2026-09-25).** enclave-d1 ran enclave-5d's `windows/node/ops/hvnode-capture.mjs` on the box
(boot 68, 06:11:16Z; pinned at `test/fixtures/hvnode/capture-20260925-061116` from c54eea70): the node's own
`windows-hv-node/v1` frame with a throwaway capture key, verified by the relay module in NORMAL mode, all 31 checks passing
and equal to the verdicts d1 recorded on the box, the boot-68 IDKS and the same NULL-hierarchy AK as the independent
session; d1's six negatives (replay, a quote-body bit, a possession-signature bit, another transport key, a never-minted
credential, a substituted statement) each refused (`test/hvnode-verify.test.mjs`). It is a CAPTURE: the nonce and the
credential were generated in the same process on the box, so it is real-TPM evidence for the verifier, not an independent
challenge. Every result now states its `scope`: "host attach only: a host-attested boot state; never tenant capacity,
never an isolation or TEE label".

**Wired, switch OFF (2026-09-25).** `relay/tunnel.js`: a `windows-vbs-enclave/v1` attest is refused by name before
anything else (`retiredFormat`), whatever the relay's policy holds; the vbs-keys credential round and a
`windows-hv-node/v1` attest run only when the hub has `attest.hvNode` (the relay sets it from `RELAY_HVNODE_ATTACH`, with
the pinned EK roots `relay/fixtures/tpm-roots.pem`; unset in production); a verified node binds as mode and tier
`hv-node` with no measurement and no pad key, and its row carries `hvNode: { hostExcluded: false, tee: null, omissions,
bootCounter, idksModulusSha256, verifiedAt }` while the node's statement stays in the hub. `relay/api-relay.js`: the
retired `METAL_VBS_*` policy is no longer read (a startup line says so if set) and an hv-node row is ineligible with "host-
attested boot state (TPM quote: Secure Boot on, test signing off); no isolation evidence, the host is not excluded".
`relay/local-hub.mjs` attaches a node to a workstation on the same path. `test/relay-hvnode-consumer.test.mjs` runs the
REAL relay process with the switch on (EK roots from `RELAY_HVNODE_EK_ROOTS`, tests and labs only) and a synthetic node
that claims capacity and the retired VBS-enclave TEE in its availability and "snp" in its hello: `/enclaves` lists it as
mode hv-node, not serving, not eligible, with the host-attested reason, its capacity out of the aggregate, and the site's
`teeCpuOf`/`computeEligibleOf` give it no TEE and no eligibility; the retired format and a relay without the switch refuse.
Tests: `test/tunnel.test.mjs` (the full
handshake, the retired format refused on a relay still holding the lab test-signing policy, the switch, and every
refusal), `test/tenant-compute-eligibility.test.mjs` (an hv-node row is never capacity and never a verified TEE, even
when its availability still names the VBS enclave), the deploy-closure guard (checked by mutation: the new module off the
deploy list fails it). Before the switch is turned on: the node side deployed and its availability no longer naming
`windows-vbs-enclave`, the site labelling an hv-node row explicitly as a host-attested boot state, and Steven or
enclave-5d asking for it.

## Launcher statements: the partition's boot form has ONE name (decided 2026-09-25, asked by enclave-d1)

The two launchers named the linux-direct partition differently: the Rust `wmiserve` (`windows/custom-vbs-like-hyperv`
8f156c9a), which SIGNS the launcher report, says `platform.partition = "wmi-openhcl-gen2-igvm-linux"` for `--igvm-sha256`
and `"wmi-openhcl-gen2"` for `--medium-sha256`; the manager's launcher (`windows/isolation-manager` `wmi-launcher.mjs`
`linuxDirectIdentity`) said `"wmi-openhcl-gen2"` for both, with `guestImageKind` telling them apart. A judge comparing
the manager's handle with the report would have refused every linux-direct domain.

**The signed report's names are canonical**, because the signed report is what a verifier holds. The manager adopts them
and keeps `guestImageKind` as a second field that must agree through a FIXED pairing; a judge compares both fields for
exact equality and refuses anything else, including an unknown value on either side:

| partition (canonical, signed) | guestImageKind | boot form |
|---|---|---|
| `wmi-openhcl-gen2-igvm-linux` | `igvm-linux-direct` | the kernel, initrd and command line are measured pages of the IGVM (the only form that can ever carry an isolation claim) |
| `wmi-openhcl-gen2` | `uefi-medium` | UEFI boots our medium, which is NOT measured: never an isolation claim, whatever else passes |

Neither name is identity. Both are launcher statements (the monitor-signed T0-hv tier, `host_excluded=no`); what a
partition RAN is established only by the paravisor report's launch digest against the pinned allowlist (V3), never by
the partition name, the image kind or the launcher's `--igvm-sha256` argument.

### What the launcher's signature binds: the PARTITION, not a domain (2026-09-25, raised by enclave-d1)

From source (`windows/custom-vbs-like-hyperv` ad61cb02, `host/src/wmiserve.rs`): the report service on hv_sock 9001
accepts a peer only when its VM GUID is this partition's. It takes `report_data` (bind 32 bytes || app 32 bytes) from the
REQUEST, and signs when the app half is one this launcher loaded into this VM. It cannot know which in-guest process
asked. So the property domprobe states ("a compromised domain can only ever name ITSELF") belongs to the MONITOR. It
holds only while the monitor is the only in-guest path to 9001. A domain that dials 9001 itself can obtain a
launcher-signed report naming ANY app the launcher loaded into that partition, with a bind of its own choosing.

Observed, as a hypothesis only (enclave-d1, run 093904 on b7ba7731): domprobe's connect to host CID 2 port 9000 TIMED
OUT rather than being refused inside the guest. So a domain can start an hv_sock connection to the host, and no in-guest
policy is known to deny domains AF_VSOCK. The 9001 route itself is untested: it needs a domprobe route, which is
enclave-5d's source and paused with Steven.

How it is weighed:

1. **A single-app partition** (`hyperv-partition-per-app`: one wmiserve load per partition, and control port 9000 is
   dialled only by the host). The direct path gives a domain nothing the monitor would not. The only loaded app is its
   own, and the bind half is the requester's choice on both paths. This is not a finding against that backend.
2. **A partition holding MORE THAN ONE domain** (the neighbour-probe lab, or any future multi-app partition). A
   launcher-signed report binds (partition, one of the apps loaded into it), NEVER a domain, so it is never evidence of
   which domain holds the bound key. The launcher's own loaded list cannot establish "one domain" either: a domain
   loaded raw over 9000, such as the probe, is invisible to it.
3. **The verifier.** The launcher-signed document stays `unsupported`, because the host is not excluded by contract.
   Nothing changes today. If it is ever read for per-app routing on the lab tier, it must come with a measured-image
   (monitor) statement that the partition runs exactly one domain, and without one it is refused.
4. **Guest-local containment acceptance** (enclave-d1's Judge-Probe) cannot PASS while the 9001 route is unprobed.
   "Host signer 9001: not probed" is INCONCLUSIVE, never a pass.
5. **The fix at the source, when unpaused.** Domains get no AF_VSOCK (or AF_HYPERV) sockets, through a seccomp filter in
   domexec or a cgroup sock_create hook, so only the monitor reaches 9000 and 9001. The test: domprobe to CID 2 port 9001
   is DENIED (EPERM or EACCES), with a positive control in the same run (the monitor's own dial connects). A timeout is
   not a denial.
6. **The paravisor path (V5) has the same shape.** Its report_data comes from the vTPM, so a domain must not reach
   /dev/tpm*. The 1539 image's domprobe opens return ENOENT, which means absent from the domain's view. Their existence
   in the root namespace is unshown until the monitor's stat statement exists.

## The paravisor's VM report (per app partition): what the verifier will require

Each line maps to the contract's requirement (R1-R7) and is NOT ESTABLISHED. An image's ELIGIBILITY in the pinned
reference file (V3) is prospective and is not evidence of anything a report would prove: no report, key binding or
identity is verified until real report bytes pass every check below.

Source facts behind the checks (enclave-d1, read from the pinned openvmm a7b0bd4; `windows/custom-vbs-like-hyperv`
c193a558; facts about the source, not evidence): OpenHCL obtains the report through the hypercall HvCallVbsVmCallReport
(0xC001, "Request a VBS VM report from the host VSM", `openhcl/hcl/src/ioctl.rs:1343`), so the SIGNER is on the host's
secure-kernel side, not in our paravisor. The layout is `hvdef/src/vbs.rs` VbsReport, 0x230 bytes: a package header with
`signature_scheme` and `signature_size` (values the source does not name), `report_data[64]`, an identity (owner_id,
measurement, signer, host_data, enabled_vtl, `policy.debug_allowed`, guest_vtl, svn, product and module ids), then
`signature[256]` (the size of an RSA-2048 signature, IDKS's: consistent with the IDKS hypothesis, no more). OpenVMM's
own non-Hyper-V backend answers 0xC001 with a DUMMY report of 0xCD bytes (`vmm_core/virt_whp/src/hypercalls.rs:695-702`).

| check | contract | prerequisite before it can run |
|---|---|---|
| V1. The report's signature verifies under the IDKS public key taken from the host's replayed boot log, and that log comes from a quote accepted as above, in the SAME boot. NOTHING parsed from the report (measurement, report_data, `debug_allowed`, any identity field) is read before the signature verifies. Refused: a report that is not exactly the VbsReport size; an unknown `signature_scheme` or `signature_size`; a `signature_size` that does not match the IDKS key; a signature that does not verify, explicitly including an all-0xCD dummy report (OpenVMM's non-Hyper-V answer) | R6, R7, trust root | real report bytes; IDKS-signs-the-VM-report is a hypothesis until they verify (d1 O3); the scheme and size values are named only by real bytes |
| V2. The boot state is accepted (Secure Boot on, test signing off, no debug), from the same quote | trust root | met on boot 68 for the host quote (d1, VERIFIED); never waived |
| V3. PREDICTION, not evidence: the report's `identity.measurement` equals the IGVM launch digest (`vbs_boot_digest`, 58DFEBFE... for a44bb55a). If real bytes disagree, V3 must name the field that does carry the launch digest, never loosen the comparison. The launch digest is one of the PINNED paravisor images with a measured Linux VTL0 (kernel, initrd, command line) from enclave-53's reproducible build; the probe firmwares and any debug image refused. Windows' own firmware-load policy is no identity: under Secure Boot, Hyper-V loaded our UNSIGNED control IGVM with AllowFirmwareLoadFromFile set (d1, boot 68), so the host can load any IGVM and only the launch digest names what ran | R4, R5 | a VBS IGVM with a measured Linux VTL0 (not built; d1 O2) |
| V4. Debug and host-trusting images are refused by the EXACT pinned launch digest, never by a flag. enclave-53 measured (2026-09-25, three pinned images, package `windows/vbslike-pkg` 18f17084): igvmfilegen's VBS identity document says `endorsement.build_info.debug_build: false` for images built with `--confidential-debug` exactly as for non-debug ones (it follows the manifest's enable_debug, not `OPENHCL_CONFIDENTIAL_DEBUG=1`, which makes OpenHCL trust the host's command line and turns off confidential diagnostic filtering). Only `vbs_boot_digest` separates a candidate from its debug twin. The allowlist is therefore enclave-53's reference file, PINNED by commit and hash (`verifier/pins/nucbox-vbs-reference.json`, now enclave-63's v37 at `windows/vbslike-pkg` 37673a05, sha256 ba3f49a7... (v31 fb1bb0e6 was THE ROLLOVER; v33 adds the G4 probe image CF339BC5..., refused by its digest; v35 records that the probe booted once and never served; v36 stages the next candidate 1539, 56FBB27F..., clean but NOT eligible until its own canary, and its debug twin 8E9D6ACB...; v37 records that 1539 booted and served in that canary, still NOT eligible: the rollover is a later version that also supersedes a44bb55a; the allowlist is unchanged); every earlier pin recorded; `verifier/nucbox-reference.mjs` `eligibleDigestsOf`): today exactly one digest, the G1 measured-VTL0 candidate a44bb55a... with launch digest 58DFEBFE...343A (booted under Secure Boot, served its pinned app through its own TLS, and its per-boot nonce held: enclave-d1's canary 070020, evidence 7b509d16; the report path not exercised, so nothing about identity is established); refused by exact digest are its confidential-debug twin 2A93ED16..., the superseded previous candidate c567e432... (A0FDAC0F..., booted and served in canaries 061934/062450, no report ever verified) and its twin A650C020..., the a7b0bd4 control and debug images, the stock image, and the superseded pre-review pair 246DEE1B.../0677F3C6...; a file that marks any of those eligible, or marks two images eligible, is refused outright, and debugBuild is never read (`test/verifier-nucbox-reference.test.mjs`). Rollover (agreed with enclave-63): exactly one eligible digest at a time; a new candidate is listed eligible:false with a reason until its own canary boots and serves, and the version that flips it supersedes the previous candidate in the same change. A report-level debug indication, if the report has one, is an additional refusal, never a substitute for the digest pin | R5 | report bytes from a booted candidate; where debug is visible in the report (open question) |
| V5. The report data binds, by measured code, the verifier's fresh nonce, the hash of the guest-held TLS key, the appId and the runtimeId (the ABI/2 binding), and the TLS key is the one of the verifier's own handshake | R1, R2 | the guest-to-paravisor report path over guest data (vTPM NV index candidate, parked) |
| V6. The binding request is authenticated to the measured instance: a report over host-chosen data is refused | R3 | the same path, and a measured VTL0 (today's medium is unmeasured: d1 O4) |
| V7. Replay and cross-VM refused: the nonce is this verifier's and fresh; a report of another partition (another ledger deployment) is refused | tests required | report bytes from two VMs; how the report names the partition (open) |
| V8. The verdict never claims host exclusion: `host_excluded` comes only from d1's separate host-memory evidence (E3, parked), never from a boot state or a report | direction | E3 |

### V5 in detail: the report data (checked by enclave-5d against a7b0bd4; SOURCE ONLY, 2026-09-25)

From enclave-5d's reading of the pinned openvmm a7b0bd4. No report bytes have been seen on this path, the signer is still
the IDKS hypothesis, and whether a type-1 VBS partition serves this NV path on the box is open. The report data is NOT the
ABI/2 binding itself: the guest's 64 bytes sit one level down, inside a JSON document whose hash is the report data.

1. The guest writes its 64-byte input to the vTPM NV index TPM_NV_INDEX_GUEST_ATTESTATION_INPUT (platform-manufacturer
   base + 0x2; ATTESTATION_REPORT_DATA_SIZE = 0x40, `tpm_device/src/lib.rs:92`; an unset index reads as zeros,
   `:1141-1152`). For V5 that input is `Bind2(SPKI, nonce, runtimeId) (32) || AppID (32)`, the same 64 bytes the other
   tiers carry in their report data, written by measured code in the guest.
2. When the guest reads TPM_NV_INDEX_ATTESTATION_REPORT (base + 0x1), the paravisor builds the runtime claims
   (`openhcl_attestation_protocol` `get.rs:339-392`, `RuntimeClaims::ak_cert_runtime_claims`):
   `{ "keys": [the vTPM's AK and EK as RSA JWKs], "vm-configuration": {...}, "user-data": lowercase hex of the input }`,
   serialised with `serde_json::to_string` (`underhill_attestation` `igvm_attest/mod.rs:357-362`: struct field order,
   kebab-case, compact).
3. `report_data (64) = SHA-256(those exact claims bytes) (32) || 32 zero bytes` (`mod.rs:146-185`, runtime_claims_hash
   zero-padded to REPORT_DATA_SIZE), passed to tee_call (`underhill_core` `emuplat/tpm.rs:54-101`, TeeType::Vbs on type 1).
4. What the guest reads back from the report index is the IgvmAttest request structure, VERSION_1, "the stable structure
   exposed to the guest via NV index" (`emuplat/tpm.rs:86-93`): it carries the hardware report AND the claims bytes.

The structure the guest reads back (`igvm_attest/mod.rs:269-332`; layout `get.rs:74-86, 140-153, 197-208`), VERSION_1,
with NO extension struct: `IgvmAttestRequestBase { header { signature, version, report_size, request_type, status,
reserved[3] }, attestation_report[ATTESTATION_REPORT_SIZE_MAX], request_data { data_size, version, report_type,
report_data_hash_type, variable_data_size } }`, then the claims bytes. The claims length is stated twice, so it is checked
both ways. VERSION_1 is the one to pin: the NV-report path always uses it; only the AK-certificate request takes the
current version.

The verifier's rule, AFTER V1 (the signature) and never before it:
- the structure, strictly: `header.report_size == sizeof(Base) + variable_data_size`; `request_data.data_size ==
  sizeof(IgvmAttestRequestData) + variable_data_size`; `request_data.version == 1`; `report_type == VBS_VM_REPORT (1)`;
  `report_data_hash_type == SHA_256`; the first VBS_REPORT_SIZE bytes of `attestation_report` are the report and the REST
  of that fixed array is zero (a zeroed struct with the report copied in, `mod.rs:298-302`); the claims are exactly
  `variable_data_size` bytes after the base. The NV index has a fixed allocation, so a read may return padding after
  `report_size`: take `report_size` bytes and require anything read past them to be zero (to settle on real bytes);
- take the claims bytes EXACTLY as carried; never re-serialise the JSON (serde's field order is not a canonical form to
  depend on);
- require `SHA-256(claims) == report_data[0:32]` and `report_data[32:64] ==` 32 zero bytes;
- parse the claims strictly (UTF-8, one JSON object, no duplicate keys: serde emits each field once at every level, and
  `"user-data"` exists only at the top, always present on this path, so a legitimate document never trips it) and require
  `"user-data"` to be exactly 128
  lowercase hex characters equal to `hex(Bind2(SPKI, nonce, runtimeId) || AppID)`, with SPKI from the verifier's own TLS
  handshake, nonce the verifier's fresh one, runtimeId and AppID from the pinned expectations;
- treat `"keys"` (the vTPM's AK and EK: the vTPM state is host-readable on this box, enclave-5d's finding) and
  `"vm-configuration"` (host-supplied, including `current-time` from the HOST's clock: never a freshness proof) as
  statements only: nothing admits on them. Freshness is the verifier's nonce, and only the nonce.

What a report binds, stated (`tpm_device/src/lib.rs:1141-1152, 1396-1411`, REPORT_TIMER_PERIOD 2 s at `:97`): the input
index is read at RENEWAL, not at write. A renewal happens at the start of a read of the report index, only if more than
2 s have passed since the last one; inside that window the read returns the PREVIOUS report, bound to the input present
at the previous renewal, and a renewal that errors is only logged, the read again returning the previous contents. So a
report binds "the input present at the last successful renewal", not "the last write": measured code that needs a fresh
report writes the input, then reads more than 2 s after its previous read. The verifier's fresh nonce makes every stale
case FAIL, never pass.
Refusals to test on real bytes when they exist: a claims document whose hash is not report_data[0:32]; non-zero
report_data[32:64]; user-data of the wrong length or case, or for another nonce, key, AppID or runtimeId; a structure of
another version; claims with a duplicate "user-data"; a report bound to the PREVIOUS nonce (a read within 2 s of the
last renewal); header or request-data lengths that disagree with `variable_data_size`; a non-zero byte in the rest of
`attestation_report` or after `report_size`; a `report_type` or `report_data_hash_type` other than the pinned ones.

The verdict states when it exists: `verified` only with V1-V7 all passing on the non-debug control platform in one boot;
never `limited` for a missing hardware root; `rejected` naming the failed check; `unsupported` until the format is agreed
and the positive control and the refusals of the contract's "Tests required" pass on real bytes. The format will be
registered in `verifier/envelope.mjs` only then, with those bytes pinned as fixtures, and the registry scan test updated
in the same change.

## Consumer integration, in order, each behind its own switch

1. The relay: `windows-hv-node/v1` attach (above), recorded and shown as a host-attested boot state, no capacity label.
2. The relay: per-app admission on a verified paravisor report (V1-V7), a switch that stays OFF until the evidence above
   exists and Steven decides admission; `host_excluded` stays `no` in every record until E3.
3. The CLI's `attest` and the site shadow: the same verdict, shown beside the existing ones, never replacing a primary.

No Windows path is added to the CLI, the self-check or the site before step 2 has real evidence.
