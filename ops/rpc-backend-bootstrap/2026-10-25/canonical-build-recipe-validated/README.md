# canonical-build-recipe-stage: source-rebuild linkage for the canonical Helios CLI (PREPARED 2026-10-26; nothing run)

Gap (77d6cc859 and the integration candidate): `scripts/rpc-runtime/build-binaries.sh` exports only ef320298 and builds
the Helios CLI from it UNPATCHED, while `closure.json` `purpose` says it builds every current pin. This candidate makes the
source tree able to rebuild the accepted CLI's source: eeffcc9 + the exact canonical-block.patch 41667ec9 in its own tree.

| path | what |
|---|---|
| `candidate/` | 9 files vs 77d6cc859 = the integration's 5 (3 byte-identical; closure.json + docs edited further) + `scripts/rpc-runtime/{build-binaries.sh, canonical-block.patch, canonical-block.PATCHED.sha256, verify-patched-tree.py}` (`CHANGED-FILES.txt`, `SOURCE-FILES.sha256`, `candidate.diff`) |
| `tools/make-candidate.py` | regenerates the 5 integration-derived files from the pinned integration copies with counted closure/doc edits |
| `tests/test-build-recipe.py` | 11 stub-cargo plumbing tests (STUB CARGO ONLY; real rustc --version, git archive, tarball, patch apply, tree verifier) |
| `jobs/recipe-tests.sh` | root job: precheck, candidate tree scope, T (stub tests), R1 REAL `check` (cargo metadata --locked --offline, no compile) + R2 77d6cc859 control |
| `jobs/native-cli-dev-build.sh` | separate, NOT approved: one native dev CLI build with the candidate recipe (digest expected to differ from 8250f08a) |

Root: `./jobs/q-exit-status.sh canonical-build-recipe-tests-1 1024 unshare -rn bash canonical-build-recipe-stage/jobs/recipe-tests.sh` (accept only `## rc=0`).
