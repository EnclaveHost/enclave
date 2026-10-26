# browser-authority-stage r2: fixture/harness repair (PREPARED; NOT run). The product patch is unchanged from r1

## Root r1 result (preserved, unchanged)
- **Run:** `root-browser-authority-tests-0008`, rc 1. The logs are root's `logs/root-browser-authority-tests-0008.*` and
  `../logs/root-browser-tests-20261026T000718Z/`. r1's stage files still verify (`../MANIFEST.sha256` `27367c77…`).
- **Failures and their fixes in r2:**
  1. **New suite 7 pass / 4 fail:** `Cannot find module /tmp/network/host-policy-mirrors.mjs`. The fixture copied only
     `site/js`, but `site/js/core/independent.js` imports `../../../network/*.mjs`.
     - **Fix (test only):** the fixture now copies the REAL transitive relative-import closure of `config.js` +
       `chain.js` (static, re-export and literal dynamic imports; 122 files incl. 5 `network/` modules), each at its
       repo-relative path, with `node_modules` linked beside it.
     - No product module is stubbed. A new test asserts that the closure reaches `network/`.
  2. **`site-independent-live-reads` 6/6 SKIPPED:** the suite requires `ENCLAVE_LIVE_READS=1` and public Base RPC; it
     reads the DEPLOYED registry, ledger, feed, factory and vault.
     - No hermetic fixture is possible without recorded chain state, and recording would need live network.
     - It is no longer run offline. It is reported as an explicit **INCOMPLETE** line, never a pass.
  3. **`site-independent-management-unit` 27 pass / 1 fail:** the vendored bundle's manifest records each source's
     `commit` and `committedClean`, and a history-less `git archive` gives null; the bytes were unchanged.
     - **Fix (harness only):** `tree/` is a private full-history `git clone --no-local` of `relay-consumer-source`
       (4390 commits) checked out detached at `bf77da364`, then overlaid.
     - The assertion is not weakened.
- **The other 13 regression suites passed in r1.**

## r2 contents
- **`src/`:** r1's src with ONLY `test/browser-read-authority.test.mjs` changed. The 8 product/doc files are
  byte-identical to r1.
- **`base/`, `BASE`:** as in r1.
- **Patch:** `browser-read-authority.r2.patch`.
- **`tree/`** (patched clone) and **`tree-base/`** (pristine baseline clone): each has a `node_modules` symlink. Neither
  is a git worktree, and `relay-consumer-source` is unchanged.
- **`jobs/verify_tree_v2.py`:** `verify_tree.py` (`08e6b813…`) plus ONLY the `gitClone` checks:
  - `.git` is a real directory and is not walked;
  - `HEAD` equals the rev;
  - `git status --porcelain --untracked-files=all` lists EXACTLY the overlay as modified and the added files + link as
    untracked.

  Every content check is unchanged.
- **Pins:** `jobs/tree-pins.json`, `jobs/tree-base-pins.json`; r1's pins are kept as `jobs/tree-pins.r1.json`.
- **Launcher:** `jobs/root-browser-tests-r2.sh`. It verifies both trees pre and post, then runs:
  - the new suite (patched);
  - 14 regression suites on the BASELINE and again on the PATCHED tree;
  - live-reads as INCOMPLETE.

## Root command
```
R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r2
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $R2/logs/root-browser-tests-r2.guard -- unshare -rn bash $R2/jobs/root-browser-tests-r2.sh
```
Pass means the new suite plus 14 baseline and 14 patched suites all pass (zero skips), both trees verify after the
run, and the INCOMPLETE line is present.
