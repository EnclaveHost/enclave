# Shared note (for composition r11 / da0): the Foundry artifact comparison method, r4 (PREPARED; not yet run by root)

**The tool:** `standalone-mcp-authority-stage/r4/compare-artifacts.mjs`. Pin it by this stage's `SHA256SUMS`, and pin its
17-test suite (`tests/compare-artifacts.test.mjs`) the same way.

**Call:**
`node compare-artifacts.mjs <@noble/hashes sha3.js> <CONTRACT-ARTIFACTS.txt> 0.8.35+commit.47b9dedd <treeA> <treeB> <report.json>`
- exit 0: EQUAL;
- exit 1: different or refused;
- exit 2: usage;
- the report is created exclusively.

**What a consumer may rely on:**
- **Equality** means byte-identical contract artifacts and identical build composition and cache semantics. Only the build
  ids and the cache timestamps are normalized.
- **Binding:** the compiler version and every metadata source keccak are bound to the pinned solc and the actual tree files.
- **Raw data is kept:** both full raw manifests and hashes are in the report.

**What it is not:**
- not proof that the builds came from the pinned forge/solc (the runner checks the binaries' sha256 separately);
- no claim about the anvil rigs' behaviour (that is the 73 tests).

**Status:** use it only after root's actual r4 run passes all of these: the 17 unit tests, the real comparison, and all 73
MCP tests. No completion is claimed before that. Do not copy or edit this stage. Reference it by path and hash.
