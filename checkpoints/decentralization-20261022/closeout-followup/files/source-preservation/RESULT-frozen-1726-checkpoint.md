# Checkpoint publication, batch "1726": coupled resource-share repair (node fix, CPU enforcement source, root native evidence)

"1726" is this batch's identifier: its actual start, 2026-10-23T17:26:41Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only.
- **The whole CPU resource fix is NOT complete.** The manager/guest rollout is pending, and guest cgroup enforcement is not yet native.
- **Root's native canary is real**, root-run on the current image.
- **Pre-existing fixture failures are not called green.**

**Pushed:** `checkpoint/decentralization-20261022` 1219a988 → **`6dcde703004dcb34e702ec2aff8309e48ced44ae`**, tree
**`c85ef661ed9dfdd22550959e683c1f6f3e849198`**.
- **Commit:** made at 17:33:07Z (git 10:33:07-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, which returned by 17:33:41Z, the first time. An independent `ls-remote` at 17:34:01Z (postpush-2)
  reads checkpoint 6dcde703 and main **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no force push, rewrite, SSH, production, wallet, signing or contract action, and no edit in any worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**; the large lane was not needed.
  - Peaks: export 69, capture 52, commit 65, scan 48, push 90 and postpush-2 35 MiB. The content check and the failed postpush-1
    finished before the guard sampled (0).
  - Export-1 had one not-started try, kept as `frozen-1726-export-1.try2.out` ("small allocation held").
  - No job was stopped.

**Frozen input list.** Resolved once at 17:26–17:29Z from your message and root's journal, and not grown afterwards.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| node-shares | d281007c (pushed: `rpc-native-codec-export` side c, 6th commit) → 0f1ef848 installed baseline → 14b24592 → **a5e155ec** | 609d98c8 | exact |
| cpu-enforce | 0f1ef848 (node-shares' 1st commit; the same object in both repos) → 670a753e manager → bf376363 seam → **ea6717d2** guest | 5b1d4b5a | exact |
| cpu-oldguest | 670a753e → **15ad0042** (old-guest-b, the source of root's canary kit) | bdf8cee3 | exact |
| node-report | root → d10a78cb → **33ba0fc3** (committed tree only) | f7cd0dd7 | exact |
| root-cpu-canary | root → **c516049c** | 777366f2 | exact |

- **Reproduction:** `frozen-1726-export/REPRODUCE-CHECK.txt`. All 5 sides are true.
  - node-shares' base was rebuilt from 1219a988's stored ncodec patches (tree a9eeada5 = d281007c).
  - The CPU bases chain through this export's own first patches.
- **Stability:** the INVENTORY `f62cd6b8` was byte-identical across two exports, in both the export-1 and capture-1 jobs.
- **No derivatives:** nothing was omitted from any committed tree. There were no binaries in any range.
- **Native canary kit:** the 7 `native-canary/kit/` files are byte-identical to the repo blobs at 15ad0042 and ea6717d2, and to
  KIT-MANIFEST's sha256s (asserted in INVENTORY `nativeKit`). Because of that, they are not stored twice.

**Captured besides commits:**
- CPU worker `FINAL.txt` (dated report; it says "NOT a full fix yet") and `native-canary/run-cpu-canary.ps1`. The runner is raw
  source, with no prebuilt binary.
- `KIT-MANIFEST.json`, `KIT-EXPECTED.json` and `NATIVE-CANARY.txt`.
- Root receipts `nucbox-cpu-share-native-canary-20261023.json` (17:00:57Z: canary passed, production rollout pending) and
  `nucbox-coupled-accounting-active-20261023.json` (17:20:21Z: node accounting active; public fleet 17:22:15Z 17% CPU and 16.3 GiB
  free of 96; 9 apps; c13 → 2% / 1966 MiB; 8 VM IDs unchanged).
- The 1639 receipt.
- Snapshots (taken 17:30:05Z) of root's journal and effective-goal-requirements.

**Test results, preserved as root reviewed them; D did not re-run them:**
- **Node:**
  - new 14/14;
  - defect 6/6 (0/6 on the baseline);
  - client 27/27, memory 1/1, hosting 25/25, isolation 15/15, preclaim 5/5, scan 13/13.
  - The broad suite is **222/233**: the same 11 pre-existing baseline fixture failures, which are documented and **NOT** green.
- **CPU:**
  - call chain 11/11 (2/11 on the baseline);
  - guest real-load seam 3/3 (1/3 on the baseline).
- **Native:**
  - 1%/21%/13% exact WMI limit and reservation;
  - all guest VPs online; cleanup 0;
  - the 12 original VM IDs and states, and manager PID 2376, unchanged;
  - no production manager or image updated.
  - Guest cgroup enforcement is not yet native.

**Manifest:** 4551 → **4689** (+138, 2,110,691 bytes); 0 changed, 0 removed.
- **Prescans** (export-1):
  - gitleaks found no leaks over the export directory (1.98 MB) or the 10 staged frozen/evidence files (94 KB);
  - `scan-crypto-keys --files` gave 0.
- **Range scan** `1219a988..6dcde703`: scan-crypto-keys 0 and gitleaks no leaks (2.21 MB).
- **Content check** (queue job): 140 committed files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Tracking:** 4689/4689 entries are tracked and match their committed blobs. 21 stored files are guard logs that the ignore rules
  hide; they are committed source content, and each was sha-verified before `add -f`.
- **Post-push** (postpush-2):
  - 10/10 frozen files are unmoved.
  - node-shares, cpu-enforce, cpu-oldguest and node-report are at their frozen heads.
  - **root-validation advanced** to 6ac5e111 at 17:32:06Z ("Pin the installed Windows launcher used by the CPU guest"; adds
    launcher-pin.json, read-launcher-pin.py and 2 guard logs). That is after the freeze. c516049c is its ancestor and was captured
    exactly. **6ac5e111 is NOT captured**; it belongs to the active guest build.

**Not captured:**
- The CPU worker's new build workspace and outer build and progress files (`build/`, `freeze/`, `scratch/`, `seam-tree/`,
  `baseline-tree/`, BUILD/progress text, `run-*.sh`, `logs/`), any binary, and its ROOT-*.txt notes.
- The untracked files of the node report repo and root-validation.
- resource-guest-lineage, M sealed-startup, T HDD client recovery and every other active tree.

**Attempts (all logs retained):**
- **export-1, capture-1, commit, scan, content check and push:** each passed first time.
- **First content check:** I first ran it directly, outside the queue (a read-only `git show` loop). It was re-run as the queue job
  `frozen-1726-content-check`, with the same result.
- **postpush-1** (rc 1): my head check required each branch to be exactly at its frozen head, and root had just committed 6ac5e111 on
  root-validation. The check now requires the frozen head to be the branch head or an ancestor of it, and reports later commits.
  **postpush-2** passed. The push itself had already succeeded, and nothing in the checkpoint was affected.

Root will verify the remote independently.
