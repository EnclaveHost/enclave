# Lease consumer seams: INCOMPLETE. Two actual root runs FAILED. Product NOT approved, no runtime change applied

**Why this record exists:** it protects, under source control, all r1/r2 prepared code, tests, jobs and manifests,
and the complete actual failure evidence of root runs **0114** and **0121**, while a fix is pending.
- **What it is not:** it does not approve the product. No runtime change was applied anywhere.
- **Original failures:** recorded exactly as they occurred. No test was skipped, removed or reclassified.
- **r3 is not covered:** root's r3 preparation (50cf) is active and unfinished. It is **not** included, read, or
  represented here.

## Run 1: `root-lease-consumer-seams-0114`, rc 1 (`## INVALID: bundle rebuild`)

**Dir:** `actual/r1-run-20261026T010814Z-342931/`.

**What failed:** the **original relative-`node_modules` fixture failed before the candidate was tested**.
- **Cause:** the bundle rebuild could not resolve `esbuild` (`ERR_MODULE_NOT_FOUND`), both in `base-bundle-check.out`
  (`windows-check-rc=1`) and in `candidate-bundles.out`.
- **Base run:** `base.tap` (rc 1) ran 7 test files, **0 pass, 7 fail**. Every file failed to load, so this is a
  fixture failure, not a product result.
- **Candidate:** never tested.
- **Queue:** cap 1792 MiB; peak 965 MiB; minimum host available 22341 MiB.

## Run 2: `root-lease-consumer-seams-r2-0121`, rc 1 (`"ok": false`)

**Dir:** `actual/r2-run-20261026T011308Z-350377/`; the verdict is in `verdict.json`.

**Dependencies fixed:** `deps-before` and `deps-after` manifests are identical, and the `package-lock` files are
unchanged.

**Bundle build and checks: PASS** (`candidate-bundles.out`, `candidate-bundles.sha256`). On base, the Windows bundle
check gives rc 1 and the metal check rc 0.

**Test results (the full TAPs are included):**

| Run | Tests | Pass | Fail | Cancelled / skipped / todo |
| --- | --- | --- | --- | --- |
| Candidate (`candidate.tap`) | 66 | **61** | **5** | 0 |
| Base (`base.tap`) | 66 | **55** | **11** | 0 |

**Verdict failures, exactly as recorded:**
- "candidate process must exit0";
- "candidate not clean";
- "base failing set differs".

**Queue:** cap 1792 MiB; peak 941 MiB; minimum host available 22232 MiB.

**The candidate's 5 failures (recorded, not reclassified):**

| # | Test | Also fails on base? | Reading |
| --- | --- | --- | --- |
| 1 | `Windows: verifier authority routes lease reads to the verifier only; ENCLAVE_LEASE_GAS_RPCS is never contacted` | yes | `the lease read went to the verifier (contacted: )`: **the Windows calls did not reach any RPC** |
| 2 | `Windows: legacy (no chain authority) keeps the configured lease RPC quorum (…)` | yes | the same: no call reached an RPC |
| 3 | `gsup: the legacy path is untouched; the direct branch runs only for metal.control=direct` | yes | a **pre-existing baseline assertion, stale** |
| 4 | `the shared loader: pinned relays may be the ONLY route; partial or invalid refuses; absent keeps the exact configuration` | yes | a **pre-existing baseline assertion, stale** |
| 5 | `gsup and the launcher wire the conduit, and only the conduit` | **no (candidate only)** | an **intentional gsup call change**; the assertion **needs an updated test** |

**What is positive:** the candidate's mixed-configuration tests (source, bundle and runtime refusal and acceptance
cases) pass where base fails. Base fails 7 tests that the candidate passes.

**What is NOT shown:** **there is no routing proof.** The Windows tests that would show lease reads reaching the
verifier (and never `ENCLAVE_LEASE_GAS_RPCS`) failed, because no call reached any RPC. The two stale baseline
assertions and the one gsup assertion still fail as recorded. They need new reviewed work and a new actual run; this
record changes none of them.

## Contents (bounded text; no work clones, `node_modules`, binaries or caches)

| Path | Contents |
| --- | --- |
| `r1-stage/` | the r1 prepared stage: README, `ROOT-REVIEW.md`, `prior-root-review/`, `jobs/`, `seams.patch`, `base/`, `candidate/`, `test/`, `BASE-FILES.sha256`, `SHA256SUMS` |
| `r2/` | r2 README, `jobs/root-seams-test-r2.sh`, `SHA256SUMS` |
| `actual/` | `root-lease-consumer-seams-0114.{out,rc,guard}` and `root-lease-consumer-seams-r2-0121.{out,rc,guard}` |
| `actual/r1-run-…/` | every top-level file of the r1 run |
| `actual/r2-run-…/` | every top-level file of the r2 run, including the full TAPs, `verdict.json`, the resolve and deps outputs, the lock files and the bundle hashes |

- **Stage manifests:** `r1-stage/SHA256SUMS` and `r2/SHA256SUMS` verify in place (checked).
- **Excluded:** the `work/` clone trees under each run (about 1.3 GB each) are not copied.
- **TAP sizes:** every TAP is under 2 MiB, so all are complete:

  | TAP | Size | sha256 |
  | --- | --- | --- |
  | r2 `candidate.tap` | 113 KB | `30cd6898…` |
  | r2 `base.tap` | 49 KB | `17be149a…` |
  | r1 `base.tap` | 10 KB | `6ada91e5…` |

**Verify:** `sha256sum -c SHA256SUMS` covers every file.

**Status:** **INCOMPLETE; NOT approved.** Lease consumers stay on HOLD, and Custody v2 stays REFUSED.
