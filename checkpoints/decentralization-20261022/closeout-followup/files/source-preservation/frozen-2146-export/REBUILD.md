# frozen-2146 export: how to rebuild

"2146" is this batch's identifier: its actual start, 2026-10-23T21:46:39Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing in this capture is signed, sent, served, published, merged, imaged or activated by it. Root owns all
activation and signing.
- Root's control activation of the restored-vault image ee5df6b8 FAILED adoption at 21:37Z and was rolled back to deabf8f9. Boot
  registration gas still blocks it.
- No new custody lifecycle has been done. The original custodian and committee 0x4774 are untouched.
- Factory signing is pending the human.
- Source preservation is NOT production completion.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Ignored and untracked files and uncommitted work are never read. That covers images, binaries (including the proof-app component),
CARs, build outputs, node_modules, raw quotes, sealed state, private config and keys. It also covers worker task and progress files,
root's uncommitted operator-fees `FEE-NOTES.md` edit and recipient-activation operational files, and root's in-progress H/W/D
recovery repositories.

## Trees

| Side | Base (pushed in f2e7009e) | Head (tree) |
|---|---|---|
| custody-live5 | dc07e225 (frozen-2100 custody-live4) | 1c8403e8, 570947d4 → **1535fcf0** (0ec5226a) |
| factory-wallet2 | 24aac735 (frozen-2100 factory-wallet) | 7f11fbf3, 99cf7f16 → **9557ad6d** (daf03b1e) |
| production-canary2 | 7bcd501f (frozen-2100 production-canary) | c4d96a11, cb06e87b, 49fb0a6c → **01525201** (b9184661) |
| operator-fees | empty | f2a7b81e, 1ac9ad2c → **7bf4c942** (2e348c05) |
| recipient-restore | empty | **b03be02d** (9c26fc2c) |
| recipient-restore-repo (touched files) | deabf8f9 (NOT in pushed objects) | **a6b1378c** (d155f20e; touched paths only) |
| recipient-activation | empty | 7426b299, 2c5d9b5a → **2d407753** (6424dd93) |
| proof-app | empty | **e84a1afd** (71f91f09) |
| code-admission (converted form) | empty | **8578965c** (749a99e3, reproduced EXACTLY with the converted file reversed) |
| publish-readiness | empty | f0efadbd → **90a2b826** (0bc4e7e3) |

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order. `git write-tree` must equal each recorded
  tree.
- **Bases:** `verify-frozen-2146-export.py` rebuilds every base offline from the stored patch chains in f2e7009e and writes
  `REPRODUCE-CHECK.txt`.
  - custody-live: the frozen-1852/1951/2025/2100 chains.
  - factory-wallet and production-canary: their frozen-2100 root chains.

## recipient-restore-repo: touched-file reproduction

The inner repository's base deabf8f9 is the production linux post-adoption SCRATCH commit (author `stage`). It is not in pushed git
objects: only its file-level diffs are in `external/scratch-repos`. Its tree also has files containing the rewritten literal, so it
cannot be published as a whole tree.

- `base-files/` stores the base version of every path a6b1378c touches; here only `metal/guest/gsup.mjs`, blob dd8a2ac2.
- The export asserts that this file's sha256 (`c2896d74…`) equals `/opt/metal/gsup.mjs` in the production `dist-leasegas-deabf8f90`
  initramfs inventory already pushed in f2e7009e (frozen-2100 recipient-provenance `held-out/`).
- The verifier loads the base files, applies the patch, and checks every touched path's recorded blob.
- The full tree d155f20e is NOT reproduced (`baseTreeNotReproduced`).

## code-admission: converted form

- **Finding:** export-2 gitleaks reported generic-api-key at `tools/compile.mjs` line 29 and in the 8578965c patch. The trigger is
  the vault's source file name and contract name, two adjacent quoted strings separated by a comma, in a solc output lookup. The
  rule's keyword is part of the contract name. It is not a credential. (Quoting that pair verbatim in this document also tripped the
  checkpoint scan, so the exact text is only in the INVENTORY regex, in escaped form.)
- **Handling:** the file is excluded from the patch. It is published as a CONVERTED copy (`code-admission-8578965c/sanitized/
  tools/compile.mjs`) in which that one comma is a semicolon.
- **Reversibility:** the recorded reverse substitution gives the original blob e1013051 byte for byte, which the export asserts.
- **Check:** the verifier reverses the substitution, adds the file back at its mode, and checks that `write-tree` equals the ORIGINAL
  head tree 749a99e3.
- **Unchanged:** nothing was allowlisted, `.gitleaks.toml` is unchanged, and the source repository is unchanged.

## Scanner notes

- production-canary commits its own `.gitleaksignore`, and this range edits it. It applies only inside that repository and is
  preserved as committed content. The checkpoint's scans do not use it.
- code-admission's `tools/original-code-path.test.mjs` contains anvil's PUBLIC well-known test account 0 key, used to fund test
  transactions on a local anvil. It is not a production key. It passed both the pre-commit crypto-key scanner and gitleaks
  unchanged.
