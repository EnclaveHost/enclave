# claude-mcp-r5-linkrefs result: standalone-mcp-authority-stage/r5 PREPARED (not run by the worker)

**Status:**
- **Not done:** no tests (unit or MCP), no build, no queue, no network, no SSH, nothing live, no commits.
- **r4 is untouched:** its SHA256SUMS still verifies.
- **Not an r5 test run:** one read-only diagnostic was run, described under "Diagnostic" below.

## Diagnosis (root-mcp-authority-r4-0307, exit 20 SETUP, after the 17/17 comparator unit tests)
- **What the refusal is:** `REFUSED artifact: EnclaveDeployments.sol/EnclaveDeployments.json: bytecode.object is not hex`. r4
  required the bytecode to match `^0x[0-9a-f]*$`.
- **What is in the bytecode:** the real artifacts contain solc's UNLINKED-library placeholders. Each is
  `__$` + keccak256("<sourceUnit>:<Library>")[0..34 hex] + `$__`. That is 40 characters, or 20 bytes.
- **Where they sit:** each placeholder sits at exactly the byte offsets in that object's `linkReferences`, each with length 20.
- **Checks that held on every artifact:**
  - `rawMetadata.settings.libraries` is `{}`;
  - removing the placeholders leaves only lowercase hex;
  - the base and cand files are byte-identical.
- **The placeholder hashes match the pinned noble keccak:**
  - keccak("contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth") gives `5b3b0390e5ef7140b25880b201f70f4329`;
  - keccak("contracts/SessionVault.sol:SessionVaultLib") gives `846fc2ee519fa15d5550d4239898f7c487`.

| artifact | bytecode refs | deployedBytecode refs |
|---|---|---|
| EnclaveDeployments.sol/EnclaveDeployments.json (EnclaveLedgerBandwidth) | 5 @ 4019, 7681, 8546, 22801, 23513 | 5 @ 3082, 6744, 7609, 21864, 22576 |
| PinnedSessionVaultFactory.sol/PinnedSessionVaultFactory.json (SessionVaultLib) | 16 | 0 |
| SessionVault.sol/SessionVault.json (SessionVaultLib) | 16 | 16 |
| SessionVault.sol/SessionVaultFactory.json (SessionVaultLib) | 16 | 0 |

r4 stopped at the 3rd artifact in sorted order, so its later checks had never run on the real trees.

## Fix (minimal; no new parser framework)
**Where:** `r5/compare-artifacts.mjs`. A single function, `checkCode`, replaces r4's two-line hex loop. It runs after the source
keccak checks, because it needs `rawMetadata.sources`. The diff from r4 is 48 changed lines.

**What `checkCode` accepts, for both bytecode objects:**
- **The object:** `0x([0-9a-f$_]{2})*`, with a `linkReferences` object present.
- **Each reference source:** must be in this artifact's own `rawMetadata.sources`.
- **Each reference:** exactly `{start, length}`, with `length === 20`, an integer `start` ≥ 0, and in bounds.
- **Overlap:** no two slots may overlap.
- **Each slot:** must equal the solc placeholder for its `<source>:<Library>`, computed with the pinned keccak.
- **The rest:** must be lowercase hex. A leftover placeholder refuses with `link`; anything else non-hex refuses with `artifact`.

**What it does not accept:** non-hex in general (there is no blanket acceptance), or an address in a listed slot.

**What stays exactly as r4 had it:**
- byte identity: the per-file sha256 equality, with placeholders included;
- the source keccak and compiler pins, and the forge-vs-solc metadata agreement;
- the build-info and cache resolution rules;
- the only two normalizations: build ids and cache timestamps.

**Report changes:** the report adds `links` (per-artifact slot counts) and its format becomes `mcp-artifact-comparison/v2`.

## Tests: 23 = r4's 17 unchanged + 6 new (`r5/tests/compare-artifacts.test.mjs`)
1. **Synthetic, valid unlinked:** an exact placeholder at its reference is accepted, and two such trees are EQUAL. Adjacent slots
   are accepted in any listing order.
2. **Synthetic, valid linked:** pure hex with `{}` references loads. Linked vs unlinked is NOT equal.
3. **Synthetic, 14 refusals:**
   - wrong hash;
   - another library's placeholder;
   - an unmatched placeholder;
   - an address in a listed slot;
   - out of bounds;
   - overlap;
   - length 21;
   - an extra ref key;
   - an empty ref list;
   - a source not in the metadata;
   - uppercase;
   - odd length;
   - `__#`;
   - a missing `linkReferences`.
