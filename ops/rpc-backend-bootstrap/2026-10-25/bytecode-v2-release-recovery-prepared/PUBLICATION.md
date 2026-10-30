# base-bytecode-check receipt v2: release runner for the MEMORY-RECOVERY test job (release candidate BUILT and PASSED; NOT run on any real DB)

**Source and evidence only.** This publication contains no build tree, cargo cache, target or binary, and not the 516 KB cargo JSON. Those are recorded by sha256 in `EVIDENCE-SHA256.txt`. The actual release receipts and the release-log files are included.

| Item | State |
|---|---|
| Original native test attempt `root-bytecode-v2-native-2249` | **FAILED (OOM, rc 143)**, recorded in `bytecode-v2-prepared` (`7d926055e`, unchanged). **It is never used as a receipt here.** |
| Recovery test job `root-bytecode-v2-recovery-2259` (same product source; fixture-only `tests.rs` `f1bd5c1c`, 64 MiB geometry) | **PASS:** 23 tests, zero ignored, and 17 exact negative controls. See `bytecode-v2-recovery-validated`. |
| Release binary (root `root-bytecode-v2-release-2303`) | **PASS, rc 0** (outer rc 0, `[queue] EXIT 0`, guard `[memory-guard] exit=0 peakTreeRssMiB=714 minHostAvailableMiB=21769`). Artifact sha256 **`b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7`**, size **1276048**, `fresh=false`, opt-level 3 (debug assertions, overflow checks and test all false), 418 compiled artifacts, all inside the verified closure. The usage smoke test was refused as required. This is a live-run **candidate only** (`release-evidence/release-manifest.json`). |
| Receipt-checker tests | **11 tests passed** (`Ran 11 tests … OK`, the first part of `receipts/root-bytecode-v2-release-2303.out`). The actual 2259 recovery receipt was accepted: out `aae989a6…`, 23 tests, 17 controls, patched test binary `dae90e38…` (`release-evidence/test-receipt.json`). `evidence/receipt-checks-prefix.out` is kept unchanged: it was extracted while the job ran and is a byte-exact prefix of the final `.out`. |
| Real database scan | **NOT done.** The binary has not been run on any datadir. A live read-only run on the stopped datadir at N (after A2–A4) under root review is still required. |
| A2 | `BYTECODE_CHECKER_V2_SHA256` stays **`None`**. |

## Contents

`release/` is a byte-identical copy of `finality-stage/bytecode-v2-release-recovery`:
- `root-release.sh` `bf5c47e7…`;
- `check_test_receipt.py` `86b2a5be…`;
- `test/test_check_test_receipt.py` `d5c46f83…`;
- `README.md` `7ef36fa8…`;
- `inputs/RELEASE-STAGE-SHA256SUMS` `1c4b407e…` (verifies 4/4 here).

## Acceptance rule (summary)

- **Accepted only:** the recovery job's actual output with:
  - the recovery label and a passing precheck;
  - the single final `## aggregate rc=0`;
  - 23/23 named tests `ok`;
  - 17 controls each failing exactly their pinned set;
  - the lock and closure lines;
  - the outer rc file `0`, one `[queue] EXIT 0`, and a guard log ending `[memory-guard] exit=0`.
- **Also required:**
  - product pins equal to the original v2 product;
  - the restored member source.
- **Refused:** the original 2249 receipt (sha `2a5aca4e…`) and any receipt pin naming 2249.

## Digests

The v2 receipt digests are **framed keccak-256** (definition in `bytecode-v2-prepared/PUBLICATION.md`), not sha256.

## Evidence (actual root files; sha256 of every source in `EVIDENCE-SHA256.txt`)

- **`receipts/`:** `root-bytecode-v2-release-2303.out` (`ad747af4…`), `.rc` (`0`), `.guard`, and the root-written `PASSED-TEST-RECEIPTS.sha256` that the release consumed. It pins 2259 `.out` `aae989a6`, `.rc` `9a271f2a` and `.guard` `adb8e265`; those receipts are published in `bytecode-v2-recovery-validated`.
- **`release-evidence/`:** the release log and manifest (`06c88f03…`), plus:
  - `artifact.json` (profile fields, 418 compiled);
  - `test-receipt.json`;
  - `usage.out` (`Error: "usage: base-bytecode-check <datadir>"`);
  - `release.comment.txt` (rustc 1.96.0, LLD 22.1.2);
  - `tree-compare.txt` (only `Cargo.lock` differs from `git archive 5476069f`);
  - `verify_inputs.out` (lock `91a9e762`, 648 packages, `problems=0`);
  - `cargo-tree.release.txt`/`.err`;
  - `release.build.err`.
- **Not copied** (sha only):
  - the binary;
  - `closure-manifest.json`, byte-identical to the pinned `e901720a`;
  - `release.build.json` (`8397c299…`).

`release/` stays the byte-identical **as-prepared** copy of the runner, its README (which still says "NOT run") and the tests. The results are those above.

## Actual Ubuntu launch validation

The pinned release passed all four launch/refusal cases on the Ubuntu RPC guest in a private network-disabled 256 MiB transient unit. Unit exit 0; peak 1.2 MiB. Evidence and the reviewed launcher are in `ubuntu-abi/`. No real database was opened or scanned; the A2 pin remains unset.
