# Release lab, phase 1: the guest path on real SEV-SNP (2026-09-25, PASS)

Run: `~/enclave-bench/lab-release/phase1-run-20260925c` (18:30:55Z–18:31:20Z) by
`isolation/m2/lab-release/run-lab.sh` at 04d01086, with `LAB_SESSION` = the phase-2 session's pins and
`LAB_DOMAIN_RELEASE_ID=6d18f7ad…ad0f`. The image-affecting tree was frozen at 5ce7ced6 (the c15f5850 image; lab front
f7bec291). The files here are copied from that run. Synthetic keys and the synthetic release file are NOT included.

## What it proves (run.txt, relay.log, egress.log)
- A REAL per-app SNP guest (instance lb23abf9ff, this tree's front under `-tags releaselab`) booted and waited for its
  ticket. The lab guestd (-release, prefix lb, lab ports 19444/19445) handed it; the pump's role was played by the
  harness.
- The guest reported with the RELEASE binding and dialled egress through the lab router (vsock 19443, "guest 191641
  egress open (lab relay)"). It completed TLS pinned to the lab relay's name and CA.
- The lab relay released. It used enclave-99's secrets-release.mjs for the binding, seal and signature, and
  relay/snp-verify.mjs verifyQuote for the VCEK chain to the pinned ARK (no KDS), TCB Turin {fmc 1, bootloader 3,
  tee 2, snp 5, microcode 117} checked, VMPL 0, the policy, and report_data == the release binding. It re-read
  [0:32] and [32:64] and HOST_DATA itself.
- The guest VERIFIED the relay's response signature under its pinned lab key, opened the seal, derived an allowlist of
  4 origins with 0 refused, and handed init 1119 bytes of ENCLAVE_CONFIG ("DOM release: …", "DOM app config: …").
- The app (api-mcp-adapter, the pinned component) served on the RELEASED config: tools/list 200 with the synthetic key,
  401 with none, and 401 with a wrong one.
- guestd's image measurement equals `expected-measurement.sh --pin 6d18f7ad` over the same bundle: the image
  reproduces from the pinned release.
- No synthetic secret value appeared in any host-side file: guestd root and logs, the serial console, the units'
  journal, the relay and router logs.
- The production m2-gd* units were unchanged (prod-units-before/after.txt).

## What it does NOT prove (LAB, stated)
- The allowed measurement was **guestd's build-time computation**: sev-snp-measure over the image guestd itself
  built, taken before the guest reported. That is the HOST's computation, labelled LAB. Phase 1 therefore says
  NOTHING about admission independence. Phase 2 (enclave-99's real handleRelease and predictor over the pinned lab
  release) is the evidence for that.
- The relay's ticket skipped the operator, lease and chip checks, which are the relay's and are tested there.
- The app bundle was built by hand (`bundle build`), not derived from the catalog. Phase 2 derives it.

## Earlier attempts, in the same session
- 18:27Z FAILED at the lab relay: verifyQuote was missing its `challenge` (fixed in 5ce7ced6). The same run exposed
  that the lab release 1428c0c4 was stale for this tree (c15f5850 changed the front after it was checked); the release
  was rebuilt as 6d18f7ad.
- 18:29Z FAILED: the first run's relay had been left running (a subshell without exec), and the guest reached it
  (fixed in 212365f6). The reproducibility check passed in that run.
- In all three runs the guest failed CLOSED when its release was refused ("the app is not started"), and production
  was unchanged.
