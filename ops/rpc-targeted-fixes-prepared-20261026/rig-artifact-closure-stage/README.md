# rig-artifact-closure-stage (PREPARED; nothing run by Claude: static reads + `ast`/`bash -n` checks only)

**Trigger:** root's still-running composition r12 (`logs/root-composition-r12-full-0313.out`). All 9 `lease-relay-host-policy` tests failed in the `before` hook with
`ENOENT .../contracts/foundry/out/EnclaveDeployments.multicallValue.t.sol/MockFeed.json`. The read comes from
`test/helpers/cli-independent-rig.mjs:129` (`art()` defined at `:35`); the line is `:124` at the MCP base. The earlier "all artifact refs covered" claim missed it.

## The finite map (`map/`)
- **Tool:** `tools/artifact-closure.py`, a read-only scan.
  - It follows each test's local import closure: static and dynamic imports, re-exports, and literal `.mjs`/`.js` paths (spawned scripts).
  - It finds the helpers that read `contracts/foundry/out` or `leaseGasForgeOut()`, including one-line wrappers (`leased → leaseArt`) and imported aliases.
  - It finds every call with literal arguments, `existsSync` gates, and literal paths.
- **Scope:** the 5 MCP test files (73 tests) at b6ac5d657, the patch's added lines, and r12's 28 component tests (in their own trees) plus 104 regressions (final tree). That is 147 closures.
  - `test/mcp-independent-verifier.test.mjs` exists only in the candidate. The scan of the patch adds no artifact read; it imports only `../mcp/independent.mjs`.
- **Dynamic references:** 1, `leased(file, name)`, a wrapper of `leaseArt`. It is resolved through its literal call sites. Nothing is left on HOLD.
- **Output files:** `ARTIFACT-MAP.tsv`/`.md` (artifact → file:line → test → compiled source), `needed-main-mcp.txt` (12), `needed-main-r12.txt` (15).
  - `SOURCE-PINS-mcp-b6ac5d657.sha256` (30 files) and `ADDED-SOURCES-{mcp,r12}.sha256` (23/22 files) come from `tools/sol-closure.py`. They cover each source plus its full Solidity import closure, forge-std included. There are 0 unresolved imports, and the pins verify in the trees.
- **Two artifact roots:**
  - `contracts/foundry/out`, which root must prebuild: 16 artifacts.
  - The test's own runtime forge build (`lease-gas-forge.mjs` into `$TMPDIR`, keyed by an input hash): 12 artifacts. These are **not** prebuilt. They need `forge` on PATH and a private `TMPDIR`, so that a cache from another run in `/tmp` is never used.

## Gaps found
| Consumer | Missing from its `CONTRACT-ARTIFACTS` | Read at |
|---|---|---|
| r12 (r11/r12 B2 subset: 33 produced) | `EnclaveDeployments.multicallValue.t.sol/MockFeed.json` (source `contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol`) | cli-independent-rig.mjs:129 (final) / :124 (components) |
| MCP r5 | that MockFeed; `EnclaveReviews.sol/EnclaveReviews.json` (source not compiled); `EnclaveAddressBook.sol/EnclaveAddressBook.json` (compiled, not required) | rig :124; mcp-independent-rig.mjs:60 |

## Deliverables
- **`jobs/root-r12-impacted-rerun.sh`:** run after r12 finishes. r12 stays read-only.
  - It derives the missing set, which must equal `map/r12-missing.txt`.
  - It selects only rows that are not ok, statically reach the missing artifact, **and** have that ENOENT in their actual receipt.
  - It copies only those trees and runs identity gates on each copy.
  - It runs the pinned offline forge on one source, with bytecode-identity and tracked-file gates.
  - It reruns only the unclean pairs, with r12's exact command and r12's exact counts.
  - It writes `RESULTS-AMENDED.tsv` with every row.
  - Exit 3 if unrelated r12 failures remain; this is not a pass.
- **`standalone-mcp-authority-stage/r6`:** r5 frozen, plus the complete MCP artifact closure. See its `R6-CHANGES.md`.
