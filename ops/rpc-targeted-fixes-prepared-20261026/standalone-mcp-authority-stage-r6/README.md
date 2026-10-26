# standalone-mcp-authority-stage/r5 (PREPARED; nothing run by the worker): r4 + exact solc library-placeholder validation

r4 is FROZEN. Root's run `root-mcp-authority-r4-0307` exited 20 (SETUP, not a verdict). Every step through the 17 comparator
unit tests passed. Then the comparator refused the REAL build:
`EnclaveDeployments.sol/EnclaveDeployments.json: bytecode.object is not hex`. Peak RSS 928 MiB; min host available 21234 MiB.

**The product is unchanged.** r2's candidate, patch, CANDIDATE/BASE hashes and `EXPECTED-TAP.txt` (the same 73 tests, all of which
must run and pass, no waivers) are pinned via `R2-PINS.sha256`, identical to r4's. The same forge 1.7.1 (`4f77da08`), solc
0.8.35+commit.47b9dedd (`fa8ac9a3`), noble sha3.js (`313da357`) and `CONTRACT-ARTIFACTS.txt` (identical to r4's) are used.

## The cause (from r4/run/20261026T030632Z, real base and cand; the files are byte-identical in both trees)
solc leaves each UNLINKED library call as a 40-character placeholder in the hex: `__$` + the first 34 hex characters of
keccak256("<sourceUnit>:<Library>") + `$__`. Each sits at exactly the byte offset listed in `linkReferences`, with length 20.
`settings.libraries` is `{}`. Every placeholder matched its reference, and no other character was non-hex.

| artifact | bytecode refs | deployedBytecode refs | library (placeholder) |
|---|---|---|---|
| EnclaveDeployments.sol/EnclaveDeployments.json | 5 (4019, 7681, 8546, 22801, 23513) | 5 | contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth (`5b3b0390e5ef7140b25880b201f70f4329`) |
| PinnedSessionVaultFactory.sol/PinnedSessionVaultFactory.json | 16 | 0 | contracts/SessionVault.sol:SessionVaultLib (`846fc2ee519fa15d5550d4239898f7c487`) |
| SessionVault.sol/SessionVault.json | 16 | 16 | same |
| SessionVault.sol/SessionVaultFactory.json | 16 | 0 | same |

## The fix: one function, `checkCode` in `compare-artifacts.mjs`
It replaces r4's one-line hex check, and nothing else in the comparator changes. For both `bytecode` and `deployedBytecode`:
- **The object:** a string matching `0x([0-9a-f$_]{2})*`, with a `linkReferences` object present.
- **Each reference source:** must be one of this artifact's own `rawMetadata.sources`, and must name at least one library.
- **Each library:** an identifier with a non-empty reference list.
- **Each reference:** exactly `{start, length}`, with an integer `start` ≥ 0, `length` exactly 20, and in bounds.
- **Overlap:** no two slots may overlap.
- **Slot contents:** each slot must hold EXACTLY the solc placeholder for its `<source>:<Library>`, computed with the pinned keccak.
  An address in a slot that is still listed in `linkReferences` is refused. solc lists a reference only while it is unlinked.
- **Everything outside the slots:** must be lowercase hex. A placeholder that no reference covers is refused with `link`.

Byte identity is untouched. Equality is still the sha256 of every artifact file, placeholders included, so a linked build and an
unlinked build are NOT equal. The source keccak, compiler pin, forge-vs-solc metadata, build-info and cache rules, and the only
two normalizations (build ids and cache timestamps) are r4's verbatim. The report gains `links` (per artifact, the number of slots
in bytecode and in deployedBytecode) and its format is `mcp-artifact-comparison/v2`.

## Tests: `tests/compare-artifacts.test.mjs`, 23 = r4's 17 unchanged + 6
- **Synthetic:**
  - an exact placeholder is accepted (including adjacent slots listed in any order);
  - linked and unlinked builds both load but are not equal;
  - 14 malformed cases refuse: wrong hash, another library's placeholder, an uncovered placeholder, an address in a listed slot,
    out of bounds, overlap, length ≠ 20, an extra key, an empty list, a foreign source, uppercase, odd length, a non-placeholder
    `_`/`#`, and a missing `linkReferences`.
- **REAL (this run's own forge output; `REAL_A`/`REAL_B` = `$X/base`/`$X/cand`; these tests FAIL if those are unset, never skip):**
  - the two trees compare EQUAL, with the exact per-artifact slot counts above, the exact EnclaveDeployments placeholder and
    offsets, and one reference per placeholder;
  - mutations of a copy of the real EnclaveDeployments.json refuse, after an unmutated control that loads: a bad hash, an unmatched
    placeholder in bytecode and in deployedBytecode, out of bounds, overlap, a renamed library, a wrong source, filled slots, and
    non-hex elsewhere;
  - a correctly linked real artifact loads and is not equal to the unlinked real build.

## Runner: `jobs/standalone-mcp-authority-r5-tests.sh`
This is r4's runner with these changes:
- the r5 stage is checked against its SHA256SUMS;
- r4 must be unchanged (frozen), as must r3 and r2;
- the comparator unit tests run with `REAL_A`/`REAL_B` (they already ran after the forge builds) and must report exactly
  23/23 with 0 skip, else SETUP 20;
- `ARTIFACT-INPUTS.txt` records the `links` map.

Everything else is r4's: the semantic comparison (EQUAL, else 20), then the same 73 MCP tests under the same exact-count rules.
Exit codes: 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict).

Root command: `./jobs/q-exit-status.sh standalone-mcp-authority-r5 2560 unshare -rn bash standalone-mcp-authority-stage/r5/jobs/standalone-mcp-authority-r5-tests.sh`
