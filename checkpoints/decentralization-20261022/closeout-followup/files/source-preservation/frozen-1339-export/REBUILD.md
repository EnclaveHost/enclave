# frozen-1339 export: how to rebuild

"1339" is this batch's identifier: its actual start, 2026-10-23T13:39Z (`date -u`). It is not a publication time.

Every side was exported from Git objects only: `git format-patch --full-index --no-renames` over the exact range, plus each
changed file at its commit blob under `files/`. `INVENTORY.json` records, per commit, its hash, parent, tree, author and committer
(all SteveDeFacto / noreply), its commit time and its subject.

## Exact trees

| Side | Base (already in pushed 476c589b) | Head |
|---|---|---|
| s-role | 14d1e495 (frozen-0931 f-rpc-closure) | 02862306, 4c059b99 → 36919aaf |
| s-report, t-hdd, root-wallet-iface, root-shutdown | empty tree (root commits) | as INVENTORY; t-hdd tree a5cb6fff |
| b-launch | fad657bc (frozen-0745 d-linux-carrier) | 27 commits → 673601e5 (tree ea4b9cac), then the result branch's d9c1bb19 |
| f-baseline | 14d1e495 | 6fd9a787, c335c76c, 30339303 → 1f19ad15 |
| e-wallet | 349318a0 (frozen-0931 s-browser) | 6ab298f1 → dc2e5d74 |
| root-ram96b | dd7e7af8 (frozen-1118 root-ram96) | f3ba7703, 237c78f2 → 2ed6ba61 |

`git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
`verify-frozen-1339-export.py` does this offline from 476c589b's stored patches, and its output is in `REPRODUCE-CHECK.txt`.

## Source-only derivatives

- **a-gaps** (A, e32dd607 → 40f2b0a9 → 554a251c; original head tree f34efc10).
  - **Base:** e32dd607, preserved EXACTLY, so it already carries an older `metal/guest/mcp-server.bundle.mjs`.
  - **Omitted:** 554a251c rebuilt that file into a 5,052,898-byte compiled esbuild bundle, above the capture's 5 MB per-file
    bound. It is git blob in INVENTORY `omittedAtHead`, sha256 ae7088a7…. The derived trees hold it at its e32dd607 bytes.
  - **Also omitted:** the bundle's tracked manifest, `metal/guest/mcp-server.bundle.mjs.manifest.json`. Its JSON pairs npm file
    names such as `privateKeyToAccount.js` and `setCoinbase.js` with 64-hex sha256s, which the checkpoint's unchanged gitleaks
    rules read as labelled keys. It is published as `converted/*.manifest.inputs.sha256sums` (`sha256  path`) plus
    `*.manifest.meta.json` (the other fields). INVENTORY `convertedManifest.rebuild` gives the exact Python call that rebuilds
    the committed bytes, and the export asserts it. Restore the manifest first.
  - **Restore:** in the a-gaps tree with A's package-lock node_modules, run `node scripts/build-mcp-guest-bundle.mjs`.
    - The exported `metal/guest/mcp-server.bundle.mjs.manifest.json` pins 2974 input sha256s and the bundle sha256 ae7088a7.
    - `build-mcp-guest-bundle.mjs --check` refuses unless both match.
    - **Validated** by `frozen-1339-a-bundle-check-4.sh` and its log `-4.out`: a throwaway clone of 554a251c at the same
      depth as A's repo, carrying A's own node_modules links (`.`, `relay`, `sdk/sessions`). The build uses esbuild
      `preserveSymlinks`, so inputs keep their in-tree paths. `--check` rc 0.
    - **Attempts 1–3 failed** (logs kept locally): a dangling link in a deeper clone; real copies, which rebuilt to different
      bytes; and a clone without `sdk/sessions/node_modules`, which left out 434 of the 2974 manifest inputs.
- **p-cache** (P cache-composed-kernel-delta, root → e8e86801).
  - **Omitted:** one evidence log, `run/20261023T112303Z/out/receipts.jsonl`. Two of its result lines trip the unchanged gitleaks
    generic-api-key rule on a JSON `"key"` field.
  - **Restore:** it is kept in P's repository (blob and sha256 in `omittedAtHead`). Every other file is exact.
- **e-report** (E's report repo, root → ec2be533).
  - **Omitted:** `exports/`, E's own export. It holds a git bundle (binary) and patches that duplicate e-wallet's Git
    objects; each is recorded by blob and sha256.
  - **Restore:** the e-wallet patches reproduce those commits; recreating the bundle from them is not byte-identical by design.

## Not archived

- **S's untracked role packages** (`network/host-services/packages/`, a build output). Their hashes and recipe
  (`scripts/build-host-service-packages.mjs`) are in INVENTORY `sides.s-role.untrackedBuildOutputs`.
  `public-rpc.package.json` = 300cdc81, matching S's report. D did not rebuild them.
- **Untracked files in every repo**, and every active successor tree (INVENTORY `notPreserved`).
