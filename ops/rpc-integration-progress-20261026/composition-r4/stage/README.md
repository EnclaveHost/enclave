# rpc-runtime-composition-stage/r4: build-provenance fix for the SAME r3 candidate (prepared; nothing run)

Candidate unchanged: refs/r3/candidate c4de37a3 in the frozen r3/src.git (read only). r3, its run r3-20261026T014716Z, its
manifests and ROOT-REVIEW.md are untouched and pinned (R3-PINS.sha256).

| file | what |
|---|---|
| `jobs/r4-build-validate.sh` | the full root runner: A static precheck (also `--precheck-only`), B checkouts with in-tree closures, C image exports, D bundles, E component tests, F stack tests, G closure identity after |
| `tools/deps-identity.py` | lock identity (version + integrity per package, only optional packages absent, nothing extra) + closure treehash |
| `DEPS.txt` | the checked closures: root / network / relay node_modules treehashes (identical locks in all 6 heads) |
| `GENERATORS.txt` | pinned blobs of the 6 generators, locked-inputs.mjs and relay/build-network.mjs |
| `R3-PINS.sha256` | the frozen r3 inputs the runner refuses to run without |
