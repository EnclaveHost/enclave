# historical-capture-deployment-stage (r2 of this stage; the failed 1286 draft is kept under logs/draft-1286/)

The relocatable exact-N historical capture bundle (`bundle/`, bundleId = sha256 of `bundle/MANIFEST.json`).

- `src/`: the entrypoint `historical-capture` and the guest runner `guest-capture.sh`.
- `tools/build_bundle.py`: the deterministic builder from sha-pinned inputs.
- `patches/`: the only code changes to r4/r5 src (path resolution).
- `tools/freeze.sh`: the stage freeze/check (excludes SHA256SUMS and logs/).
- `jobs/root-historical-capture-offline.sh`: root's offline qualification (shared queue 1024, `unshare -Urn`).
- `jobs/root-guest-capture-runner.sh`: root's host-side runner for the guest capture (shared queue 4096, host floor watchdog, remote cleanup).
- `tests/test_capture_runners.py`: orchestration tests of both runners (recording fakes; not evidence).
- `ACCEPTANCE-INTEGRATION.md`: the r17 wrapper/readiness integration recipe.

The full description, runbook and limitations are in `logs/claude-historical-capture-deployment.md`. PREPARED: nothing in this stage has run live, and Claude ran no tests.
