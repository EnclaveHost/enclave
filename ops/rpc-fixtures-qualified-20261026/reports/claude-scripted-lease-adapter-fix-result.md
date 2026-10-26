# P6 scripted lease adapter fix: result (PREPARED; test-only; nothing run, built, queued or committed)

**Stage:** NEW `scripted-lease-adapter-fix-stage/` (`SHA256SUMS` sha256 `c4308777a803144d2b876a248740e5b2500d21c68414176631db21936b9b9c60`).
- **Inputs:** the r12 candidate `debbfb37`, read through git objects only (`GIT_OPTIONAL_LOCKS=0`), and r12's receipts. The work used a /tmp scratch, since deleted.
- **Untouched:** previous reports and stages, including `final-source-composition-plan-stage-r2`, whose `SHA256SUMS` still verifies. No product or runtime file changes.

| File | sha256 |
|---|---|
| `patches/windows-lease-scripted-fixture-exports.patch` | `c0acd7b329a9899c5ecc53c14a183cdf589aa006b6b0b7ae4b9c955cd259f6b6` |
| `jobs/root-scripted-adapter-fix.sh` | `402757f095e1c3f6b733bdd834a29292ade3150688973e0f9d5b7933828b3d53` |
| `SOURCE-PINS.txt` | `a215add4a20f61bab07296cee9bf98651b0a74d45e4ef467244cdd8cbabf3e40` |

## The actual failure (exact r12 receipts)
- **r12 final** (`regress--final--test_windows-node-lease-renewal-keeper.test.mjs.out`, sha256 `a446a6dd…734e`, bound in `receipts/RECEIPTS.tsv:192`):
  - `SyntaxError: The requested module './lease-gas-runtime.bundle.mjs' does not provide an export named 'chainAuthorityFromEnv'`;
  - result `tests 1, pass 0, fail 1`; the whole file failed at import.
- **r12 route** (sha256 `907c8240…391d`): 16/16, nothing skipped. This is the count source.
- **The cause:**
  - The test's `registerHooks` redirects `chain.mjs`'s `./lease-gas-runtime.bundle.mjs` to `test/helpers/windows-lease-scripted-fixture.mjs` (blob `7f953dbe`).
  - That adapter exports 4 names.
  - `windows/node/chain.mjs:36` (blob `3d0311e4`, unchanged) imports 6 names, including `chainAuthorityFromEnv` and `refusingChainAuthority`.
  - The real bundle exports both (`Pl as chainAuthorityFromEnv`, `Bw as refusingChainAuthority`).
- **Other consumers:** `git grep` at the candidate finds **only** `test/windows-node-lease-renewal-keeper.test.mjs` using this adapter. The runner re-checks that.

## The patch (minimal, test-only; the same form as P3)
- **What it adds:** two pass-through exports of the real functions, `export const chainAuthorityFromEnv = real.chainAuthorityFromEnv;` and the same for `refusingChainAuthority`, with a two-line comment.
- **What stays the same:**
  - the scripted `claim/renew/release/renewLeadMs`;
  - `openReleaseJournal` from the real bundle;
  - every test assertion.
- **Patched blob:** `6832c9fd372d0272c4a7f91e10de7cf686d242fa` (sha256 `329e2fec…f684`).
- **Static checks done here:** `patch` reproduces the reviewed file exactly, and `bash -n` passes.

## Root runner (`jobs/root-scripted-adapter-fix.sh`, cap **1024**)
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/scripted-lease-adapter-fix-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-scripted-adapter-fix.guard -- unshare -rn bash $ST/jobs/root-scripted-adapter-fix.sh > $ST/logs/root-scripted-adapter-fix.out 2>&1; echo $? > $ST/logs/root-scripted-adapter-fix.rc
```
- **Setup:** offline (no route), with a private TMPDIR and PATH `/usr/bin:/bin`.
- **Checks before running:**
  - the stage and r12 `SHA256SUMS`;
  - the 3 candidate blob pins;
  - the adapter's only consumer is this test.
- **Unpatched evidence is reused, not rerun:** the exact r12 final and route receipt bytes, the stale-export line, the 16/16 counts and the RECEIPTS binding are all checked.
- **Test tree:** a private `git archive` of debbfb37 plus the three dependency closures, each checked against r12 `DEPS.txt` with r12's `deps-identity.py`. Then the patch is applied and the patched blob checked.
- **Why no forge, anvil, artifacts or network-runtime build:** the static closure is 50 source files, using `fake-base-rpc.mjs` and viem, with no rig, no `contracts/foundry/out` and no `network-enroll.mjs`. **So the receipt is a valid single-patch replacement in the composition.**
- **Test command:** r12's exact command, `node --test --test-reporter=tap --test-timeout=300000 test/windows-node-lease-renewal-keeper.test.mjs`.
- **PASS** = rc 0 and exactly `tests 16 = pass 16`, with fail, skipped, todo and cancelled all 0. The job prints `## scripted-adapter rc=0`.

## For the r2 composition plan (not edited; frozen)
- **What changes:** this closes the P6 gap. In `final-source-composition-plan-stage-r2/GATES.txt`, the `P6-scripted-adapter-fix` line can then point at this job's rc/out files.
- **How to apply it:** as a NEW plan revision, or as root's edit at review. The renewal-keeper row then reuses this receipt rather than a composed rerun, because its closure has none of P1–P4.
- **Sequence:** apply P6 after P3, in the same test-only class.
- **Root's finding (not re-verified by me):** the audit raw `ok:false` is exactly the single post-test pyc, and root's `root-cache-assessment.json` verified that the frozen run was not mutated.

## Not claimed
P6 has not been run, so 16/16 is the expectation, not a result.

## Correction to earlier reports (those files left unchanged)
The source cutover **IS authorized by the user, but NOT qualified.** The earlier phrase "not authorized" (in `claude-final-source-composition-plan-result.md`, `claude-final-source-composition-r2-result.md`/`HOLDS.txt` and the preservation README) was wrong. The qualification holds stand: the gates HOLD with no accepted release, no verifier or backend receipts, and no canary protocol.
