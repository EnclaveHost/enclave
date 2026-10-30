# base-finality-proof-stage/r10-capture-fixture-fix (PREPARED; nothing run by Claude). Frozen r10 untouched; no product code or pin change.
Fixture-only correction of r10 tests/test_capture_r10.py (integration/test_capture_r10.patch): CaptureR10.cap() now seeds self.tpl
(the stub a1-read.mjs reads cfg.fixtureReceipt = self.tpl) for mode 'initial' with the SAME TA.fresh_a1 receipt TI.captures() writes
(N = NP, root = CHAIN outputRoots[NP]). Every assertion is unchanged (guest port 18999 in both modes, verify/recheck/expected sha,
non-loopback refusals, mandatory python_identity / node_identity). Root job: jobs/root-r10-capture-fixture-fix.sh (header has the command).
Report: ../../logs/claude-r10-capture-fixture-fix.md. A pass here is NOT an r10 overall pass; the test must be integrated in a final source stage.
