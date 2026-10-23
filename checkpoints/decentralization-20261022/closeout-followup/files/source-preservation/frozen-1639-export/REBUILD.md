# frozen-1639 export: how to rebuild

"1639" is this batch's identifier: its actual start, 2026-10-23T16:39Z (`date -u`). It is not a publication time.

The export method is unchanged from frozen-1517:
- a first-parent series, one `git format-patch --full-index --no-renames` per commit, with hunk headers carrying no function
  context;
- a merge is one diff against its first parent;
- a commit touching only excluded paths has no patch;
- each changed file is stored at its head blob under `files/`;
- INVENTORY records every commit's hash, parents, tree, identity, time and subject.

## Exact trees

| Side | Base (already in pushed b995a73b) | Head |
|---|---|---|
| e-gen | ae00cd96 (frozen-1517 e-prod) | ff13ebe0 (tree 1cece8e6) |
| root-ram96c | 2ed6ba61 (frozen-1339 root-ram96b) | 6b756f84, e650fc09 → 3d42d7eb |
| root-rpc-review | empty tree (root commits) | 1d4920ca → 803c6975 |
| root-api-mcp2 | 95ee73dc (frozen-1517 root-api-mcp) | 844edbf2 |

`git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
`verify-frozen-1639-export.py` does this offline from b995a73b's stored patches, and its output is in `REPRODUCE-CHECK.txt`.

## Source-only derivatives

- **a-cv** (A, eab4cfac → fd8d5806; original head tree d8e0ab06).
  - **Base:** continues frozen-1517 a-receipts. The compiled `metal/guest/mcp-server.bundle.mjs` and its manifest stay held at
    their e32dd607 bytes.
  - **Unchanged here:** this range does not touch them; the identical blobs are asserted.
  - **Restore:** the frozen-1517 recipe, `convertedManifest` and validated rebuild apply. No new rebuild was run in this batch.
  - **Exported:** A's committed `credit-vault-submitter` role bundle (4c25cde6) is text and exported as committed.
  - **Also omitted:** its manifest `network/host-services/packages/credit-vault-submitter.package.json` (fa7403b5). The npm-name
    and sha256 pairs in it trip both unchanged scanners (gitleaks and `scan-crypto-keys` eth-key, export attempt 2). It is
    published as `converted/credit-vault-submitter.package.{inputs.sha256sums,meta.json}`, with the exact rebuild asserted. It is
    held at its base bytes, which are identical at e32dd607 and eab4cfac.
  - **Not rebuilt:** D did not re-run the role package's build.
- **e-gen-report** (E's report repo, root → d37f7a04, the root-accepted report).
  - **Omitted:** `exports/`, a binary git bundle and a patch duplicating e-gen.
  - **Not captured:** report commits after d37f7a04, which root has not accepted. They are listed in INVENTORY.