4. **REAL, the run's own `$X/base` vs `$X/cand`:**
   - the two compare EQUAL;
   - the exact per-artifact slot counts are present (table above);
   - the exact EnclaveDeployments placeholder and bytecode offsets are present;
   - there is one reference per placeholder.
5. **REAL mutations of a copy of EnclaveDeployments.json**, after a control showing that an unmutated, re-serialized copy loads.
   These refuse:
   - a bad hash;
   - an unmatched placeholder (bytecode, and deployedBytecode);
   - out of bounds;
   - overlap;
   - a renamed library;
   - a wrong source;
   - slots filled with an address while their references are kept;
   - non-hex elsewhere.
6. **REAL, correctly linked:** every slot holds an address and the references are `{}`. This loads, and is NOT equal to the
   unlinked real build.

**Inputs:** the REAL tests read `REAL_A` and `REAL_B`, which the runner sets. If they are unset, the tests fail by assertion and
are never skipped.

## Runner and manifests
**Runner:** `standalone-mcp-authority-stage/r5/jobs/standalone-mcp-authority-r5-tests.sh`. It is r4's runner with these changes:
- r5 is checked against its SHA256SUMS;
- r4 must be unchanged (frozen), alongside the existing r3/r2 checks;
- the comparator unit tests run with `REAL_A=$X/base REAL_B=$X/cand` after the forge builds, and must be exactly 23/23 with
  0 skip, else 20;
- `ARTIFACT-INPUTS.txt` records `links`.

The same 73 MCP tests run under r4's exact-count rules (`EXPECTED-TAP.txt` via `R2-PINS.sha256`, identical to r4's), with no
waivers.

**Root command:** `./jobs/q-exit-status.sh standalone-mcp-authority-r5 2560 unshare -rn bash standalone-mcp-authority-stage/r5/jobs/standalone-mcp-authority-r5-tests.sh`

**`r5/SHA256SUMS`** (sha256 `e7e22d7cbc5ec1ecb86a95e26ebc454912432aca1f70743f48d869dbc47c2bf8`):
```
1f26aa9e0ecc3db5313f9a78dd0af644ba8b52ccecf343d39d00ae9898c55226  ./CONTRACT-ARTIFACTS.txt   (== r4)
1a8257b68a0854d42334b87e46bbc6abc1f657c5d9547fde407198e83a7692d2  ./R2-PINS.sha256           (== r4)
1e6aa557cadfcfee450362302e0c41118c15604e51f889f99d1c898861db3016  ./README.md
836717ae6e97a659fba9d809d24e8a88fd40f9bd171dc1a855866c4427f24520  ./compare-artifacts.mjs
a0fb2eebda320f92f66a866250243c5f7e50966d02053ba411a528e51647bf02  ./jobs/standalone-mcp-authority-r5-tests.sh
4b6aaa46756b0aae662c50038a7887644995a6d4139c146ca9f8350ae3a9d6c7  ./tests/compare-artifacts.test.mjs
```

## Verification by the worker (limited)
- `node --check` passed on the comparator and on the test file.
- `bash -n` passed on the runner.
- `sha256sum -c` passed for r5 and for r4.

**Diagnostic, disclosed:** I called the r5 `compare()` once, read-only and in-process, on the frozen r4 real trees
(`r4/run/20261026T030632Z/{base,cand}`). It did not run the unit tests or the CLI, and it wrote no report. The result was
**EQUAL**:
- semantic `1fd0851df609edb376a1c9e3551a6ef0f84948ba16b88a7beae41e8f6d001723` on both sides;
- 31 artifacts and 7 builds;
- `links` exactly as in the table.

So, on r4's actual output, the rest of the comparator after EnclaveDeployments (artifacts, cache, required) also passes. The 23
unit tests and the 73 MCP tests have **not** been run; root executes them.

## Notes
- **A non-blocking quirk, unchanged from r4:** the `main()` guard in `compare-artifacts.mjs` throws if the module is imported from
  `node -e` (`process.argv[1]` is undefined). The runner and the tests are unaffected, because they call it as a script or import
  it from a test file.
- **The shared note is stale:** `r4/SHARED-NOTE-artifact-comparison.md` (for composition r11 / da0) still describes the r4
  comparator, so consumers should pin r5's `compare-artifacts.mjs` and its 23-test suite instead.
