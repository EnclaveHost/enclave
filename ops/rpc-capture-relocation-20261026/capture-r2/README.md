# historical-capture-deployment-stage/r2: harness fix of root's failing 1305 offline run (production bundle unchanged)

**Failing receipts preserved:** `logs/root-historical-capture-1305.out` and `../logs/run-20261026T124322Z-1731089/`. The parent stage (SHA256SUMS 7f3fb478) is unchanged.

**Two harness defects fixed in `jobs/root-historical-capture-offline.sh`:**
1. **Scratch emptiness:** the old check `ls -A d1 d2` prints directory headings even when both are empty. It is replaced by an actual `find -mindepth 1` inventory written to `scratch-contents.txt`, which must be empty.
2. **`test_segments` OPS read:** `test_old_activation_code_rejects_every_new_document` reads `OPS/chain_service.py`, where OPS = the relocated TEST copy's `vendor/`. The legacy wrapper 75c879ec is now copied there, into the TEST copy only, and pinned. The job also asserts that no production bundle copy contains it.

**Unchanged:**
- `bundle/` is a **byte-identical copy of bundleId 020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e**. The job diffs it against the parent and rebuilds it with the parent's frozen builder.
- These are copied verbatim from the parent: `jobs/root-guest-capture-runner.sh`, `tests/test_capture_runners.py`, `tools/freeze.sh`, `ACCEPTANCE-INTEGRATION.md`. They resolve paths relative to r2, so the runner verifies r2's freeze.

**Note:** the parent's own `tools/freeze.sh --check` now reports a file-set mismatch, because r2/ is nested inside it. The parent's 29 entries still verify with `sha256sum -c`, and the r2 job checks exactly that. Use r2's runner for the guest.
