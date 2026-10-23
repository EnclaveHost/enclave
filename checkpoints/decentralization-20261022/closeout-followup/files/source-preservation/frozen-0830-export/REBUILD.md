# Rebuilding the frozen-0830 material

| side | base | how to obtain the base | what the patches reproduce |
|---|---|---|---|
| a-windows-df8fbafa | 71448f63 | frozen-0630-export/a-native-relay-71448f63 | the exact commit trees |
| s-root-doc-bcd3d9ca | 47c2f71f | frozen-0630 s-holder + frozen-0745 s-holder-final | the exact commit tree (= dc767fc3's tree 4c50bc8c) |
| c-storage-write-bbf0a009 | none (root commits) | `git am` into an empty repository | the exact commit trees |
| f-final-4106c311 (merge) | 0757085e (first parent) | frozen-0630-export/c-carriers-0757085e | `git apply merge-vs-first-parent.diff` gives the exact merge tree; the second parent 6c38c048 is frozen-0630-export/f-lifecycle-6c38c048 |
| e-derivative-159fd148 | none (root commits) | `git am` into an empty repository | **only the SOURCE-ONLY DERIVATIVE trees**: each original tree minus its 7 `fixtures/artifacts/*.json` |

## E: what is omitted, and how to regenerate it

- **Omitted:** 7 compiled contract artifacts. They are recorded by blob, sha256 and size in `INVENTORY.json` `derivative.omittedArtifacts`, and are identical in both commits.
- **Recipe:** `../frozen-0830-e-artifact-recipe.json` records, per artifact:
  - the compiler `0.8.35+commit.47b9dedd` and the settings from its own metadata (viaIR, optimizer runs 1, evmVersion, remappings);
  - the compilation target;
  - every source path with its metadata keccak256;
  - the keccak256 of the creation and runtime bytecode.
- **Sources:**
  - 5 artifacts are covered entirely by E's committed `fixtures/sources`.
  - For the 2 test mocks, the 22 other sources (test files and forge-std) were matched by keccak256 to `work/app-lease-gas/forge` and copied to `../frozen-0830-e-recipe-sources/`, together with that project's `foundry.toml`.
- **To regenerate:** build those targets with solc 0.8.35+commit.47b9dedd and the recorded settings, and confirm that the bytecode keccaks match.
  - Only then can the exact original trees a460c36c (834322bd) and 159fd148 (a7f970a8) be rebuilt.
  - The artifact JSON layout is forge's, so the files may also need byte-for-byte equality in field order; the bytecode keccaks are the semantic check.
- This export did not run a compiler.
