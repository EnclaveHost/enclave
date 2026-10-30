# rpc-runtime-composition-stage/r3: corrected composition CANDIDATE + seam + stack tests (private; nothing run, built, committed upstream or pushed)

| item | what |
|---|---|
| `src.git` | private repo: r2's refs + `refs/src/consumers-seam` aebf4c932 + `refs/r3/{stage2,candidate}` (`REFS.txt`) |
| `tools/linemerge.py` | line-provenance block classifier/merger (STALE / ROUTE-UNIQUE / ROUTE-REMOVED / LINEAGE-ONLY) |
| `tools/build-r3.py`, `decisions/` | stage 2 = r2 RESOLUTIONS + reviewed overrides for the 4 blockers, 6 drop files, supervisor.js, install-host.ps1 -> `RESOLUTIONS-r3.json` |
| `tools/build-seam.py` | stage 3 = the root-passed seam (receipt f6c5369b) on exact base 81ba66853, 4 explicit resolutions -> `SEAM-RESOLUTIONS.json` |
| `stack-tests/` | 4 new real-module composed-stack tests + recording helper (copied into test/ by the job) |
| `jobs/r3-regenerate-validate.sh` | root job (queue 2560): regenerate all bundles in order, determinism + --check, component parity, stack tests, tri-state |
