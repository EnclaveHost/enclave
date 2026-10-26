# Standalone MCP r3: real Foundry contract artifacts so the 34 skipped rig tests execute (prepared; nothing run)

Stage: `standalone-mcp-authority-stage/r3/` (SHA256SUMS `a656e9aedc4872d2…`); job `jobs/standalone-mcp-authority-r3-tests.sh` `693e1d27884f5785…`. r1, r2 and their outputs are frozen; r2's inputs are read and pinned (R2-PINS.sha256). **The product is unchanged** (r2 patch, CANDIDATE/BASE hashes, 73 expected tests).

## Cause of r2's INCOMPLETE (root-mcp-authority-r2-0241, exit 30: 39 PASS, 34 SKIPPED)
`test/helpers/cli-independent-rig.mjs haveTools()` needs anvil, openssl **and** `contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json`. `contracts/foundry/out/` is gitignored forge output (foundry.toml: "forge output … is gitignored"), so the fresh clones never had it. mcp-independent (13) and cli-combined-independent (4) skipped in both trees. The SDK the rigs import (`sdk/sessions/dist/node.mjs`) is committed, so no SDK build is needed.

## r3 Foundry phase (before any test; any failure is SETUP, never a verdict)
- **Pinned tools** (as installed; no fetch):
  - forge `/home/steven/.foundry/bin/forge` sha256 4f77da08… (1.7.1, commit 4072e487);
  - solc `~/.local/share/svm/0.8.35/solc-0.8.35` sha256 fa8ac9a3… (`0.8.35+commit.47b9dedd`), passed explicitly with `--use`;
  - anvil and openssl must exist (otherwise the rigs would skip).
- **Inputs:** each clone's `foundry.toml` must pin `solc = "0.8.35"`. `contracts/` and `foundry.toml` must be unmodified versus the commit, with no untracked contract input. **The contract input closure** (`git ls-files -s foundry.toml contracts`) must be identical in base and candidate: the r2 patch touches only cli/ and mcp/ files and its test.
- **Build:** in **each** fresh clone: `FOUNDRY_OFFLINE=true forge build --offline -j 1 --use <solc> <source>`, one source per invocation (the pattern of root's prior forge-prebuild job, which peaked at 117 MiB), using the repository's own foundry.toml. Its optimizer, via_ir, the runs=1 restrictions and the ledger profile are untouched.
  - **Sources (8):** EnclaveAddressBook, EnclaveRegistry, EnclaveAppCatalog, EnclaveDeployments, PaymentRouter, PinnedSessionVaultFactory, SessionVault, test/mocks/SessionMocks.
- **Required artifacts (9, from the rigs' `art()` calls):** each must exist with a non-empty `bytecode.object`.
- **Determinism:** the full out/ manifests of the **two independent builds must be byte-identical**. The job records `ARTIFACTS-<tree>.sha256` and `ARTIFACT-INPUTS.txt` (closure hash, tool hashes, sources). Nothing stale or unproven is copied in.
- **Clean tree:** the base clone must still be clean (out/ and cache/ are gitignored).
- **Then the r2 suite, unchanged:** strict TAP. Each of the 8 files needs exactly its count (**73 total**) with **0 fail/skip/todo/cancelled** and node rc 0; anything else is INCOMPLETE or FAIL.

## Root command (shared queue 2560, offline)
    ./jobs/q-exit-status.sh standalone-mcp-authority-r3 2560 unshare -rn bash standalone-mcp-authority-stage/r3/jobs/standalone-mcp-authority-r3-tests.sh

## Not established
- **Not executed:** the forge builds and the 34 rig tests have not run. If a rig test fails on real anvil, that is a real product result.
- **Unverified byte-identity:** the two-tree byte-identity assumes forge artifacts embed no clone-specific path. If they do, the job stops as SETUP (never a pass), and the fix is to compare without the path fields.

## Note for composition r11 (r10 stays frozen and untested)
The r10 runner runs some test files twice on the same tree: once as a component test (E) and again as a regression (E2) with the same final-tree file. A future r11 should **reuse the exact immutable tree and that test's receipt** (sha256 of the TAP output plus the tree commit), not rerun it. That halves duplicated work and makes each verdict cite one receipt. All r10 guards (native no-skip, exact paths, staging, summaries) stay.
