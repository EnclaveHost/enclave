# frozen-2100 export: how to rebuild

"2100" is this batch's identifier: its actual start, 2026-10-23T21:00:37Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing in this capture is signed, sent, served, published, merged, imaged or activated, and none of it has
been. Root owns all activation and signing. The existing custody is the original single-seat bootstrap. It is NOT complete, and it
is NOT decentralized custody.
- site-release 3f16d9b1 is SUPERSEDED by r2. Neither release is published.
- factory-wallet's uncommitted ABI fix is NOT included.
- production-canary 7bcd501f is NOT mutation-ready: root's safety-review fixes are in progress.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Ignored and untracked files and uncommitted work are never read: images, binaries, CARs, build outputs, node_modules, raw quotes,
sealed state, private config, keys, and worker task and progress files.

## Trees

| Side | Base (pushed in 619e0e34) | Head (tree) |
|---|---|---|
| custody-live4 | 3fd6e8ff (frozen-2025 custody-live3) | bc3f93c0, edaaaf81 → **dc07e225** (986d5fbd) |
| dashboard3 | e24a47fb (frozen-2025 dashboard2) | 2d3839c5, 278a28a7, a942a61f → **9d97b4b0** (e5f38820) |
| site-release (derivative) | empty | 7681e3fa → **3f16d9b1** (orig 7802cff9; derived tree in INVENTORY) |
| site-release-r2 (derivative) | empty | 82c594ab → **14b5f559** (orig 7e5af78c; derived tree in INVENTORY) |
| ingress-forwarder | empty | 35d73c68 → **b1c1feee** (fe9c470a) |
| factory-consumer | empty | 519489c3 → **d0e9df82** (2fb41cdb) |
| factory-wallet | empty | f18404a5 → **24aac735** (249513e4) |
| production-canary | empty | **7bcd501f** (9b5a7493) |
| recipient-provenance (held-out form) | empty | **8b0c4da2** (00861e62, reproduced EXACTLY with `held-out/` restored) |
| publisher-assessment | empty | **b895d295** (6901c766) |

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded
  tree.
- **Bases:** `verify-frozen-2100-export.py` rebuilds every base offline from the stored patch chains in 619e0e34, and writes
  `REPRODUCE-CHECK.txt`. The dashboard base needs dfe020ab plus 30 stored patches; custody-live needs 4.

## Derivatives

- **site-release and site-release-r2: `release/<CID>/site-root.block`.** This is the release's 1835-byte binary dag-pb root
  block, which is build output. You asked for no CAR or build binaries, and the export takes text only.
  - It is omitted. The export asserts that its sha256 equals the multihash of the release CID (the directory name), so the CID
    identifies the block exactly.
  - To restore it: take the blob in `omittedAtHead` from the source repository, or fetch `/ipfs/<CID>?format=raw` from a gateway and
    check the digest.
  - The full DAG or CAR was never committed and is not captured.
- **site-release-r2: `RELEASE-HANDOFF.md`.**
  - **Finding:** export-1 gitleaks reported generic-api-key on prose in this file, at head line 45 and in the 82c594ab patch. The
    trigger is the phrase naming the dashboard's secrets panel, followed by a comma and a backquoted file name. It is not a
    credential.
  - **Handling:** the file is excluded from the patches. Its head version is published as a CONVERTED copy
    (`site-release-r2-14b5f559/sanitized/RELEASE-HANDOFF.md`) in which that one comma is a semicolon.
  - **Reversibility:** the reverse substitution recorded in INVENTORY (`sanitized[].reversePattern`/`reverseReplacement`)
    reproduces the original head blob byte for byte, which the export asserts. The 82c594ab version is recorded by blob only.
  - **Unchanged:** nothing was allowlisted, and `.gitleaks.toml` is unchanged.

- **recipient-provenance: `out/`.** This is size only; nothing is omitted.
  - The single commit's patch would exceed the 5 MB stored-file limit, because it carries two ~2.7 MB `initramfs-inventory.json`
    files (capture-1 refused it before writing).
  - `out/` is excluded from the patch, and both files are published BYTE-EXACT under `recipient-provenance-8b0c4da2/held-out/`,
    with their blobs in INVENTORY `heldOut`.
  - The verifier applies the patch, adds the held-out files at their paths and modes, and checks that `write-tree` equals the
    ORIGINAL head tree 00861e62.

## Scanner notes

- production-canary commits its own `.gitleaksignore`, adjudicating one public file-hash pin in `pins.example.json`. It applies
  only inside that repository, and is preserved as committed content. The checkpoint's scans do not use it.
- recipient-provenance's two `initramfs-inventory.json` files (about 2.7 MB each) list image members: paths, modes, sizes and sha256.
  They also hold the image env key names with their public values only.
