# Original Base checkpoint recheck — tested, not production activation

Current evidence: 2026-10-25 21:53 UTC. This supersedes the explicitly historical preparation note.

The helper re-proves eligibility of the ORIGINAL game/checkpoint at a newer Helios-finalized Ethereum block. It never substitutes the latest anchor or accepts descendants. It uses only the local pinned Helios light client and our Ethereum execution/consensus services; no public RPC fallback.

## Verified results

- Corrected offline suite: 27 tests passed, zero skipped. All ten source-weakened controls failed by genuine assertions. Full logs and TAP verdicts are retained.
- Actual read-only run at 21:53 passed: initial receipt SHA `b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c`, original Base N **52,866,960**, game `0x343b3a99527af07d2cfb2652747b9e37715e21ac`, root `0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700`.
- Fresh finalized L1 block **26,272,420**, hash `0x2c30e28c599697c0ed0ebb07e4bfc96747875dae6bf373df32954b00c590a3f3`: 14 Helios calls and three independently verified Merkle Patricia proofs. Portal/registry/game code and proxy pins match the original observations.
- Latest anchor observed at N **52,869,960**; explicitly NOT accepted. The original N/root remains the bootstrap target.
- First live attempt refused on a 20-second own-Helios call timeout. Retried once with UNCHANGED source, timeout, configuration and initial receipt; second run passed in about 77 seconds. Both attempts retained. Temporary Helios processes stopped after each run.
- Earlier offline run failed 1/27 because the freshness fixture changed the number but not its header. Corrected fixture retained alongside the failed evidence; no verification rule weakened.

## Limits and remaining rollout

This is an A1 eligibility recheck, not authenticated full Base state, blob-history coverage, safe/finalized Base derivation, SNP attestation or production RPC replacement. The initial code/proxy pins were observations, not independently approved implementation versions. Trust remains relative to the pinned Helios checkpoint and Ethereum light-client model.

A2-A4 original-game receipt integration is being prepared separately and is NOT deployed or accepted by the current A2 gate. Native bytecode validation and live state rebuild remain pending. Receipt freshness must be re-established at use time; this archived result is not perpetual permission to start derivation.

No production service, administrator control or consumer configuration changed. The runner requires a new output directory, verifies the initial receipt hash, limits execution and stops its own Helios process. Scripts contain workstation absolute paths and record the procedure actually executed; they are not a portable deployment package.

`SHA256SUMS` covers source, fixtures without private keys, all retained tests, and both live receipts. `HISTORICAL-PREPARATION.md` is retained for context; its pending-test status is superseded here.
