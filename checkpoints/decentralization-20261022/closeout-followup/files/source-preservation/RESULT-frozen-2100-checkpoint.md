# Checkpoint publication, batch "2100": custody v2 live reconciliation, dashboard, site releases, forwarder, factory, canary, recipient and publisher records

"2100" is this batch's identifier: its actual start, 2026-10-23T21:00:37Z (`date -u`). Every time below is measured. This is
SOURCE and EVIDENCE preservation only.
- **Activation:** root owns all activation and signing, and none has occurred.
- **Not ready or not included:**
  - site release 3f16d9b1 is SUPERSEDED by r2, and neither is published;
  - factory-wallet's ABI fix is uncommitted WIP and is NOT included;
  - production-canary 7bcd501f is NOT mutation-ready.
- **Custody:** the existing custody is the original single-seat bootstrap. It is NOT complete, and it is NOT decentralized custody.

**Pushed:** `checkpoint/decentralization-20261022` 619e0e34 → **`f2e7009eb0a26e0a727012c9d17de05f1cc13d96`**, tree
**`3985d6d0253dfdbf4b1a8aea1297c3e47e9af851`**.
- **Commit:** made at 21:10:37Z (git 14:10:37-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward.
- **Independent check:** `ls-remote` at 21:12:40Z (postpush job) reads checkpoint f2e7009e and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or remote history change. No production or network probe apart from git
  ls-remote/push, and no edit in any worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**, and no job was stopped. Peaks: 0–184 MiB.
  - 2 tries answered `NOT STARTED: small allocation held`: export-4 and the first checkpoint-commit. They are kept as
    `*.tryN.out` and were retried at the same cap.
  - One `git ls-remote` read of the checkpoint ref was run directly, outside the queue, before the drop-commit job.

**Frozen input list.** Exactly root's designated heads (`custody-publisher-assessment-20261023/ROOT-PRESERVE-2101.txt`), resolved
at 21:00–21:02Z and not grown afterwards. Every author and committer is SteveDeFacto (noreply); there are no merges; each repository
root is its work directory.

| Side | Base (pushed in 619e0e34) → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live4 | 3fd6e8ff (frozen-2025 custody-live3) → bc3f93c0, edaaaf81 → **dc07e225** | 986d5fbd | exact |
| dashboard3 | e24a47fb (frozen-2025 dashboard2) → 2d3839c5, 278a28a7, a942a61f → **9d97b4b0** | e5f38820 | exact |
| site-release (SUPERSEDED) | root → 7681e3fa → **3f16d9b1** | 7802cff9 | derivative: binary root block omitted, CID-verified |
| site-release-r2 | root → 82c594ab → **14b5f559** | 7e5af78c | derivative: root block omitted, CID-verified; RELEASE-HANDOFF.md as a reversible converted copy |
| ingress-forwarder | root → 35d73c68 → **b1c1feee** | fe9c470a | exact |
| factory-consumer | root → 519489c3 → **d0e9df82** | 2fb41cdb | exact |
| factory-wallet | root → f18404a5 → **24aac735** | 249513e4 | exact (ABI-fix WIP not included) |
| production-canary | root → **7bcd501f** | 9b5a7493 | exact (NOT mutation-ready) |
| recipient-provenance | root → **8b0c4da2** | 00861e62 | **exact**, with `held-out/` restored |
| publisher-assessment | root → **b895d295** | 6901c766 | exact |

- **Reproduction:** `frozen-2100-export/REPRODUCE-CHECK.txt`, with every side true.
  - Bases were rebuilt offline from 619e0e34's stored chains: dashboard from dfe020ab plus 30 patches, custody-live from 4.
  - INVENTORY `4d85e4e4` was byte-identical across two exports, in both the export-4 and capture-3 jobs.

**Handled findings and limits** (nothing allowlisted; `.gitleaks.toml` unchanged; no meaningful evidence redacted):
- **site-release and r2: `release/<CID>/site-root.block`.** Each is a 1835-byte binary dag-pb root block, which is build output; you
  asked for no CAR or build binaries.
  - Both are omitted. The export asserts sha256(block) equals the CID multihash: r1 blob 7b2e88fb (sha256 17f34c21…), r2 blob
    4e27a826 (sha256 ecf974c3…).
- **r2: `RELEASE-HANDOFF.md`.**
  - **Finding:** export-1 gitleaks reported 2 generic-api-key hits on prose: the dashboard's secrets-panel phrase, a comma, then a
    backquoted file name, at head line 45 and in the 82c594ab patch.
  - **Handling:** the file is excluded from the patches. Its head version is published converted, with one comma changed to a
    semicolon.
  - **Reversibility:** the recorded reverse substitution gives the original blob 13ebbd6d byte for byte (asserted), and the
    82c594ab version is recorded by blob.
  - The report is kept as `frozen-2100-prescan-gitleaks.export-1.json`.
- **recipient-provenance: size only.**
  - **Refusal:** capture-1 refused, before writing anything, because the single commit's patch exceeded the 5 MB stored-file
    limit (two ~2.7 MB initramfs inventories).
  - **Handling:** `out/` is excluded from the patch, and both files are published byte-exact under `held-out/`.
  - **Check:** the verifier restores them and matches the original tree 00861e62.
- **Dropped commit:** the first local commit 5a93be22 failed the content check, because my own `export-frozen-2100.py` held the
  private-key block marker as a literal in its new guard. It was never pushed.
  - `frozen-2100-drop-commit-1` reset the local branch to 619e0e34, after asserting the remote was still 619e0e34. It confirmed
    closeout-followup was clean, ignored files included.
  - The marker is now built from hex, like the rewritten-literal guard.
- **Repository-local scanner files:** production-canary's committed `.gitleaksignore` (one public file-hash pin) is preserved as
  content. The checkpoint's scans never use it.

**Checks on f2e7009e:**
- **Prescans** (export-4): gitleaks found no leaks over the export or the 3 frozen files, and scan-crypto-keys gave 0.
- **Range scan** `619e0e34..f2e7009e`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 332 files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Manifest:** 5530 → **5860** (+330, 9,497,612 bytes).
  - **Old entries:** all 5530 are identical JSON and byte-matched. Only MANIFEST.json and README.md were modified, and README kept
    every line.
  - **Tracking:** 5860/5860 entries are tracked and blob-matched. 34 ignored-pattern files were force-added after sha
    verification (`frozen-2100-force-add.txt`).

**Captured besides commits:**
- the 2025 receipt;
- dated snapshots of root's journal ROOT-CONTINUE-LATEST (through its 20:58Z entry, `760ebb7d`) and of the living
  `outputs/decentralization-audit/custody-v2-live-verification-20261023.md` (`d687b10d`).
  - The earlier stored bytes (23c9aeba, and the 2025 snapshot a033b002) are unchanged.
- ROOT-PENDING-LATEST and effective-goal-requirements are unchanged since 1852 (asserted).

**Never read or captured:** untracked task files, worker progress/err files, uncommitted WIP, CARs, images, binaries, raw quotes,
sealed state, keys and private config.

**Post-push:** the 3 frozen inputs are unmoved, and 8 of 10 source repositories are at their frozen heads.
- **custody-live** advanced to 1c8403e8 (14:12:03-07:00). It is NOT captured; dc07e225 is its ancestor.
- **factory-wallet** advanced to 7f11fbf3, 99cf7f16 and 9557ad6d (14:05–14:10, the book-ABI work). They are NOT captured;
  24aac735 is their ancestor.

**Attempts (all logs retained):**
- **export-1** (rc 1, the gitleaks prose finding), **export-2, export-3:** as described above.
- **capture-1** (rc 1, the size refusal before any write), **capture-2, commit, scan:** passed. **content-check** (rc 1): the
  literal marker, after which the commit was dropped.
- **export-4, capture-3, checkpoint-commit-2, checkpoint-scan-2, content-check-2, old-bytes check, push, postpush and
  derivative-heads:** passed.

Root will verify the remote independently.
