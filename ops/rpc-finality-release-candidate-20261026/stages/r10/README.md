# base-finality-proof-stage/r10: final deployable composition, r9 + runtime-pin + root's r9/canary repairs (PREPARED; UNRUN; productionActivated=false)

The report is `../../logs/claude-finality-r10-result.md`. `bundle/` is assembled by `tools/assemble_bundle.py` and is excluded from `SHA256SUMS`; every bundle entry (including the authentic L1 checkpoint config) is sha-pinned in `install/MANIFEST.json`.
`COMPOSITION.tsv` names every file's origin (r9 or runtime-pin copy, edit with `integration/<name>.patch`, or new); `jobs/root-finality-r10-tests.sh` re-verifies all of it before running any suite.
The guest canary update for 6d24 is `CANARY-R3-RECIPE.md` (the same capture bytes this stage tests). Installation requires root's passing r10 run (`## finality-r10 rc=0`, `## r10 SHA256SUMS <sha>`).
