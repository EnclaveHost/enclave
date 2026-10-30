# base-finality-proof-stage/restart-review (PREPARED; design review only)

The parent stage stays **FROZEN**: its `SHA256SUMS` (`e21761c2…`) lists the files outside this directory and is unchanged.
This directory adds design text only:
- no code;
- no tests;
- no change to the launcher, harness or M10;
- no execution.

- `DESIGN.md`: the traced crash/reboot behaviour today (fail closed, no recovery path), the recommended re-anchor restart R-A
  with its exact missing source changes, the rejected fast resume R-B, the A1 producer capture-provenance gaps, a correction of
  the earlier "no newer finalized game" wording, and a note on root's 26/27 fixture failure.
- `SHA256SUMS`: pins both files.

**Status:**
- **Restart qualification is NOT integrated.**
- **Flags:** `FINALITY_PROOF_REVIEWED`, `LAUNCH_PRODUCER_REVIEWED` and `FINALITY_PROTOTYPE_REVIEWED` all stay False.
- **Root test job:** none for this revision; there is no code to test.
