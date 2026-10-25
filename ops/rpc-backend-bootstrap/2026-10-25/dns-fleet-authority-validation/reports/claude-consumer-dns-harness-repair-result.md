# DNS-relay review harness repair (r3 harness; PREPARED; root has NOT re-run it; no tests, bundle build, queue use, SSH or commit by Claude)

## Root r2 failure (preserved)
- **Run:** `root-consumer-dns-review-2300` (cap 512) exited **2**: a HARNESS failure before the bundle build and tests.
- **Copies** are in `consumer-remaining-stage/logs/root-2300-failed/`: the root `.out`, `.guard` and `.rc`, the failed
  launcher (`root-dns-review.r2-failed.sh`) and its manifest (`MANIFEST.r2.sha256`). The originals in `logs/` are
  untouched.
- **Cause (measured):**
  - r2 classified the tree with `tar -d` and filtered only `Uid/Gid differs`.
  - `git archive` writes tar modes **664/775** (git's default `tar.umask` 0002; it is unset in this repo). The tree was
    extracted under umask **022**, so on disk the files are **644/755**.
  - `tar -d` therefore reported `Mode differs` for every tracked entry, and the harness counted them all as deviations.
  - The tree is currently writable (`tree/relay` 755, files 644), not read-only. A read-only freeze would produce the same
    kind of mode difference. Either way, a permission-bit difference is not a source difference.

## Repair (harness only; product and test sources unchanged)
- **The tar check is removed entirely.** `jobs/verify_tree.py` (`08e6b813…`) checks **every tracked entry** of
  `git ls-tree -r e78a764d1` (8481 entries: 8177 × 100644, 295 × 100755, 9 symlinks; no gitlinks; no `.gitattributes`, so
  archive content equals the blobs). The blob bytes come from `git cat-file --batch`.
  - **Regular files:** must be regular files, not symlinks, with a sha256 equal to the git blob's.
  - **Symlinks:** must be symlinks whose target equals the blob's link text.
  - **The two overlaid files** (`relay/fleet.mjs`, `relay/dns-relay.js`) must equal their src pins AND differ from git.
  - **The two added tests** must exist and equal their pins.
  - **`node_modules` and `network/node_modules`** must be symlinks with the exact pinned targets, and are never descended.
  - **Any other file, symlink or special file present is UNEXPECTED and fails.** Byte differences are never ignored.
  - **Permission bits are not compared** (intentional, documented). The executable bit is still reported
    (`execBitMismatch`) for review, and never used to excuse a content difference.
  - **Phase `post`** additionally allows exactly the two generated bundle files, recorded by sha256.
- **Pins:** `jobs/tree-pins.json` (`3986207d…`) holds:
  - the rev `e78a764d1df935fbc74b27348b82115803b885ce`;
  - the overlaid pins: `fleet.mjs` `3f6d7900…`, `dns-relay.js` `d775a7bd…`;
  - the added-test pins: `fda019c5…`, `88ee9c8f…`;
  - the symlink targets: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules` and
    `…/enclave/network/node_modules`;
  - the 2 generated file names.
- **Launcher `jobs/root-dns-review.sh` (`bff67d78…`):**
  1. bring up `lo` and check that it is UP;
  2. verify `MANIFEST.sha256`;
  3. check the reference rev exists;
  4. `verify_tree.py … pre` (JSON written to `logs/tree-verify-pre-<UTC>.json`);
  5. refuse a pre-existing bundle;
  6. require `tree/relay` to be writable, because the bundle must sit beside `dns-relay.js`. If root freezes the tree,
     only that directory needs to be writable;
  7. build the bundle and record its sha256 and manifest;
  8. `verify_tree.py … post` (the build may add only the 2 generated files);
  9. run the 4 suites, unchanged;
  10. a final `post` verification, so the tests may not leave files behind (rc 1).

  It exits 1 on a failed suite and 2 on a harness error.
- **Stage manifest:** `MANIFEST.sha256` = `022274130d3a19e42c41df5abea2c84e38964744baea0722a6cf08bde5fa8f08`. It covers
  BASE, base, src, jobs, both patches, the r1 test copy, `root-2300-failed/` and the tree's 4 overlay/added files.
- **Unchanged since r2:** the product, test, base and patch pins (checked against `MANIFEST.r2.sha256`).
  `consumer-remaining.r2.patch` is still `4f7f7d36…`.

## Claude pre-checks (read-only verifier runs; NOT tests, NOT root evidence)
- **First attempt hung, a real harness bug that is now fixed:** it wrote all object IDs to `git cat-file --batch` before
  reading, so both pipes filled and it deadlocked. It was stopped after 120 s. stdin is now fed from a thread.
- **`pre` against the tree:** rc 0. 8481 tracked entries were verified by content/target; overlaid 2, added 2, links 2;
  `execBitMismatch` 0; 0 failures (`consumer-remaining-stage/logs/claude-precheck-tree-verify-pre.json`).
- **Negatives against tampered pins** (`logs/claude-precheck-negatives/`; the tree was not modified):
  - a wrong overlay pin → rc 1 "overlaid file differs from its src pin";
  - a dropped allowed link → rc 1 "unexpected file network/node_modules";
  - the parent rev → rc 1, 7 "content differs" (e.g. `custody/chain.mjs`).

## Root command (unchanged)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/consumer-remaining-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $S/logs/root-dns-review.guard -- unshare -rn bash $S/jobs/root-dns-review.sh
```
The bytecode release currently holds the large lane. This job needs the 512 lane only.

## Limits
- **Untrusted metadata:** permission bits are deliberately not verified; owner and mtime are not used.
- **Git object integrity** comes from the reference repo `relay-consumer-source` (read via git plumbing at the pinned rev).
- **Not established:** the 4 suites (including the never-run smoke env) and the bundle build. The previous review report's
  limits still apply (`logs/claude-consumer-dns-review-result.md`).
- **No deployment or cutover is claimed.**
