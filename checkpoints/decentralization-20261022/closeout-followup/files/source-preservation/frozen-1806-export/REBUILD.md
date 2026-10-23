# frozen-1806 export: how to rebuild

"1806" is this batch's identifier: its actual start, 2026-10-23T18:06Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing here is merged, imaged, activated or deployed by this capture. **The whole CPU resource fix is
INCOMPLETE**: the native launcher candidate is staged only, and the guest build and native combined canary are pending. The custody
audit is a source / historical-record audit with **no** fresh production probe, rollout or tests.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges and no source-only derivatives;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Each changed file is also stored at its head blob under `files/`. `INVENTORY.json` records each commit's hash, parent, tree, author
and committer (all SteveDeFacto / noreply), time and subject.

## Exact trees

| Side | Base | Commits → head (tree) |
|---|---|---|
| root-cpu-build | c516049c (pushed in 6dcde703: frozen-1726 root-cpu-canary, tree 777366f2) | 6ac5e111 launcher pin → **c57a5f47** native build (ec62bb6b) |
| custody-audit | empty tree (root commit) | 5c263df1 → 8d17bd6 → 167ed43 → **8df7139d** (f3aa86ac) |

`git read-tree` the base (for root-cpu-build: the empty tree plus the stored frozen-1726 root-cpu-canary patch), then
`git apply --cached` each patch in order; `git write-tree` must equal each recorded tree. `verify-frozen-1806-export.py` does this
offline from 6dcde703's stored patches; its output is in `REPRODUCE-CHECK.txt`.

## Native launcher build (root-cpu-build)

- **Source:** the 18-file closure of ea6717d2, which was captured exactly in frozen-1726 cpu-enforce. `native-loader-source.json` lists the 18 files with their SHA-256 and the source zip's SHA-256 (1f1bf99a…).
- **Candidate:** e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2, 1,147,904 bytes, STAGED ONLY.
- **Not archived:** `candidate-shield-host.exe`, `installed-shield-host.exe` and `native-loader-source.zip`. They are untracked and ignored (`.gitignore`: `*.exe`, `*.zip`), are never in a commit, and are not captured.
- **To rebuild:** use the committed `prepare-native-build.py` / `native-loader-build.ps1` (offline, locked, release, one job, existing nightly MSVC and SDK) on the ea6717d2 source closure. D did not run this build and makes no rebuild claim.
- **Root's record:**
  - Cold build: 49.09 s, peak 309,899,264 B, minimum free 26,454,904,832 B.
  - Incremental build: 0.27 s, which ran under the memory sampling period, so its raw 0 / 1e12 values are sentinels, not observations.
  - Guard harness: the detached exit and the null ExitCode / multiline parse issues are documented. The corrected command exit file confirms Cargo exit 0.

## Not archived

- Untracked files in root-validation: the binaries and zip above, and later guard logs.
- Untracked files in the custody audit: root review notes and progress.
- CPU guest/image build WIP, M's new durability work, and every other active tree or final.
