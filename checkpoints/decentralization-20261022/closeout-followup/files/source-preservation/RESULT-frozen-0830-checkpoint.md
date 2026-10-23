# Checkpoint publication 08:30Z: A Windows consumers, root's canonical doc fix, C storage cutover, F final compose, E source-only

> **Time correction (added 2026-10-23T08:05Z, from `date -u` and git metadata; the original text below is unchanged).** "0830" / "08:30Z" / "08:3xZ" in this receipt and its file names is a **batch identifier**, not a time. The actual times: the living-document snapshots were copied at 07:53:38Z (file mtime), the export INVENTORY was written at 07:57:38Z, and commit `cadf0ebb` was made at **07:57:53Z** (git author/committer time 00:57:53-07:00). The label texts inside the pushed checkpoint that say 08:30Z or 08:3xZ carry the same batch-identifier meaning; a later source batch can preserve this correction.

**Pushed:** `checkpoint/decentralization-20261022` 842ca0441 → **`cadf0ebb83338d847ef1cb5d3f14a64fe7560098`**.
- A normal fast-forward, verified by `ls-remote`. **main `7752a4239b3bec2cf452491cd1b95164a8c2bdb8` unchanged.**
- Author and committer: SteveDeFacto (noreply). Every step ran through the queue at 256. Hooks and scanners are unchanged.
- Not done: no force push, merge, signing, SSH, wallet action, image build or deployment.

| Side | Base → head | What the patches reproduce |
|---|---|---|
| a-windows | 71448f63 → b56a4699, f3443e53, 25c051a9, e820e240 → **df8fbafa** | exact commit trees |
| s-root-doc | 47c2f71f → **bcd3d9ca** (ROOT, noreply identity) | exact tree **4c50bc8c**, the same as the unpublished dc767fc3 it replaces |
| c-storage-write | ROOT → **6fd7a929** → **bbf0a009** (RESULT) | exact commit trees |
| f-final (merge) | first parent 0757085e + one diff (4 files) | exact merge tree of **4106c311** (second parent 6c38c048 is in 871e2197) |
| e-derivative | ROOT → a460c36c → 159fd148 | **derivative trees only**: 672a07bd and 827da8c7 = the originals minus `fixtures/artifacts/` |

- **Reproduction:** `frozen-0830-export/REPRODUCE-CHECK.txt`, all true, built from pushed 842ca044 material.
- **Stability:** INVENTORY `9bd6346d` was byte-identical across two exports, in both the export and capture jobs.

**E, the source-only derivative.** The original commits are a460c36c (tree 834322bd) and 159fd148 (tree a7f970a8).
- **Omitted:** 7 compiled contract artifacts (`fixtures/artifacts/*.json`). They are identical in both commits and are recorded
  by blob, sha256 and size in INVENTORY `derivative.omittedArtifacts`.
- **Kept:** every source, test, job, evidence and log file (52 files).
- **Recipe** (`frozen-0830-e-artifact-recipe.json`), read from each artifact's own solc metadata:
  - compiler 0.8.35+commit.47b9dedd, viaIR, optimizer runs 1;
  - evmVersion, remappings and compilation targets;
  - every source keccak256, and the creation and runtime bytecode keccak256.
- **Recipe sources.** 5 artifacts are covered by E's committed `fixtures/sources`. For the 2 test mocks, the 22 other sources
  were matched by keccak256 and copied, with the forge project's `foundry.toml`, into `frozen-0830-e-recipe-sources/`. 0 sources
  are missing.
- **Not compiled.** No compiler was run. The exact original trees cannot be rebuilt from this export until the artifacts are
  regenerated and reproduce the recorded bytecode hashes. I do not claim exact-tree reproduction.
- **E's active tree and history were not touched.**

**Manifest:** 2037 → **2235** (+198, 6,367,024 bytes); 0 changed, 0 removed.
- **Scans:** the export pre-scan has no leaks; the range `842ca044..cadf0ebb` gives scan-crypto-keys 0 and gitleaks no leaks
  (6.52 MB).
- **Hooks:** pre-commit and pre-push passed.
- **Tracking:** 2235/2235 entries are tracked, and the committed blobs match.
- **Post-push:** 53/53 frozen sources are unmoved.

**Also captured:**
- **A's reports:** `RESULT-WINDOWS-CONSUMERS.md` and patches 0010-0014.
- **F:** its RESULT, scripts and the hash lists of its artifacts and deploy files.
- **Root notes:** RPC-CONSUMER-GATE, plus the two ROOT-LIVE notes from F's directory (C's copies are byte-identical).
- **Log digests:** for F's and C's logs; the raw logs stay local.
- **Living documents:** dated snapshots of ROOT-PENDING-LATEST and the requirements, as of ~08:3xZ. Their earlier bytes stay
  under their original paths.
- **Receipt:** `checkpoint-verified-0745-20261023.json`.

**Not captured:**
- E's compiled artifacts;
- F's `release/` built artifacts (hashes only);
- the `rpc-priority/patches/SHA256SUMS` update (its path is already in the manifest; the Git-object patches are authoritative);
- raw logs;
- every later mutable tree: A after df8fbafa, F's host-service-rpc-closure, C after bbf0a009, S's browser-rpc-closure and E's
  closure.

**Attempts (logs retained):**
- `frozen-0830-export-1.*` failed because of my own over-strict assertion: E's patch text names the path `fixtures/artifacts/`,
  because the test reads it, but it adds no artifact file. The check was narrowed to diff headers.
- `frozen-0830-export-2.*` passed.
- Then `capture-1`, `checkpoint-{commit,scan,push}` and `postpush` ran.

Correction to the 07:45Z receipt: the first attempt's logs from that batch were deleted on retry. That is no longer done.
