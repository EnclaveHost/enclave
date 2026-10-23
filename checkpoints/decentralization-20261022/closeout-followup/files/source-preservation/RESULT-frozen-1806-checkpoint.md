# Checkpoint publication, batch "1806": root native CPU launcher build evidence and the custody v2 rollout audit

"1806" is this batch's identifier: its actual start, 2026-10-23T18:06:42Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only.
- **The whole CPU resource fix is INCOMPLETE.** The launcher candidate is staged only, and the guest build and the native combined
  canary are pending.
- **The custody audit is a source / historical-record audit**, with no fresh production probe, rollout or tests.

**Pushed:** `checkpoint/decentralization-20261022` 6dcde703 → **`7422efe6e2a5a3a132c622091b1ab619f280c2bc`**, tree
**`a666b98a9d2e86a967b00503acc587212ae538de`**.
- **Commit:** made at 18:08:27Z (git 11:08:27-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, which returned by 18:08:47Z, the first time. An independent `ls-remote` at 18:08:47Z
  (postpush job) reads checkpoint 7422efe6 and main **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no force push, rewrite, SSH, production, signing, contract or main action, and no edit in any worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**, with no not-started tries; the large lane was not
  needed.
  - Peaks: export 70, capture 43, commit 62, scan 59, push 108 and postpush 36 MiB. The content check finished before the guard
    sampled (0).
  - No job was stopped.

**Frozen input list.** Resolved once at 18:06–18:07Z from your message and root's 18:01Z journal note, and not grown afterwards.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| root-cpu-build | c516049c (frozen-1726 root-cpu-canary, pushed in 6dcde703) → 6ac5e111 launcher pin → **c57a5f47** native build | ec62bb6b | exact |
| custody-audit | root → 5c263df1 → 8d17bd62 → 167ed431 → **8df7139d** (branch audit/custody-v2) | f3aa86ac | exact |

- **Reproduction:** `frozen-1806-export/REPRODUCE-CHECK.txt`. Both sides are true, rebuilt from 6dcde703's stored patches.
- **Stability:** the INVENTORY `4ad83e53` was byte-identical across two exports, in both the export-1 and capture-1 jobs.
- **Committed text only.** No source-only derivative was needed. The export asserts that no committed path is an .exe, .zip, .dll
  or .pdb.
  - `candidate-shield-host.exe`, `installed-shield-host.exe` and `native-loader-source.zip` are untracked and ignored, and were
    **not captured**.
  - The launcher CPU source ea6717d2 was already captured exactly in frozen-1726 cpu-enforce. The committed
    `native-loader-source.json` lists its 18 files by SHA-256.
- **Root's record, preserved as committed (D did not run the build):**
  - Offline, locked native MSVC build: PASS. Candidate e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2,
    1,147,904 B, **staged only**.
  - Guest, manager and live installed files are unchanged. At 17:57, all 9 apps were running with the same 10 manager VM IDs,
    17% CPU and 16.3 GiB.
  - Cold build: 49.09 s, peak 309,899,264 B, minimum free 26,454,904,832 B.
  - Incremental build: 0.27 s, which ran under the memory sampling period, so its raw 0 / 1e12 values are sentinels, not
    observations.
  - Guard harness: the initial detached exit and the null ExitCode / multiline parse issues are documented. The corrected command
    exit file confirms Cargo exit 0.
- **Custody audit findings, as recorded by M:**
  - an actual persist-before-ack bug;
  - limits on retaining the old copy during migration;
  - the dashboard is missing, and the book was historically unset;
  - one seat is not decentralized custody.
  - `outputs/.../custody-v2-source-audit-20261023.md` is byte-identical to RESULT.md at 8df7139d.

**Manifest:** 4689 → **4765** (+76, 354,142 bytes); 0 changed, 0 removed.
- **Prescans** (export-1):
  - gitleaks found no leaks over the export directory (222 KB) or the 5 staged frozen/evidence files (99.6 KB);
  - `scan-crypto-keys --files` gave 0.
- **Range scan** `6dcde703..7422efe6`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check** (queue job): 78 committed files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Tracking:** 4765/4765 entries are tracked and match their committed blobs. 24 of the stored files are root's committed guard
  logs, which the ignore rules hide; each was sha-verified before `add -f`.
- **Post-push:** 5/5 frozen files are unmoved, and both source repositories are still at their frozen heads.

**Captured besides commits:**
- root receipts `nucbox-cpu-launcher-built-20261023.json` and `custody-v2-source-audit-20261023.md`;
- the 1726 receipt;
- snapshots (taken 18:07:21Z) of root's journal and effective-goal-requirements.

**Not captured:**
- the binaries and zip listed above;
- root-validation's later untracked guard log;
- the custody audit's untracked ROOT-AUDIT-REVIEW-1, ROOT-OUTAGE-ISOLATION and progress files;
- the CPU guest/image build WIP (Q/R), M's new durability work, and every P/S/A/F/C/M/T final.

**Attempts:** export-1, capture-1, commit, scan, content check, push and postpush each passed first time. Every log is retained.

Root will verify the remote independently.
