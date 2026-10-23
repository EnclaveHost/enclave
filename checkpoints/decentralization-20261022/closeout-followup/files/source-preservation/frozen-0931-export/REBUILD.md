# frozen-0931 export: how to rebuild

"0931" is this batch's identifier: its actual start, 2026-10-23T09:31Z (`date -u`). It is not a publication time.

Every side was exported from Git objects only: `git format-patch --full-index --no-renames` over the exact range, plus each
changed file at its commit blob under `files/`. `INVENTORY.json` records, per commit, its hash, parent, tree, author and committer
(all SteveDeFacto / noreply), its commit time and its subject.

## Exact trees (patches reproduce the recorded commit trees)

| Side | Base (already in pushed checkpoint material) | Apply |
|---|---|---|
| a-parity | df8fbafa = frozen-0830 a-windows recipe | `a-parity-e32dd607/patches/*` → e32dd607 |
| b-runtime-final | df8fbafa (same) | `b-runtime-final-c31e975a/patches/*` (19) → c31e975a, tree 6fbe601d |
| f-rpc-closure | 4106c311 = frozen-0830 f-final recipe (merge diff vs first parent) | 3 patches → 14d1e495 |
| c-drain | bbf0a009 = frozen-0830 c-storage-write | 4 patches → 19b91486 |
| s-browser | e820e240 = frozen-0830 a-windows, first 4 patches | 2bd1eea (ROOT WalletConnect), 349318a0 |
| s-report, root-pg, root-tls | empty tree (root commits) | all patches, in order |

`git init`, then `git read-tree` the base and `git apply --cached` each patch in order; `git write-tree` must equal the recorded
tree. `verify-frozen-0931-export.py` does exactly this, offline, from cadf0ebb's stored patches. Its output is in
`REPRODUCE-CHECK.txt`.

## Source-only derivatives (patches reproduce the DERIVATIVE trees only)

- **p-l1** (P rpc-l1-source-package, root → f8351487).
  - **Omitted:** one vendored upstream binary,
    `evidence/sources/lighthouse-v8.3.2/common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip`.
    It is git blob 28405c78f0daddee3e132ccb6976f71ea56fb28c, 1,616,593 bytes, sha256 in INVENTORY `omittedRecipe`.
  - **Restore:** take that path from sigp/lighthouse v8.3.2 (tree a376defa; P's own pin is
    `evidence/trees-20261023T061333Z/lighthouse-v8.3.2-tree.json`). Its git blob id must match.
  - **Also omitted:** four text files that quote Sigma Prime's PUBLIC release-signing PGP fingerprint. The checkpoint's unchanged
    gitleaks config flags that value; P allowlisted it in its own config (7d5ccb1f). The files are:
    - `evidence/lighthouse-binary-20261023T080144Z/release.yml`: restore it from sigp/lighthouse v8.3.2 `.github/workflows/release.yml`
      (upstream blob 75a69cf0, pinned in the same tree JSON);
    - `logs/fetch-lh-2.out`, `logs/verify-lh-2.out` and `logs/verify-lh-3.out`: P's job logs, kept only in P's repository.
    Their blobs and sha256 are in INVENTORY `omittedFingerprintFiles`.
  - With all five files restored, the trees equal the originals: for example, f8351487's original tree is 727e029d2….
- **e-closure** (E rpc-transaction-independence, 159fd148 → ca818b75).
  - **Base:** 159fd148's derivative tree 827da8c7, from frozen-0830.
  - **Omitted:**
    - `fixtures/artifacts/`: 13 compiled solc outputs. 7 are byte-identical to frozen-0830's; 6 are new.
    - `exports/`: E's own format-patch files and git bundle, which embed those outputs.
  - **Recipe:** `source-preservation/frozen-0931-e-artifact-recipe.json`. It records, per artifact:
    - the compiler 0.8.35+commit.47b9dedd and its settings (viaIR; optimizer runs 1 or 200);
    - every source keccak256 and where an exact copy is published: E's `fixtures/sources`, frozen-0830's recipe sources, or
      cadf0ebb's own `contracts/EnclaveDeployments.sol`;
    - the creation and runtime bytecode keccak256 that a regeneration must reproduce.
  - **Not done:** no compiler was run, so the exact original trees (ca818b75: d91cec5af…) are not claimed.

## D installed NucBox baseline

`d-installed-baseline/BASELINE.json` records:
- **Exported here:** the installed source files that were not yet in the checkpoint's history, found by git-blob reachability
  from cadf0ebb over 116 repo-source inputs of the installed builds. That is only `network/enclave-network-host.mjs` (2c1b84aa).
- **Recorded by relation:** the installed `relay/snp-verify.mjs` (10520dd2) is not exported. Applying the 2026-10-21
  repository-rewrite transform to it gives the preserved 93f9e9d2, so its bytes would only reintroduce the rewritten literal.
- **Build manifests:** the cfb69370 1938-input manifest and the g4 composition manifests. They are published as
  `sha256  path` text (`*.inputs.sha256sums`), not JSON. In the JSON, an npm file name such as `privateKeyToAccount.js`
  precedes its sha256, and the checkpoint's unchanged gitleaks rules misread that as a labelled key. Each entry's
  `convertedFromJson` records the original sha256 and the exact Python `json.dumps` call that rebuilds the original bytes from
  the text; the export asserts that round-trip. D's review w1 manifests are published the same way under `review-w1/`.
- **Omitted compiled bundles and executables:** each with its sha256 and recipe. For the two Go executables the build
  revision is unknown, and they are a root read-only capture item.

The review that uses these files, with its tests and the F/A handoff, is `windows-upgrade-delta-review/` (pinned in
INVENTORY `frozenSources`).
