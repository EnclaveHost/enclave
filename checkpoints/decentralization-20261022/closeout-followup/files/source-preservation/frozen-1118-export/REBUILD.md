# frozen-1118 export: how to rebuild

"1118" is this batch's identifier: its actual start, 2026-10-23T11:18Z (`date -u`). It is not a publication time.

Every side was exported from Git objects only: `git format-patch --full-index --no-renames` over the exact range, plus each
changed file at its commit blob under `files/`. `INVENTORY.json` records, per commit, its hash, parent, tree, author and committer
(all SteveDeFacto / noreply), its commit time and its subject.

## Exact trees

| Side | Base (already in pushed checkpoint material, f2db53ff) | Head |
|---|---|---|
| tls-m | 4106c311 (frozen-0830 f-final recipe) | 1957ff23, 6f6d22f5 (TLS worker final; also HEAD of `nucbox-tls-recovery-20261023/candidate`) → 9f19b7c6 (M final; `windows-memory-accounting.patch` sha256 eeab54d2…) |
| s-compose | bcd3d9ca (frozen-0830 s-root-doc) | c74e302c → 92b71784 |
| rsfc-report, root-ram96, root-allowlist, root-iface, root-mem, root-main-delta, root-capacity, root-immutability, cache-boundary | empty tree (root commits) | as INVENTORY |

`git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
`verify-frozen-1118-export.py` does this offline from f2db53ff's stored patches, and its output is in `REPRODUCE-CHECK.txt`.

## Source-only derivatives (patches reproduce the DERIVATIVE trees only)

- **p-compose** (f8351487 → f8c999ed).
  - **Base:** frozen-0931 p-l1's derivative tree.
  - **Omitted:** the same 5 paths as frozen-0931 p-l1, with identical blobs: the upstream lighthouse `genesis.ssz.zip`
    (28405c78), the upstream `release.yml` (75a69cf0), and three P job logs that quote Sigma Prime's public PGP fingerprint.
  - **Restore:** frozen-0931's `omittedRecipe` and `omittedFingerprintFiles` apply unchanged.
- **e-final** (ca818b75 → 7 commits → 9c5e0eef).
  - **Base:** frozen-0931 e-closure's derivative tree.
  - **Omitted:** `fixtures/artifacts/` and `exports/`, as before.
    - The 13 compiled fixtures are unchanged in this range (identical blobs), so `frozen-0931-e-artifact-recipe.json` still
      pins every one.
    - `exports/` now holds E's own source-only patch series and `ARTIFACT-RECIPE.json`, which duplicate the Git objects. It is
      recorded by blob and sha256 in INVENTORY `exportsOmitted`.
  - **Commits with no patch:** 029fdefe and 9c5e0eef touch only `exports/`, so the derivative has no patch for them. The
    verifier checks that the derived tree is unchanged across them.
  - **Gap carried from frozen-0931:** that batch published E's `evidence/capture/*.json` (public-chain bytecode captures).
    E's own source-only export treats them as non-source. They are unchanged in this range, not re-exported, and the prior
    entries are not altered.
