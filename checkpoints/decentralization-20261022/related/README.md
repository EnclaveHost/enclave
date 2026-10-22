# Related-repository source checkpoint (2026-10-22)

Preservation snapshot of uncommitted authored work in repositories next to `work/enclave`.
Not a release, not a proof of completion. Tests were **not rerun**; coverage is unchanged from the originals.

Each directory holds `snapshot.json` (public baseline URL/commit), `tracked-changes.patch`
(binary-safe `git diff --full-index --binary` of modified/deleted tracked files), `untracked/`
(verbatim untracked source files) and `changed-paths.txt`. `INVENTORY.json` lists every file with SHA-256.

Reconstruct (example):

    git clone https://github.com/EnclaveHost/enclave-apps.git && cd enclave-apps
    git checkout 50f93d74c5a41acb8df73c8ae094d8c9fb05e666
    git apply --binary <this>/enclave-apps/tracked-changes.patch
    cp -a <this>/enclave-apps/untracked/. .

Enclave-repo patches: `git checkout <base from table>` in a clone that has the main checkpoint branch, then `git apply --binary <patch>`.

| dir | origin | base (public) | notes |
|---|---|---|---|
| enclave-apps | github.com/EnclaveHost/enclave-apps | 50f93d74 (decentralize/wallet-uploads) | 34 modified + 45 new; one added comment reworded per the repo name-cleanup policy (-> "cloud provider-style") |
| enclave-apps-sia-recovery | same | 54818ba6 (decentralize/sia-recovery) | 6 modified |
| storage-safety-review | same | 54818ba6 (detached) | 3 modified; `baseline-proof/` = HEAD copy of sia-s3 except 2 files, kept as `baseline-proof-vs-HEAD.patch`; `run-bounded.sh` from logs/ |
| phone-dns-recovery-fix | github.com/EnclaveHost/enclavedns-client | da813d8a (main, v0.1.4) | 2 modified + 1 new test |
| app-lease-gas/*.patch | EnclaveHost/enclave | **b97ffbc5** (main checkpoint replay head = transformed e762a9c5; parent chain d09f377d public) | only regular files differing from both e762 and work/enclave worktree; verified `git apply` on b97ffbc5 |
| extra-lineages/custody-release-c635fd68.patch | EnclaveHost/enclave | b97ffbc5 | 2 new release files of local commit c635fd68 (other 18 files == checkpoint) |
| extra-lineages/shield-lineage-7f019ce2.patch | EnclaveHost/enclave | public 7b9376f9 (= rewritten 50a37f6d, on decentralize/nan-retirement) | final-state isolation/m2/front/{main.go,oracle_test.go,shield_direct.go} of local commits 90c432d8..7f019ce2 (rest == checkpoint or public blobs) |
| extra-lineages/overlay-fix-32ec4980.patch | EnclaveHost/enclave | b97ffbc5 | 12 source files of local scratch commits 0080dc02+32ec4980 differing from checkpoint; content transformed by the rewrite rule (1 line in relay/api-relay.js); 2 generated bundles excluded |

`work/windows-final-review-source` needs no patch: its tree equals local commit 45801c22 = public 8082af35
(differences are only the history name-cleanup rewrite), plus a `node_modules` symlink.

Audited and needing nothing: custody-candidate-source-20261020 (ee8beb38 = public 85cb6e7d), custody-release-source-78acfcc6
(78acfcc6 = public dbbe9765; only dirty path is a node_modules link), custody-release/repo-b (same HEAD as repo, clean).
