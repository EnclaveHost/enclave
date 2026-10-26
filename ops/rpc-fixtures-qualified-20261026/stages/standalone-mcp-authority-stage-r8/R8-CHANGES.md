# standalone-mcp-authority-stage/r8: test-only diagnostic (P8) and continuation runner (PREPARED; nothing run by Claude)

**Frozen:** r7 and its run `r7/run/20261026T040635Z`, plus r6, r5 and r2. The product is unchanged: b6ac5d657, the r2 patch, and `cli/enclave.mjs` (identical in base and candidate).

## Root's actual r7 (`logs/root-mcp-authority-r7-0407`, rc 1, peak 692 MiB)
| Row (EXPECTED-TAP) | tests | pass | fail | skip/cancel/todo |
|---|---|---|---|---|
| candidate mcp-independent-verifier | 9 | 9 | 0 | 0 |
| candidate mcp-independent-unit | 10 | 10 | 0 | 0 |
| candidate mcp-independent | 13 | 13 | 0 | 0 |
| candidate chain-authority | 10 | 10 | 0 | 0 |
| base mcp-independent-unit | 10 | 10 | 0 | 0 |
| base mcp-independent | 13 | 13 | 0 | 0 |
| candidate cli-combined-independent | 4 | 3 | **1** | 0 |
| base cli-combined-independent | 4 | 3 | **1** | 0 |

**Total: 71/73.**

**The 2 failing rows:** both are subtest 4 (`dispatch: … --signer-mode needs --independent`), at `test/cli-combined-independent.test.mjs:170`.
- **The test expects** `/--signer-mode apply to independent mode: add --independent/`.
- **The CLI prints** (`cli/enclave.mjs:5214`, `configureIndependent`), in both trees, `error: --quorum, --confirmations, --max-block-age, --usdc-token, --max-fee-gwei, --signer-mode and --chain-verifier apply to independent mode: add --independent`.
- **Cause:** the regex predates `--chain-verifier`. The CLI's behaviour is correct.

## P8 (`patches/P8-cli-combined-signer-mode-diagnostic.patch`, 1 file, 5 changed lines; `P8-PINS.txt`)
- **The change:** the assertion becomes the **exact full line, anchored** (`/^error: … --signer-mode and --chain-verifier apply to independent mode: add --independent$/m`). It still proves that `--signer-mode` without `--independent` is refused.
- **Unchanged:** `assert.notEqual(hosted.code, 0)` and `noEnclave()`. No other assertion changes, and nothing is loosened into a generic throws check.
- **Pins:** pre-image `a38de9fb…d495`, which is the same file in r7 base, r7 cand and **r12 final**. Post-image `c5deb996…6d79`.
- **Checks done:** `git apply --check` passes on all three trees. The new regex matches the actual line in r7's TAP.
- **Composition r12:** the same file in r12's final tree takes the same P8 (pinned pre-image).

## Runner (`jobs/standalone-mcp-authority-r8-diagnostic.sh`)
- **Reused, with nothing cloned, compiled or compared:** r6's builds, comparator 23/23 and EQUAL, through r7's pinned receipts; and r7's **6 rows / 65 tests** (`R7-RUN-RECEIPT.sha256`, root's r7 log pinned, each TAP re-parsed for its exact count).
- **Copies:** private copies of r6's qualified trees go through r7's exact checks. P8 is applied with pinned pre- and post-images, and the expected status is checked exactly (`EXPECTED-STATUS-P8-*`). No reused test file or helper references the P8 file.
- **Executed:** ONLY `cli-combined-independent` on base and on candidate: **2 rows / 8 tests**.
- **Accounting:** 65 + 8 = 73, equal to the EXPECTED-TAP total. Each row must show its exact count with 0 skip/cancel/todo and rc 0.
- **After:** status, artifacts and cache unchanged, with the ignored-entry delta recorded.

## Correction for HANDOFF
In **rig-rerun-r2** (`rig-artifact-closure-stage/r2/run/20261026T034813Z`), **cli-combined-independent was NOT 4/4.** It was **3/4 in both trees** (final and ownercli), failing on the same stale regex (actual TAP below).

| Tree / test | tests | pass | fail |
|---|---|---|---|
| leaseRelay lease-relay-host-policy | 9 | 9 | 0 |
| final lease-relay-host-policy | 9 | 9 | 0 |
| final cli-independent-sessions | 13 | 13 | 0 |
| ownercli cli-independent-sessions | 13 | 13 | 0 |
| final cli-combined-independent | 4 | 3 | 1 |
| ownercli cli-combined-independent | 4 | 3 | 1 |
| final offchain-heartbeat-writers | 3 | 2 | 1 |
| ownercli offchain-heartbeat-writers | 3 | 2 | 1 |

The heartbeat test's failure (`not ok 1 - the REAL supervisor sends no periodic registry transaction…`) is separate and NOT addressed by P8.

**The full MCP surface stays NOT qualified until root's r8 reports 73/73.**
