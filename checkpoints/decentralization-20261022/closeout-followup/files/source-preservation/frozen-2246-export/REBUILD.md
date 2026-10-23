# frozen-2246 export: how to rebuild

"2246" is this batch's identifier: its actual start, 2026-10-23T22:46:00Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing in this capture is signed, sent, served, published, merged, imaged or activated by it. Root owns all
activation and signing.

**State at the freeze** (root, 22:45Z):
- The metal0 control is still on the old image and unregistered. Recovery is NOT done.
- The boot-pricing candidate 7dd3acd0 was built twice, byte-identical, at 22:29 (measurement b007d471…). It is NOT activated.
- The new D activation kit is under review. It is NOT included.
- No committee, admin contract, book or dashboard change, and no secret lifecycle test.

**How each side was exported.** From Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

**Never read:** ignored and untracked files and uncommitted work. That includes:
- canary-wallet `journals/` (the server is live);
- boot-price-release's image binaries (`initramfs.cpio.gz`, `vmlinuz`; their sha256 are in the committed `INVENTORY.sha256`);
- WASM, node_modules, raw quotes, keys, private files and signatures, and task and progress files.

## Trees

| Side | Base (pushed in 7ca36e11) | Head |
|---|---|---|
| custody-live7 | ed284731 (frozen-2217 custody-live6) | d64f0443 → **b4e1f14** |
| boot-source2 (PATCH-ONLY) | 9f6d37bd (frozen-2217 boot-source, patch-only) | **7dd3acd0** (not reproduced as a whole tree) |
| boot-price-release | empty | a340762b → **88b70dbe** (root-granted public build metadata) |
| canary-wallet | empty | f161ceb → **b5e4613** |
| current-docs2 | a257c0e0 (frozen-2217 current-docs) | ac4d9da, c571a3f, 8fda71f2 → **1b3c2611** |

Head trees are in INVENTORY.

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order. `git write-tree` must equal each recorded
  tree.
- **Bases:** `verify-frozen-2246-export.py` rebuilds every base offline from the stored chains in 7ca36e11.
  - custody-live: the 1852/1951/2025/2100/2146/2217 chains.
  - current-docs: its 2217 root chain.

## boot-source2: patch-only (the prior boot-source method)

`supervisor.js` contains the provider name the 2026-10-21 rewrite removed, at both base and head, so it is not published. No
literal is waived.

**What is published:**
- the exact patch, which is literal-free;
- `metal/guest/gsup.mjs` and the two tests at base and head. `test/boot-gpu-price.test.mjs` is new.

**Base-blob anchors** (asserted at export and again by the verifier). Every base blob equals a PUSHED record:
- `supervisor.js` and `test/registry-advertise-retry.test.mjs`: the frozen-2217 boot-source touched head blobs;
- `metal/guest/gsup.mjs`: the frozen-2146 recipient-restore-repo touched head blob.

**Export-time check:** a throwaway index of the real parent 9f6d37bd plus the patch gives the 7dd3acd0 tree.

The full tree is NOT reproduced.

## boot-price-release 88b70dbe: root-granted metadata

Root granted (`ROOT-PRESERVE-2245.txt`) a commit of exactly these root-produced public build files. The export asserts that
88b70dbe touches only them:
- `APPROVED-COMMIT.txt`;
- `stage/build-record.json`, `stage/INVENTORY.sha256` and `stage/7dd3acd06-on-9f6d37bd.patch` (sha256 7283a33a…, equal to the build
  record);
- `logs/root-build-price.{out,guard.log,rc}`;
- `stage/dist-leasegas-7dd3acd06/{MEASUREMENT,manifest.json,cmdline}`.

The build scripts and the approval are unchanged. The image binaries were never committed.
