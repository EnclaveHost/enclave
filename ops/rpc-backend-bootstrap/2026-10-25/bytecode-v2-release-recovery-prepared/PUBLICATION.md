# base-bytecode-check receipt v2: release runner for the MEMORY-RECOVERY test job (PREPARED source; PENDING)

**Source only.** This publication contains no build tree, cargo cache, target or binaries; completed receipt-check output is included.

| Item | State |
|---|---|
| Original native test attempt `root-bytecode-v2-native-2249` | **FAILED (OOM, rc 143)**, recorded in `bytecode-v2-prepared` (`7d926055e`, unchanged). **It is never used as a receipt here.** |
| Recovery test job `root-bytecode-v2-recovery-2259` (same product source; fixture-only `tests.rs` `f1bd5c1c`, 64 MiB geometry) | **PASS:** 23 tests, zero ignored, and 17 exact negative controls. See `bytecode-v2-recovery-validated`. |
| Release binary | **BUILD RUNNING:** the actual passing recovery receipt was verified and pinned. No release result yet. |
| Receipt-checker tests | **11 tests passed.** The actual recovery receipt was accepted. `evidence/receipt-checks-prefix.out` contains the completed pre-build checks only, extracted from the running job; it is not a complete release receipt. |
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

## Will be added only from root's actual files

Test receipts and the release manifest will be added only from root's actual files after 2259 and the release run. Nothing is fabricated or assumed.
