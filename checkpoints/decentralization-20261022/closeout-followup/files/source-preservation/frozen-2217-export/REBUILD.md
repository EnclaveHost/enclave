# frozen-2217 export: how to rebuild

"2217" is this batch's identifier: its actual start, 2026-10-23T22:17:46Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing in this capture is signed, sent, served, published, merged, imaged or activated by it. Root owns all
activation and signing.

**State at the freeze (provisional; root's 22:14Z journal):**
- metal0 control recovery is IN PROGRESS. The control is still on the old image and unregistered.
- The approved image 08d1f838 is staged and admitted but NOT activated. Root stopped the cutover before any mutation after a
  pre-discovery GPU-price race was found.
- The boot-pricing fix is pending and not included.
- There is no new custody committee, policy, v2 book entry or dashboard publication.

**How each side was exported.** From Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

**Never read:** ignored and untracked files and uncommitted work. That includes root's runtime files in custody-boot-activation
(logs, private, evidence, approval, admission and plan files covered by its `.gitignore`), binaries, WASM and components, raw quotes,
keys, and worker task and progress files.

## Trees

| Side | Base (pushed in dfb4b55e) | Head (tree) |
|---|---|---|
| custody-live6 | 1535fcf0 (frozen-2146 custody-live5) | **ed284731** (b84ef921) |
| recipient-restore2 | b03be02d (frozen-2146 recipient-restore) | e02b3bd4 → **8f72453b** (1eb98032) |
| boot-source (PATCH-ONLY) | a6b1378c (frozen-2146 recipient-restore-repo, touched files) | **9f6d37bd** (59f0a46d; not reproduced as a whole tree) |
| recipient-activation2 | 2d407753 (frozen-2146 recipient-activation) | cb7fa858, c83f2b39 → **48cc74bf** (9d278ae1) |
| boot-activation (derivative) | empty | fa76e9bb → **86c5fee8** (orig e4b4b85c; derived tree in INVENTORY) |
| proof-app2 | e84a1afd (frozen-2146 proof-app) | ac33146d → **ad81dd59** (d2aadd32) |
| current-docs | empty | dd9cc622, 42015b1e, 9d58a8b2, dfca5f05 → **a257c0e0** (89f863af) |

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order. `git write-tree` must equal each recorded
  tree.
- **Bases:** `verify-frozen-2217-export.py` rebuilds every base offline from the stored chains in dfb4b55e and writes
  `REPRODUCE-CHECK.txt`.
  - custody-live: the 1852/1951/2025/2100/2146 chains.
  - The others: their 2146 root chains.

## boot-source: patch-only

The parent tree (the production scratch lineage) has files containing the provider name the 2026-10-21 rewrite removed. So does
`supervisor.js` itself, at both base and head. Neither is published, and no literal is waived.

**What is published:**
- the exact patch, which is literal-free;
- `test/registry-advertise-retry.test.mjs` at base (`base-files/`) and head (`files/`).

**What the export asserted against the real parent:** a throwaway index of a6b1378c plus the patch gives the 9f6d37bd tree 59f0a46d.

**What the verifier checks from pushed material:**
- the stored base test file plus the patch, restricted to that path, gives the recorded head blob;
- the patch's index line names exactly the recorded supervisor.js base and head blobs;
- the supervisor.js base sha256 equals `/app/supervisor.js` in the production dist-leasegas-deabf8f90 initramfs inventory pushed in
  f2e7009e (frozen-2100 recipient-provenance `held-out/`).

The full tree is NOT reproduced.

## boot-activation: committed runtime baseline omitted

Root asked for this side as source, provenance and tests only. The one committed runtime record,
`evidence/original-baseline-20261023T213130Z.json` (a read-only production unit and config baseline), is excluded. Its blob and
sha256 are in `omittedAtHead`.

With it restored from the source repository, the tree equals the original e4b4b85c.

The committed queue logs of tests and probes, and the test fixtures, are preserved.
