# Checkpoint publication, batch "0931": A/B/F/C/S terminal heads, root's PostgreSQL and TLS repos, P/E sources, D installed baseline

"0931" is this batch's identifier: its actual start, 2026-10-23T09:31:18Z (`date -u`). Every time below is measured, from
`date -u`, file mtimes or git metadata.

**Pushed:** `checkpoint/decentralization-20261022` cadf0ebb → **`f2db53ff5691fa691760ce2a102126291a1354f6`**, tree
**`670d0cca726f063db50bd5faa06e2832845a31ee`**.
- **Commit:** made at 11:03:49Z (git 04:03:49-07:00), by SteveDeFacto (noreply) as author and committer.
- **Push:** a normal fast-forward at about 11:14:29Z (the job's rc time), confirmed by `ls-remote`.
- **Not done:** no force push, merge, signing, SSH, wallet action, image build or deployment.
- **Main:** this batch did not touch it. Remote `main` is **68b82926**: that is 7752a423 plus three docs-only commits
  (d2ea087f, 544088d1, 68b82926), committed 09:01–09:11Z by others before this batch ran. The push script required `main`
  to be exactly 68b82926 before and after the push.

| Side | Base (in pushed cadf0ebb) → head | What the patches reproduce |
|---|---|---|
| a-parity | df8fbafa → c3a61fd1 → **e32dd607** | exact commit trees |
| b-runtime-final | df8fbafa → 19 commits → **c31e975a** (tree 6fbe601d) | exact |
| f-rpc-closure | 4106c311 → bb86e0ce, 30123801 → **14d1e495** | exact |
| c-drain | bbf0a009 → fbaecfc, 5a3ee31, 5293405 → **19b91486** | exact |
| s-browser | e820e240 → ROOT 2bd1eea → **349318a0** | exact |
| s-report | root → 4439755 → **b55ca791** | exact |
| root-pg | root → **555dc752** | exact |
| root-tls | root → be8a71d, edac1dc, 9bc2053 → **ab527067** (all 4 commits) | exact |
| p-l1 | root → 12 commits → **f8351487** | **derivative trees only** (original minus 5 paths) |
| e-closure | 159fd148's derivative tree 827da8c7 → 017b8aa, 027ff549 → **ca818b75** | **derivative trees only** (minus `fixtures/artifacts/`, `exports/`) |

- **Reproduction:** `frozen-0931-export/REPRODUCE-CHECK.txt`. All 10 sides are true, built offline from cadf0ebb's stored
  patches; 62 trees are checked.
- **Stability:** INVENTORY `f3909022` was byte-identical across two exports, in both the export and capture jobs.

**Omitted, with recipes** (INVENTORY `derivatives`, `frozen-0931-e-artifact-recipe.json`, `d-installed-baseline/BASELINE.json`):

| What | Why | How to rebuild or restore |
|---|---|---|
| P `evidence/sources/lighthouse-v8.3.2/.../mainnet/genesis.ssz.zip` (blob 28405c78, 1,616,593 B) | vendored upstream binary | sigp/lighthouse v8.3.2, tree a376defa, same path (pinned by P's tree JSON) |
| P `evidence/lighthouse-binary-20261023T080144Z/release.yml` | quotes Sigma Prime's PUBLIC PGP fingerprint, which the checkpoint's unchanged gitleaks flags (P allowlisted it only in its own config) | upstream blob 75a69cf0 (`.github/workflows/release.yml` at v8.3.2) |
| P `logs/fetch-lh-2.out`, `logs/verify-lh-2.out`, `logs/verify-lh-3.out` | same fingerprint | kept only in P's repository (blob and sha256 recorded) |
| E `fixtures/artifacts/*.json` (13: 7 as in frozen-0830, 6 new) | compiled solc outputs | solc 0.8.35+commit.47b9dedd, the per-artifact settings and source keccaks in the recipe; 0 sources missing; no compiler was run |
| E `exports/` (4 patches, a git bundle, SHA256SUMS) | E's own export, which embeds the artifacts | from the derivative patches plus the regenerated artifacts |
| D installed bundles: privacy-agent cfb69370, worker 13ce44f1, ingress c952dce4, admission 6bef372d, lease-gas-runtime 159108d1 | compiled JS | `g4-challenge-retry-package-20261022/build.mjs` plus the published input manifests; admission and lease-gas are proven relative to F's rebuilds |
| D NucBox `enclave-wg.exe` cbaf8313, `enclave-circuit-firewall.exe` 78daec71 | binaries, no local copy | Go buildinfo unknown; a root read-only capture item |
| installed `relay/snp-verify.mjs` 10520dd2 | carries the literal removed by the 2026-10-21 rewrite | applying the rewrite transform to it gives the preserved 93f9e9d2 (proved) |
| B `bin/`, `bin-release/`, `closure/` (2 GB), `fixtures/`, `lineage/` | binaries, build closure, duplicate patches | hashes are in B's INVENTORY.json (captured) |

**D installed baseline.** I checked 116 repo-source inputs of the installed builds against every object reachable from
cadf0ebb. 114 were already preserved. `network/enclave-network-host.mjs` 2c1b84aa is now exported; snp-verify is recorded
by relation, as above. The input manifests are published as `sha256  path` text. In JSON form, npm file names such as
`privateKeyToAccount.js` precede 64-hex hashes, which the unchanged gitleaks rules flag. The exact JSON is rebuildable, and
the export asserts the round-trip. D's review (`windows-upgrade-delta-review/`) and its F/A handoff are pinned. Its RESULT
wording on snp-verify was edited at 09:40Z, before capture, so the rewritten literal is not reintroduced; the raw diff stays
local.

**Manifest:** 2235 → **3042** (+807, 15,513,962 bytes); 0 changed, 0 removed.
- **Prescan:** gitleaks found no leaks over the export directory and the 130 staged frozen/evidence files.
- **Range scan** `cadf0ebb..f2db53ff`: scan-crypto-keys 0 and gitleaks no leaks (16.09 MB).
- **Content check:** 809 committed files, with no binary, no private-key block, no file over 5 MB, and no node_modules,
  target or cargo-home directory.
- **Hooks:** pre-commit and pre-push passed.
- **Tracking:** 3042/3042 entries are tracked and match their committed blobs.
- **Post-push:** 130/130 frozen sources and root receipts are unmoved.

**Captured besides commits:**
- **A:** RESULT-CONSUMER-PARITY and patches 0015/0016.
- **B:** RESULT.md, INVENTORY.json and job scripts. B's RESULT header says "09:40Z", but the file was written at 09:33:51Z
  (mtime) and root saw it at 09:35Z. c31e975a was committed at 09:08:38Z. The header was left as written and the label
  records these times.
- **F:** RESULT, progress, scripts and artifact hashes.
- **Log digests** for B, F, C and D (raw logs stay local; every not-started try is kept and counted).
- **Root notes:** A1 gate, PostgreSQL drain review, TLS incident and recovery notes, P notes, and the three notes to D.
- **Root receipts:** cadf0ebb verification, R3, config state, crash observation, baseline gate, PostgreSQL counterexample,
  rollback review, and the 08:44Z RPC integration review.
- **The 0830 receipt with its time correction:** cadf0ebb was committed at 07:57:53Z.
- **Dated snapshots** (09:45Z) of ROOT-PENDING-LATEST and effective-goal-requirements.

**Not captured (active, or not final):**
- B's and S's new owned trees;
- E after ca818b75: its tree is dirty and its HEAD is 46dbfbef3, a new task;
- F's new compose tree;
- the ninth TLS worker (`nucbox-tls-recovery-20261023/claude-run`);
- S's NOTE-FROM-S files;
- C's untracked `rehearsal/runs/d1-failed`;
- the `rpc-priority/patches/SHA256SUMS` update (the Git objects are authoritative).

**Attempts (all logs retained):**
- **export-1:** passed, without the gitleaks prescan.
- **export-2:** the prescan found 18 false positives: P's PGP fingerprint and D's manifest name/hash pairs. Its report is
  kept as `frozen-0931-prescan-gitleaks.export-2.json`.
- **export-3:** killed by my own 595 s wait while queued; it never started (`export-3.note`).
- **export-4:** passed.
- **capture-1:** my capture guard refused my own tool scripts, which contained the rewritten literal in their guard code.
  - That run had already written 798 stored files. They were removed by an exact dry-run list, each byte-checked
    (`frozen-0931-capture-1-revert.txt`).
  - The guards now build the literal from hex, and the capture validates every item before writing anything.
- **capture-2:** the post-check matched the substring "cargo-home" in a B source file name
  (`scripts/rpc-runtime/cargo-home-from-lock.py`).
  - Its 807 files were removed by its own appended manifest entries (`frozen-0931-capture-2-revert.txt`).
  - MANIFEST.json and README.md were restored after their diff was proved to be only that append.
  - The check now matches whole path components.
- **capture-3:** passed.
- **e-recipe-1:** copied one source that cadf0ebb already holds. e-recipe-2 references it instead.

Root will verify the remote independently. Nothing here claims production RPC, storage or TLS independence. All results
are offline source and test evidence.
