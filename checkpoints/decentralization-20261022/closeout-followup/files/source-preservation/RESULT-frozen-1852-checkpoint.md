# Checkpoint publication, batch "1852": root CPU quota counterexample, live custody v2 check, guest lineage, B consumer closure, M durability

"1852" is this batch's identifier: its actual start, 2026-10-23T18:52:07Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only.
- **Root's native CPU canaries show the Hyper-V cap FAILED.** The Windows 11 root scheduler (0x4) ignores the WMI caps, and a 1%
  share still consumed a full guest CPU. No CPU production activation was made, and the new source fix is pending.
- **Custody v2 is the original single-seat bootstrap**, not decentralized custody. There was no secret lifecycle and no rollout.
- **B is source/test only**, not production provider independence. **M is source only.**

**Pushed:** `checkpoint/decentralization-20261022` 7422efe6 → **`45bf6552f07a71cf7968e9b5bc48df8f5047d028`**, tree
**`399d6babf91ea6ac9ff2a46a4070848a36491722`**.
- **Commit:** made at 18:59:11Z (git 11:59:11-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, which returned by 18:59:44Z. An independent `ls-remote` at 18:59:44Z (postpush job) reads
  checkpoint 45bf6552 and main **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no force push or published-history rewrite, no SSH, production, VM, wallet or contract action, and no edit in any
  worker tree.

**Frozen input list.** Resolved once at 18:52–18:54Z from your message, and not grown afterwards.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| root-cpu-quota | c57a5f47 (frozen-1806, pushed) → **8afbf879** | 56f0e35c | exact |
| custody-live | root → **a90f8339** | b48a5ff5 | exact |
| b-consumer | 673601e5 (frozen-1339 b-launch, 27th commit) → 9 commits → **c08532b2** (orig b578d56b) | 59f5e7ec | derivative |
| guest-lineage | root → **02863ae1** (orig bb656d87) | 68eee2a6 | derivative (REPORT.md omitted) |
| m-durability | c635fd68 (NOT in pushed material) → ed0c536d → **415483ff** (orig c1366cf9) | — | **touched files only** |

- **Reproduction:** `frozen-1852-export/REPRODUCE-CHECK.txt`. All 5 sides are true, rebuilt from 7422efe6's stored patches; m-durability is checked on its touched files only.
- **Stability:** the final INVENTORY `4ee403b8` was byte-identical across two exports, in both the export-3 and capture-2 jobs.

**Omitted, with recipes (INVENTORY):**
- **b-consumer, compiled bundles.** The platform-api bundle (8,878,598 B, sha256 ae9d88db…, over 5 MB) and the mcp-server bundle
  (4,384,354 B, 94e10fe5…) stay held at their 673601e5 bytes.
  - Restore with the repository's own builders and B's node_modules. The platform-api builder also needs the gitignored relay
    network-runtime bundle.
  - **D did not rebuild them, and makes no rebuild claim.**
- **b-consumer, bundle manifests.** The three `*.bundle.mjs.manifest.json` files are held, and published `converted/` as sums plus
  meta, with the exact rebuild asserted. Their name/hash pairs trip both unchanged scanners. The small lease-gas-conduit bundle is
  exported as committed text.
- **b-consumer, result commit.** B's result commit c1a8f395 is not captured, because its exports duplicate these patches. Instead,
  B's outer RESULT.md and handoff/HANDOFFS.md are frozen files.
- **guest-lineage `REPORT.md`** (10,610 B, sha256 e3eb773e…). It names an existing outputs directory whose name contains the
  **lowercase** rewritten provider literal. The 2026-10-21 rewrite removed both cases of the literal from content, so I did not
  publish the report; it can be restored from R's repository at 02863ae1.
- **m-durability base.** c635fd68 (custody-release repo-b, pre-rewrite history) is in no pushed material, and 21 of its files
  contain the rewritten literal, so it cannot be published.
  - `base-files/` stores the base blobs of the 2 modified files (neither contains the literal).
  - The verifier checks that those files plus the 2 patches give every touched path's recorded blob at both commits.
  - **The full tree is not reproduced, and that is not claimed.**
- **Ignored or untracked files were never read:**
  - root-validation `*.exe`, `*.bin` and `*.wasm`;
  - custody-live `evidence/fresh-quote-raw.json` (raw chip ID) and `node_modules`;
  - every other worktree's WIP.
  - The committed quote evidence carries only the on-chain hashed chip ID.

**Manifest:** 4765 → **4929** (+164, 3,762,992 bytes); 0 changed, 0 removed.
- **Prescans** (export-3):
  - gitleaks found no leaks over the export directory or the 9 staged frozen/evidence files;
  - `scan-crypto-keys --files` gave 0.
- **Range scan** `7422efe6..45bf6552`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 166 committed files, with no binary, no file over 5 MB, no rewritten literal in either case, and no
  private-key block.
- **Tracking:** 4929/4929 entries are tracked and match their committed blobs.
- **Post-push:** 9/9 frozen files are unmoved. root-validation, custody-live, b-consumer and guest-lineage are at their frozen
  heads. M's branch has **advanced** to 3ccd4333 and 0a6b108e (11:45:06-07:00, the phase-2 follow-up). Those are **NOT captured**;
  415483ff is their ancestor.

**Captured besides commits:**
- B's RESULT.md and handoff/HANDOFFS.md;
- M's initial RESULT.md (source only; it records the e2e constructor fixture failure);
- root receipts `nucbox-cpu-enforcement-counterexample-20261023.json` and `custody-v2-live-verification-20261023.md`;
- the 1806 receipt;
- snapshots (taken 18:54:24Z) of ROOT-PENDING-LATEST, ROOT-CONTINUE-LATEST and effective-goal-requirements. The external human
  admin clarification supersedes the stale goal text.

**Not captured:**
- active Q build / A2 guest / debug artifacts;
- B cpu-root-scheduler-quota;
- R custody dashboard;
- M durability follow-up (RESULT-FOLLOWUP.md, the later commits, worktree changes);
- every other final.

**Queue:** every job ran through the unchanged queue, with no not-started tries and no job stopped.
- Every job used the 256 MiB lane except **export-1, which I put in the 512 lane**. Its actual peak was 29 MiB, so 512 was not
  justified. All later jobs used 256.
- Peaks: export 86–95, capture 44–45, commit 68–73, scan 106–115, push 141 and postpush 35 MiB.

**Attempts (all logs retained):**
- **export-1** (512 lane, rc 1): KeyError, because I looked up `name` on the export record instead of the spec. No output was used.
- **export-2:** passed, but recorded 2 lowercase-literal files (R's REPORT.md and its patch).
- **capture-1, commit-1 (550b7211, local only), scan-1:** passed.
- **content-check-1** (rc 1): my content check counts both cases and failed on those 2 files. **Nothing was pushed.**
  - `frozen-1852-drop-commit-1` reset the local branch from the unpushed 550b7211 back to the pushed 7422efe6. It asserted the
    remote was still 7422efe6, and the checkpoint directory was left clean, including ignored files.
  - guest-lineage became a derivative without REPORT.md.
  - The first range-scan report is kept as `frozen-1852-checkpoint-gitleaks.attempt-1.json`.
- **export-3, capture-2, commit-2 (45bf6552), scan-2, content-check-2, push, postpush and derivative-heads:** passed.
- **Note for root:** frozen-1517 had published lowercase occurrences under the then-current "record lowercase" rule. This batch
  applies the stricter both-case check. Earlier checkpoint content is unchanged.

Root will verify the remote independently.
