# MCP r7 continuation — result (PREPARED; nothing run by Claude)

**Not done:** no tests, builds, queue jobs, network or SSH access, live actions or commits.
**Untouched:** r6, its ended run `standalone-mcp-authority-stage/r6/run/20261026T035555Z`, r5 and r2. The r6 manifest and the new r6-run receipt both verify.

## Root's actual r6 (`logs/root-mcp-authority-r6-0333.out`, exit 20 SETUP, peak 931 MiB (git clone), cap 2560)
- **Passed:**
  - pins and closure checks, including all 30 Solidity source pins in both trees;
  - two independent offline builds of the complete 12-artifact closure (MockFeed, EnclaveReviews and EnclaveAddressBook included);
  - comparator **23/23**;
  - **semantic EQUAL `426a71358fd9773b4d599afe550e07efb7c8e817b00ca2b496b1df4589a1f0ac`**.
- **The one failure:** `[FAIL] the artifact build changed tracked files`. It is a false diagnostic, confirmed read-only on the ended run:
  - base `git status --porcelain` = `?? node_modules` only. That is the runner's own declared symlink, created after its first clean check.
  - cand = ` M cli/independent.mjs`, ` M mcp/independent-secrets.mjs`, ` M mcp/independent.mjs`, `?? test/mcp-independent-verifier.test.mjs` and `?? node_modules`. That is exactly the r2 patch: `CANDIDATE.sha256` has those 4 files, and the patch reverse-applies.
- **Still intact:** the raw artifact manifests recompute equal to r6's ARTIFACTS files, and both HEADs are b6ac5d657.

## Prepared: `standalone-mcp-authority-stage/r7`
- **Manifest:** `SHA256SUMS` `b082c54d…24d1`.
- **Runner:** `jobs/standalone-mcp-authority-r7-continuation.sh`, sha256 `84e6d0bf…8c90`.
- **No recompilation and no comparator rerun.** The inputs are unchanged, so the r6 builds and the 23/23 receipt are reused, pinned by these files:
  - `R6-RUN-RECEIPT.sha256` (28 run files) and `R6-ROOT-LOG.sha256`, plus the exact 23/23, EQUAL and failure lines;
  - `EXPECTED-STATUS-{base,cand}.txt`, compared EXACTLY, so no untracked file is ignored wholesale;
  - `DEPS-PINS.txt`: the symlink target, `package_lock` `9ada1611…9f20` and noble `313da357…18ec`;
  - BASE and CANDIDATE pins, the r2 patch, r6 `SOURCE-PINS.sha256`, and the artifact and cache manifests.
- **Private copies:** `cp -a --reflink=auto` copies under `r7/run/<ts>/`, re-checked identically. The r6 run is re-verified at the end.
- **Executes ONLY** the 8 `EXPECTED-TAP.txt` rows, 73 tests:
  - cand: verifier 6, unit 10, mcp 13, cli-combined 4, chain-authority 10;
  - base: unit 10, mcp 13, cli-combined 4.

  Each row must show exact counts, 0 skip/cancel/todo, and rc 0.
- **After the tests:** the exact status is unchanged and the artifacts are unchanged. The ignored-entry delta is recorded; any ignored change under `contracts/foundry` fails.
- **Runtime build:** the rigs' `lease-gas-forge.mjs` build uses the pinned forge on PATH, with the private `TMPDIR`.
- **Exit codes:** 0 PASS / 1 FAIL / 30 INCOMPLETE / 20 SETUP.

## Root command (cap 2560: the runtime forge build plus anvil and node; 1408 would likely also fit, since copying uses little RSS)
```
./jobs/q-exit-status.sh standalone-mcp-authority-r7 2560 unshare -rn bash standalone-mcp-authority-stage/r7/jobs/standalone-mcp-authority-r7-continuation.sh
```
- **Disk:** about 1.3 GB for the copies, which is less with reflink. 801 GB is free.

**The full MCP surface is NOT qualified until this run reports 73/73 PASS.** This fixes runner setup only, not the product. Custody v2 stays REFUSED and lease consumers stay on HOLD. No commits.
