# Rebuilding the exported commits (rpc-native-codec-export)

Everything here was read from Git objects at the exact commits listed in `INVENTORY.json`. Mutable worktrees were never
read. `REPRODUCE-CHECK.txt` records every commit tree rebuilt exactly by `source-preservation/verify-native-codec-export.py`.

## B: listener `commitment-mode` 5e17867 (code a0c7c4e) on f3159ea

1. Rebuild f3159ea from the head-listener files already in this checkpoint
   (`source-preservation/head-listener-f3159ea-inventory.json` lists path, mode and blob; tree 298e1ef5).
2. `git am b-listener-commitment-mode-5e17867/patches/*.patch` (or `git apply` in order).
3. Vendor upstream: `python3 -I tools/prepare-upstream.py base-5476069f.tar.gz`.
   * Tarball: `https://codeload.github.com/base/base/tar.gz/5476069f1eb74a56bccb56fdefd4b4bb0e3cda42`, sha256
     `9784e20a…8012`.
   * The 9 crate manifests are unmodified.
4. Rust 1.96.0, then `./build-commitment.sh` (queue 1536; observed peak 743 MiB).
5. Expect the debug binary sha256 `ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a`. It was built
   from a0c7c4e on this host; reproducibility on other hosts is not claimed.

Cargo.lock is in the patches: one line differs from f3159ea, and all 625 packages are identical to base/base's lock.

## B: bridge d2f9e0c (new repository, root edf722f)

1. `git init && git am b-gossip-bridge-d2f9e0c/patches/*.patch`.
2. Supply the listener binary at `artifacts/enclave-base-head-listener` (see above). The digest is pinned in
   `network/gossip-head-source.mjs` (`TESTED_LISTENER_SHA256`).
3. Make viem 2.53.1 available as `node_modules`; the evidence run symlinked worker A's tree.
4. Run `jobs/bridge-tests.sh` (queue 768, inside `unshare -r -n`): 28/28 at r8.

## C: host-services composition d7f520bf

`git checkout f58e03ec4` (on this branch), then `git am c-host-services-compose-d7f520bf/patches/*.patch`.
* Patches 0001–0006 rebuild C's base d281007c, which is the parent of the accepted composition a6fb7aab.
* Patch 0007 is exactly d281007c..d7f520bf.

**Not production-ready:** the hostServices zero-app gate (ROOT-HOST-SERVICE-COLD-REVIEW.txt) and the generated-package CLI
guard are outstanding.

## D: Linux unknown-wallet hold 09ff3ed5

`git checkout 2bbea898` (on this branch), then `git am d-linux-wallet-unknown-09ff3ed5/patches/0001-*.patch` (3 files).

The epoch / failed-stop review is pending (ROOT-LINUX-HOLD-REVIEW.txt). There is no image or deployment.
