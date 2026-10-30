# standalone-mcp-authority r4 (strict semantic artifact comparison): PREPARED; NOT executed

**Stage:** `standalone-mcp-authority-stage/r4/`. `SHA256SUMS` =
`abed76b0c5ae7386904d50c56849bd4ba3aeb2a76fec2f9d6ce33aa4a943f52e` (7 files). It was verified with `sha256sum -c` just now.
- **Frozen and verified intact:** r3 and r2.
- **Checks done by the worker:** static only (`node --check` on the tool and its tests, `bash -n` on the runner). No tests,
  builds, queue, network, SSH, live action or commit.
- **No completion is claimed.** Completion requires root's actual run to pass the 17 comparator tests, the real
  comparison, and all 73 MCP tests, with 0 skipped.

| file | sha256 |
|---|---|
| `compare-artifacts.mjs` | `4d40ce95eb2231fe…` |
| `tests/compare-artifacts.test.mjs` (17 tests) | `29e69ea38406c382…` |
| `jobs/standalone-mcp-authority-r4-tests.sh` | `4f1a191815203cfe…` |
| `CONTRACT-ARTIFACTS.txt` (identical to r3) | `1f26aa9e0ecc3db5…` |
| `R2-PINS.sha256` (identical to r3: r2 product, patch, CANDIDATE/BASE, EXPECTED-TAP) | `1a8257b68a0854d4…` |
| `README.md` | `91960dd372642b56…` |
| `SHARED-NOTE-artifact-comparison.md` (for composition r11/da0, in this stage only) | `bb32e48caeb2eaea…` |

## r3's actual failure explained (from the exact JSON in `r3/run/20261026T025710Z`)
Root's run `root-mcp-authority-r3-0300` exited 20 (SETUP): `[FAIL] the two artifact builds differ`. Peak 916 MiB; minimum
host available 22089 MiB.

**What matched:**
- **All 31 contract artifacts are byte-identical.**
- **The 7 `out/build-info/<id>.json` files** are forge's minimal `{"id","source_id_to_path","language"}`. Their
  `source_id_to_path` and `language` values are identical pairwise.

**What differed:**
- **In the manifest:** only each build-info file's `id`, and hence its NAME (which is what `ARTIFACTS-*.sha256` lists).
- **In the cache (not in r3's manifest):** `builds` (those ids, in id order), each artifact `build_id` reference, and each
  file's `lastModificationDate`. Everything else matched: `contentHash`, imports, version requirements, artifact paths,
  profiles and settings.

**Also observed:** forge's `metadata` field is a lossy rendering of solc's `rawMetadata`. It omits empty `outputs` and some
doc fields, and strips the leading `:` of remappings.

## Why the normalization still binds all semantic data
The comparator normalizes **exactly two observed value classes:**
1. **Build ids,** wherever they occur: the build-info file name and `id`, `cache.builds` and its order, and cache `build_id`
   references. Each is replaced by a CONTENT label, the canonical `{language, source_id_to_path}` of that build. Labels must
   be unique, so the mapping is a bijection: a build cannot be swapped or merged unseen.
2. **`cache.files[*].lastModificationDate`:** dropped, but only when present and numeric. A missing one refuses.

**Everything else is compared or bound strictly:**
- **Byte identity:** every contract artifact's full bytes (sha256 per file) must be equal: abi, bytecode, deployed bytecode,
  method ids, `rawMetadata`, `metadata`, source `id`.
- **Compiler:** each artifact's `rawMetadata` has the exact observed solc shape and **compiler == 0.8.35+commit.47b9dedd**.
- **Settings:** the full settings (target, evmVersion, libraries, metadata, optimizer, remappings, viaIR) are inside those
  identical bytes.
- **Output reference:** the `compilationTarget` must name this exact output file.
- **Sources:** every metadata `sources[*].keccak256` must equal the keccak-256 of the actual file in the tree, using the
  pinned `@noble/hashes` 1.8.0 `sha3.js` (`313da357…`). So the full compiled inputs are bound, not only file names.
- **Forge metadata:** forge's `metadata` must agree with `rawMetadata` on the compiler, language, sources and every setting.
- **Source ids:** every cache reference must resolve: the artifact exists at `<basename>/<Contract>.json`, the build exists,
  and the artifact's source id maps to its source in that build's `source_id_to_path`. This binds source ids end to end.
- **No extras:** every artifact is referenced exactly once, every build-info is used, `cache.builds` is exactly the
  build-info set, and `out/` holds only regular `.json` files (no symlinks).
- **Shapes:** the exact observed key sets of build-infos, artifacts, metadata/settings, cache and cache entries.
- **Required outputs:** the 9 required artifacts have bytecode and the 8 required sources were compiled.
- **Kept, never replaced:** the FULL raw manifests (`ARTIFACTS-{base,cand}.sha256`, plus `CACHE-*.sha256`) and the report
  `ARTIFACT-COMPARISON.json` (created exclusively). The report holds both raw manifests and their hashes, every build-info
  sha256, the exact raw normalized values, the semantic structure and its sha256, and the differences.

## Root command and exact counts
`./jobs/q-exit-status.sh standalone-mcp-authority-r4 2560 unshare -rn bash standalone-mcp-authority-stage/r4/jobs/standalone-mcp-authority-r4-tests.sh`

**Runner order:** r3's checks unchanged. Then, in r4: stage manifest r4; r3 frozen; r2 pins; pinned forge, solc,
anvil/openssl; contract closure; one build per source in each clone; required bytecode; raw manifests; cache manifest; noble
pin. Then:
1. **comparator unit tests:** exactly `# tests 17`, `# pass 17`, 0 fail/cancelled/skipped/todo, rc 0. Anything else is
   SETUP 20.
2. **comparator on the real trees:** EQUAL. Anything else is SETUP 20.
3. **the same 73 real MCP tests** (`EXPECTED-TAP.txt`):

   | test file | candidate | base |
   |---|---|---|
   | `mcp-independent-verifier` | 9 | – |
   | `mcp-independent-unit` | 10 | 10 |
   | `mcp-independent` | 13 | 13 |
   | `cli-combined-independent` | 4 | 4 |
   | `chain-authority` | 10 | – |

   Each file needs its exact count, all passing, with 0 skip/todo/cancelled.

**Exit codes:** 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict). The 34 rig tests are not waived.

## Assumptions not verifiable without running (honest)
1. **That forge output holds no other nondeterminism.** A field I didn't observe would refuse as a semantic difference
   (fail-closed SETUP), never pass silently. The exact-key-set rules could likewise refuse on a shape seen only in the base
   tree. Both trees came from the same forge, so this is unlikely.
2. **The cause of the build-id differences is unknown.** Whether they come from absolute paths, timing or randomness was
   not determined. The method does not depend on it.
3. **The `:`-strip of remappings is a rule taken from the 31 observed artifacts,** not from forge documentation.
4. **solc's metadata keccak256 is assumed to be over the exact source file bytes** as checked out (standard solc
   behaviour). This is not confirmed against these trees: the comparator was **not run** on r3's outputs.
5. **The 17 unit tests use synthetic trees** shaped after the observed output. Their first execution is root's run.
6. **The 73 MCP tests have never all executed together.** r2's run skipped 34 of them, and r3 stopped at setup. Their
   outcome is unknown until root's r4 run.
