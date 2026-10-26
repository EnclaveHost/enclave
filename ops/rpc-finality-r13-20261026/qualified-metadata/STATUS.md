# Qualified metadata and live canary inputs

Candidate 80cea88861f069540bd6d4214cdcd9e2020c897558f7dd4badcf572edecccd60 changes only the manifest stage label from the full-qualified f58b0b4f candidate. All 109 other tracked input files are byte-identical. Actual targeted qualification verifies this identity, reuses the pinned actual full-suite receipt, checks all source/bundle closure, passes 18 installer tests, and runs the unchanged canary assembler with both success and stale-input refusal cases. It does not bypass the assembler stage check.

The original-game and systemd canaries now bind those exact qualified files. Original-game live validation is in progress; these bindings are not successful live receipts and authorize no production activation. Private chain captures are not included here.

The schedule reader passes 14 offline tests including the source schedule hash vectors, anchor contradictions, malformed ABI, unknown upgrades and forged results. Its loopback Helios adapter and compiled config pin still require actual accepted-domain integration and live validation. A branded JavaScript result alone establishes no external attestation. Native derivation compilation, real witnesses, finality, production consumer cutover and outage/restart evidence remain incomplete. Administrator rights are preserved.
