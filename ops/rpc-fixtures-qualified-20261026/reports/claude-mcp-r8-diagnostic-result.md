# MCP r8 diagnostic — result (PREPARED; nothing run by Claude)

**Not done:** no execution, builds, tests, queue jobs, network or SSH access, or commits.
**Untouched:** r7 (manifest verifies) and its run, plus r6, r5 and r2. No product change.

## Actual r7 (`logs/root-mcp-authority-r7-0407`, rc 1; run `standalone-mcp-authority-stage/r7/run/20261026T040635Z`)
Counts are from the run's TAP files:

| Row | tests | pass | fail | skip | cancel | todo |
|---|---|---|---|---|---|---|
| candidate mcp-independent-verifier | 9 | 9 | 0 | 0 | 0 | 0 |
| candidate mcp-independent-unit | 10 | 10 | 0 | 0 | 0 | 0 |
| candidate mcp-independent | 13 | 13 | 0 | 0 | 0 | 0 |
| candidate chain-authority | 10 | 10 | 0 | 0 | 0 | 0 |
| base mcp-independent-unit | 10 | 10 | 0 | 0 | 0 | 0 |
| base mcp-independent | 13 | 13 | 0 | 0 | 0 | 0 |
| candidate cli-combined-independent | 4 | 3 | 1 | 0 | 0 | 0 |
| base cli-combined-independent | 4 | 3 | 1 | 0 | 0 | 0 |

**Result: 71/73.**

**The failure:** subtest 4, at `test/cli-combined-independent.test.mjs:170`.
- **The test expects** `/--signer-mode apply to independent mode: add --independent/`.
- **The CLI prints** (`cli/enclave.mjs:5214`, byte-identical in base and candidate) `error: --quorum, --confirmations, --max-block-age, --usdc-token, --max-fee-gwei, --signer-mode and --chain-verifier apply to independent mode: add --independent`.
- **Cause:** a stale test expectation. The CLI is correct.

## Prepared: `standalone-mcp-authority-stage/r8` (`SHA256SUMS` `4b8c2bde…7259`)
- **P8** (`patches/P8-cli-combined-signer-mode-diagnostic.patch`, sha256 `7cf87687…f36f`, test-only, 5 changed lines):
  - **The change:** it asserts the exact full refusal line, anchored. `notEqual(code, 0)` and `noEnclave()` are unchanged; nothing is loosened and no product code changes.
  - **Pins:** pre-image `a38de9fb…d495`, post-image `c5deb996…6d79`.
  - **Where it applies:** cleanly to r7 base, r7 cand and **r12's final tree**, which holds the identical file. Root can use it as-is for the composition.
  - **Checked:** the new regex matches the actual line in r7's TAP.
- **Runner:** `jobs/standalone-mcp-authority-r8-diagnostic.sh` (sha256 `c57d8f4f…0877`).
  - **Reused:** r6's builds, comparator 23/23 and EQUAL `426a7135…` (receipts pinned), plus **r7's 6 rows / 65 tests**. `R7-RUN-RECEIPT.sha256` and root's r7 log are pinned, and each reused TAP is re-parsed for its exact count. Nothing is cloned, compiled or compared again.
  - **Copies:** private copies of r6's qualified trees, with r7's exact checks (status, symlink, lock and noble pins, sources, artifacts and cache).
  - **P8:** applied with pinned pre- and post-images, then checked against the exact expected status. No reused test or helper references the patched file.
  - **Executes ONLY** cli-combined-independent on base and on candidate: **2 rows / 8 tests**.
  - **Accounting:** **65 reused + 8 executed = 73**, the EXPECTED-TAP total. Every row must show its exact count, 0 skip/cancel/todo and rc 0. Status, artifacts and cache must be unchanged afterwards.
- **Root command:**
  ```
  ./jobs/q-exit-status.sh standalone-mcp-authority-r8 1408 unshare -rn bash standalone-mcp-authority-stage/r8/jobs/standalone-mcp-authority-r8-diagnostic.sh
  ```
  Cap 1408 is enough: r7's peak was 692 MiB including the runtime solc. Use 2560 if root prefers margin.

## Correction for HANDOFF: the earlier rig rerun was NOT 4/4 for cli-combined
Actual TAP from `rig-artifact-closure-stage/r2/run/20261026T034813Z/logs`:

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

- **cli-combined:** both rows failed on the same stale regex, and P8 addresses it.
- **heartbeat:** both rows fail `not ok 1 - the REAL supervisor sends no periodic registry transaction…`. This is unrelated to P8 and remains open.

**The full MCP surface stays NOT qualified until root's r8 run reports 73/73 PASS.** Custody v2 stays REFUSED; lease consumers stay on HOLD.
