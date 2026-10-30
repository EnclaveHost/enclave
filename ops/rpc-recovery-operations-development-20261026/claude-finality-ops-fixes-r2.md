# r6-ops-fixes-r2: installer backups outside module trees and exact tree activation (PREPARED, FROZEN; every suite UNRUN)

**Stage:** `base-finality-proof-stage/r6-ops-fixes-r2/`, layered on the frozen `r6-ops-fixes/tree`. That stage is untouched and its `SHA256SUMS` still verifies; it is queued as `root-finality-ops-0609`.
- **`SHA256SUMS`:** `22c3f86560716cac7f8c7c30761592c8aea35eb61310fe0e20fe76f8d2314ef6`. **`tree/SHA256SUMS`:** `e420077e…39d0`.
- **Only 2 files differ from the r1 tree:** `install/install_verified.py` (blob `557aded5`) and `tests/test_ops_installer.py` (blob `15becdef`).
- **`install/MANIFEST.json`:** unchanged and still exact. The installer is not a manifest entry.
- **Done here:** syntax checks only (`ast.parse`, `bash -n`). No tests, builds, queue jobs, live changes or commits.

## Patches (against r6-ops-fixes/tree)
| Patch | sha256 | Change |
|---|---|---|
| `patches/r2-install_install_verified.py.patch` | `dab81c97…f9d9b` | (a) **Backups move out of the trees.** They were `<dest>.pre-<stamp>` beside the live file, which breaks a tree's exact digest and makes the next preflight reject them as extra files. Now: `<journal-dir>/<stamp>.backup/<dest path>`, a byte copy at 0600, each directory root 0700 and no symlinks. Original mode, uid and gid stay in the journal, rollback restores them exactly, and backups are retained. (b) **`installed_exactly`, which activation uses, now checks trees too.** Each manifest tree must be a real directory with exactly the listed file set (no extras, none missing), each sha, every entry root-owned, not group/other writable and not a symlink, and the tree digest finality_state checks. Previously only `m.files` was checked |
| `patches/r2-tests_test_ops_installer.py.patch` | `737f790d…e305` | The r1 backup test now expects the journal location and no file beside the live one. 5 new tree regressions follow |

**New regressions** use a real multi-file tree: `index.js` and `lib/a.js` are replaced (old modes 0640 and 0600), `lib/b.js` is created, and an unrelated `/opt/x/unrelated.txt` exists.
1. **After commit:**
   - the installed tree digest equals the manifest and the file set is exact;
   - no `.pre-` or `.install-` file exists under `/opt`;
   - the backups sit under `T5.backup/…` at 0600 with the old bytes, and the journal records the original modes;
   - a repeated preflight returns all `identical`, and `installed_exactly` passes.
2. **Injected failure at the last tree file:** originals come back byte- and mode-exact, `lib/b.js` and the created `/opt/y` are removed, `unrelated.txt` is untouched, and the backup is retained outside the tree.
3. **Tampered tree file:** activation's check refuses with `changed: ['lib/a.js']`.
4. **Extra file:** an r1-style `lib/a.js.pre-…` makes activation refuse (`extra [...]`) and preflight refuse (`outside the qualified tree`). **Missing file:** removing `lib/b.js` refuses (`missing ['lib/b.js']`).
5. **Unsafe entry:** a group/other-writable tree file, and a symlinked tree entry, are both refused.

## Root targeted job (UNRUN), offline, cap 512
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh finality-ops-fixes-r2-1 512 unshare -rn bash base-finality-proof-stage/r6-ops-fixes-r2/jobs/root-ops-fixes-r2-tests.sh
```
- **The job** (`jobs/root-ops-fixes-r2-tests.sh`, sha256 `85040acc…732b`) is r1's job with r2 paths, labels and counts. It verifies the stage and tree sums first.
- **Expected:** `ops-readiness` **25**, `ops-installer` **13** (r1's 8 plus 5), and the r6 sampler **92**.
- **PASS:** `## finality-ops-fixes-r2 rc=0`, with exact counts and no skips.

## Reuse of r1 receipts
- **Reusable:** the readiness, publisher, sampler and unit files are byte-identical to r1. So `root-finality-ops-0609`'s readiness (25) and sampler (92) results, once actual, apply unchanged to r2.
- **Must rerun:** only the installer suite has changed. The r2 job reruns all three for one coherent receipt; root may instead run just `tests/test_ops_installer.py` (13).
- **Composition:** the final composition still requires qualification.

## Caveats
- **Unrun:** nothing has been executed.
- **Backup cleanup:** backups accumulate under `/var/lib/enclave-rpc/install-journal/<stamp>.backup/`, root 0700, by design. Their cleanup is a root decision.
- **Not covered by these tests:** ownership refusal for another uid, because a user-namespace test cannot chown to an unmapped uid; it is covered by code. A real systemd or a real `/opt` install is not exercised either.
- **Readiness settings:** the missing readiness settings inputs from the r1 report are unchanged.
