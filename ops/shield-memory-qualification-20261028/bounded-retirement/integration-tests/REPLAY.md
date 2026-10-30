# Replay

The exact test was executed from `work/rpc-production-final-20261025/shield-memory-20261028/steady-memory-r1/integration-test-prep`. Its sibling `backend-rebuild-r1` contains `RESULT.json` plus the byte-reproduced backend in `src/`; sibling `candidate` contains the unchanged candidate header.

For a fresh checkout, create a disposable scratch parent. Copy this directory to `<scratch>/integration-test-prep`, copy `../candidate/shield-original-source.hpp` to `<scratch>/candidate/`, and copy `../backend-provenance/RESULT.json` to `<scratch>/backend-rebuild-r1/`. Extract the tracked `../backend-provenance/backend-source.tar.gz` in a separate scratch directory and copy its `wasm/ggml-shielded` directory to `<scratch>/backend-rebuild-r1/src`. Do not extract into any production path.

The runner checks every backend source hash and the candidate hash. Exact engine headers/libraries and the compact root at paths recorded in RESULT.json are required; missing prerequisites fail, not skip. Their retained local paths are external build dependencies, not included libraries. Run `node --test test/bounded-retirement-integration.test.mjs` from the scratch integration directory through the shared memory queue, with 1GiB cap, no swap, core dumps disabled and CPU/network isolation. Do not run against a live model or GPU. This only tests synthetic data.

See ROOT-REVIEW.md for the initial fixture failure, its measured explanation and all-eleven-scenario passing rerun. No production source changed.
