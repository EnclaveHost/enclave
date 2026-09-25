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

## The paravisor's VM report (per app partition): what the verifier will require

Each line maps to the contract's requirement (R1-R7) and is NOT ESTABLISHED.

| check | contract | prerequisite before it can run |
|---|---|---|
| V1. The report's signature verifies under the IDKS public key taken from the host's replayed boot log, and that log comes from a quote accepted as above, in the SAME boot | R6, R7, trust root | real report bytes; IDKS-signs-the-VM-report is a hypothesis until they verify (d1 O3) |
| V2. The boot state is accepted (Secure Boot on, test signing off, no debug), from the same quote | trust root | met on boot 68 for the host quote (d1, VERIFIED); never waived |
| V3. The launch digest is one of the PINNED paravisor images with a measured Linux VTL0 (kernel, initrd, command line) from enclave-53's reproducible build; the probe firmwares and any debug image refused. Windows' own firmware-load policy is no identity: under Secure Boot, Hyper-V loaded our UNSIGNED control IGVM with AllowFirmwareLoadFromFile set (d1, boot 68), so the host can load any IGVM and only the launch digest names what ran | R4, R5 | a VBS IGVM with a measured Linux VTL0 (not built; d1 O2) |
| V4. Debug and host-trusting images are refused by the EXACT pinned launch digest, never by a flag. enclave-53 measured (2026-09-25, three pinned images, package `windows/vbslike-pkg` 18f17084): igvmfilegen's VBS identity document says `endorsement.build_info.debug_build: false` for images built with `--confidential-debug` exactly as for non-debug ones (it follows the manifest's enable_debug, not `OPENHCL_CONFIDENTIAL_DEBUG=1`, which makes OpenHCL trust the host's command line and turns off confidential diagnostic filtering). Only `vbs_boot_digest` separates a candidate from its debug twin. The allowlist is therefore enclave-53's reference file, PINNED by commit and hash (`verifier/pins/nucbox-vbs-reference.json` from `windows/vbslike-pkg` 840eb861, sha256 b0541f13...; `verifier/nucbox-reference.mjs` `eligibleDigestsOf`): today exactly one digest, the rebuilt measured-VTL0 candidate A0FDAC0F...BCA244 (not booted yet); refused by exact digest are its confidential-debug twin A650C020... (debugBuild false), the a7b0bd4 control and debug images, the stock image, and the superseded pre-review pair 246DEE1B.../0677F3C6...; a file that marks any of those eligible is refused outright, and debugBuild is never read (`test/verifier-nucbox-reference.test.mjs`). A report-level debug indication, if the report has one, is an additional refusal, never a substitute for the digest pin | R5 | report bytes from a booted candidate; where debug is visible in the report (open question) |
| V5. The report data binds, by measured code, the verifier's fresh nonce, the hash of the guest-held TLS key, the appId and the runtimeId (the ABI/2 binding), and the TLS key is the one of the verifier's own handshake | R1, R2 | the guest-to-paravisor report path over guest data (vTPM NV index candidate, parked) |
| V6. The binding request is authenticated to the measured instance: a report over host-chosen data is refused | R3 | the same path, and a measured VTL0 (today's medium is unmeasured: d1 O4) |
| V7. Replay and cross-VM refused: the nonce is this verifier's and fresh; a report of another partition (another ledger deployment) is refused | tests required | report bytes from two VMs; how the report names the partition (open) |
| V8. The verdict never claims host exclusion: `host_excluded` comes only from d1's separate host-memory evidence (E3, parked), never from a boot state or a report | direction | E3 |

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
