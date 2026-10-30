# standalone-mcp-authority-stage/r4 (PREPARED; nothing run): r3 with a STRICT SEMANTIC artifact comparison

r3 is FROZEN. Root's run `root-mcp-authority-r3-0300` exited 20 (SETUP, not a verdict) at its raw `cmp` of the two artifact
manifests. Peak RSS 916 MiB; minimum host available 22089 MiB.

**The product is unchanged:** r2's candidate, patch, CANDIDATE/BASE hashes, and `EXPECTED-TAP.txt` (exactly 73 tests, all
of which must execute and pass), all pinned via `R2-PINS.sha256`. The same pinned forge 1.7.1 (`4072e487`, `4f77da08`), the
same solc 0.8.35+commit.47b9dedd (`fa8ac9a3`), and the same 8 sources and 9 required artifacts (`CONTRACT-ARTIFACTS.txt`,
identical to r3's) are used.

## What actually differed (inspected in `r3/run/20261026T025710Z`)
- **All 31 contract artifacts** (`out/<File>.sol/<Contract>.json`) are byte-identical in base and cand.
- **The only manifest differences** are the 7 `out/build-info/<id>.json` files. Each is forge's minimal
  `{"id","source_id_to_path","language"}`. The `source_id_to_path` and `language` values are identical pairwise; only `id`,
  and therefore the file name, differs.
- **Outside the manifest,** `cache/solidity-files-cache.json` differs only in `builds` (those ids, sorted by id), every
  artifact `build_id` reference, and each file's `lastModificationDate` (the two clones were checked out ~7 s apart).
  `contentHash`, `imports`, `versionRequirement`, artifact paths, profiles and settings are all identical.
- **Why the ids differ:** forge assigns build ids that are not a function of the compiled content seen here. Whether they
  derive from the absolute project path or from randomness was not determined, because nothing was run.
- **A further observation:** forge's parsed `metadata` field is a lossy rendering of solc's `rawMetadata`. It omits empty
  `outputs` and some doc fields, and strips the leading `:` of remappings, so the two are not compared as equal JSON.

## The comparator: `compare-artifacts.mjs` (strict; full raw kept)
**Per tree, it refuses unless every rule below holds:**
- **Layout:** `out/` holds only regular `.json` files. There are no symlinks.
- **Build-info:** each file has exactly `{id, language, source_id_to_path}`, with `id` == its file name and `language`
  Solidity. Source ids are exactly `0..n-1`, each naming an existing `contracts/` file, and no two builds have the same source
  map.
- **Artifacts:**
  - each has exactly the 7 observed keys, a hex bytecode/deployed bytecode, and an integer source `id`;
  - `rawMetadata` has the exact observed solc shape and the pinned compiler version;
  - its `compilationTarget` names exactly this output;
  - **every `sources[*].keccak256` equals the keccak-256 of the actual file in the tree**, using the pinned
    `@noble/hashes` 1.8.0 `sha3.js` (`313da357…`);
  - forge's `metadata` agrees with `rawMetadata` on the compiler, language, sources and every setting (remappings via the
    observed `:` strip).
- **Cache:** the exact observed shape. `builds` is exactly the build-info set. Every cache reference resolves exactly:
  artifact path = `<basename>/<Contract>.json`, the build exists, and the artifact's source id maps to that source in that
  build. Every artifact is referenced exactly once and every build is used; anything missing, extra or orphaned refuses.
- **Required:** the 9 required artifacts have non-empty bytecode, and the 8 required sources were compiled.

**Equality is decided over** the artifact list with each file's sha256 (byte identity: abi, bytecodes, metadata), the build-info
CONTENT labels, and the cache. The ONLY normalized values are build ids (replaced by content labels everywhere they occur) and
the cache's present, numeric `lastModificationDate` (dropped). The report `ARTIFACT-COMPARISON.json` (exclusive create) keeps
both FULL raw manifests and their hashes, the cache and build-info hashes, the exact normalized raw values, the semantic
structure and its sha256, and the differences.

## Runner: `jobs/standalone-mcp-authority-r4-tests.sh`
It is r3's runner with the raw `cmp` replaced, in this order:
1. write the cache manifest;
2. check the noble pin;
3. run the **17 comparator unit tests** (exactly 17 passing, 0 skip, else SETUP 20);
4. run the comparator on the two real trees (EQUAL, else SETUP 20);
5. run **the same 73 real MCP tests** with the same exact-count rules.

Exit codes: 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict).

Root command: `./jobs/q-exit-status.sh standalone-mcp-authority-r4 2560 unshare -rn bash standalone-mcp-authority-stage/r4/jobs/standalone-mcp-authority-r4-tests.sh`
