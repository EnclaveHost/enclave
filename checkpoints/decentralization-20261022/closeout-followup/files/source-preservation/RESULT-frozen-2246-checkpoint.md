# Checkpoint publication, batch "2246": live renewals, boot-pricing source and root build metadata, canary-wallet handoff, current docs, live-verification snapshot

"2246" is this batch's identifier: its actual start, 2026-10-23T22:46:00Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only. It is NOT a rollout and NOT recovery.

**State at the freeze** (root, 22:45Z):
- The metal0 control is still on `ed918e4b` and unregistered.
- The boot-pricing candidate `7dd3acd0` was root-approved and built twice, byte-identical, at 22:29 (`b007d471…`). It is **NOT
  activated**.
- The new D activation kit is under review and **excluded**.
- Both tenants' original guests are running.
- The custody original is unchanged, and no secret lifecycle test has been run.
- The factory page (39672) and the canary-wallet page (39675) both await the human.
- No committee, admin contract, book or dashboard change.

**Pushed:** `checkpoint/decentralization-20261022` 7ca36e11 → **`ef1baaa1b136208e2e86e5f978b7095617fdb501`**, tree
**`6382145009302f86319eec7ac24c466adc1b0a23`**.
- **Commit:** made at 22:51:42Z (git 15:51:42-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward.
- **Independent check:** `ls-remote` at 22:52:19Z (postpush job) reads checkpoint ef1baaa1 and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or history rewrite. No production, chain, SSH, wallet or hardware access.
- **Queue:** every job ran through the unchanged queue in the 256 MiB small lane. Peaks were 0–129 MiB.
  - One try answered `NOT STARTED: small allocation held` (the first checkpoint-commit). It is kept as
    `frozen-2246-checkpoint-commit.try2.out` and was retried at the same cap.
  - Every job passed.

## Before the batch (items 3 and 5 of root's list; root-authorized source changes)

- **current-docs:** 8fda71f2 → **1b3c26117d2ca4bb6488ea51f9180c6004abe2bd**. It adds root's 22:45Z factual status with measured
  times, all PROVISIONAL:
  - the candidate is NOT activated and recovery is NOT done;
  - renewals: imagegen at 22:39:27 (tx `0x843c4aa8…`, 1,265,909,891,753 wei) and EyesOff at 22:43:54 (tx `0xeb9279fd…`,
    1,237,616,215,992 wei), from the committed receipts in b4e1f14;
  - the factory and canary-wallet pages are pending the human.

  The strict rollback docs and the `docs/security` patch chain are unchanged. Its scan, commit and range-scan (9 commits) are
  clean.
- **boot-price-release:** a340762b → **88b70dbefdff5c2433317da6d184b5e09e363e78**. This is root's granted commit of EXACTLY the
  public build metadata:
  - `APPROVED-COMMIT.txt`;
  - `stage/build-record.json`, `stage/INVENTORY.sha256` and `stage/7dd3acd06-on-9f6d37bd.patch` (sha256 7283a33a…, equal to the
    build record);
  - `logs/root-build-price.{out,guard.log,rc}`;
  - `stage/dist-leasegas-7dd3acd06/{MEASUREMENT,manifest.json,cmdline}`.

  The build scripts and the approval are unchanged. `initramfs.cpio.gz` and `vmlinuz` were NOT committed; their sha256 are in
  `INVENTORY.sha256`. It was made through the queue with the key-scan hook. The `INVENTORY.sha256` check passed before the commit.
- **Snapshot:** the 22:42:35Z version of root's public `outputs/decentralization-audit/custody-v2-live-verification-20261023.md`
  (sha256 `d57763d1…`), pinned by `make-frozen-2246-snapshots.py`.
- **Log location:** the logs of these jobs (bpr-commit-1, snap-2246) are in `custody-v2-current-docs-20261023/logs/`, uncommitted.

## Frozen input list

Exactly root's designated heads (`custody-v2-current-docs-20261023/ROOT-PRESERVE-2245.txt`), resolved from 22:46Z. Every commit's
author and committer is SteveDeFacto (noreply), and there are no merges.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live7 | ed284731 (frozen-2217) → d64f0443 → **b4e1f14f2ce65799978c18ce201f3a5ef674569c** | 3e070b68 | exact (known-state 22:20, renewals 22:39, probe; no logs or raw quotes) |
| boot-source2 | 9f6d37bd (frozen-2217 boot-source) → **7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b** | d1754a00 | **PATCH-ONLY** (below) |
| boot-price-release (new) | root → a340762b → **88b70dbefdff5c2433317da6d184b5e09e363e78** | ff2085e8 | exact |
| canary-wallet (new) | root → f161ceb3 → **b5e4613c632b47056fba3de6064bc56b00bedcb5** | a05c7587 | exact (journals never read; no WASM) |
| current-docs2 | a257c0e0 (frozen-2217) → ac4d9da2, c571a3f6, 8fda71f2 → **1b3c26117d2ca4bb6488ea51f9180c6004abe2bd** | 078a51a9 | exact |

- **Reproduction:** `frozen-2246-export/REPRODUCE-CHECK.txt`, with every side true.
  - Bases were rebuilt offline from 7ca36e11's stored chains: custody-live from the 1852/1951/2025/2100/2146/2217 chains,
    current-docs from its 2217 chain.
  - INVENTORY `7a40d80b` was byte-identical across two exports, in each of export-1 and capture-1.

**boot-source2: patch-only** (the prior boot-source method; no literal waiver, and no unpublished parent tree exported):
- **Held back:** `supervisor.js` carries the rewritten provider name at both base and head.
- **Published:**
  - the literal-free exact patch;
  - `metal/guest/gsup.mjs` and `test/registry-advertise-retry.test.mjs` at base and head;
  - the new `test/boot-gpu-price.test.mjs`.
- **Anchors:** every base blob equals a pushed record. These were asserted at export and re-checked by the verifier:
  - `supervisor.js` 66ad07d3 and the registry test 0fa12218: the frozen-2217 boot-source head blobs;
  - `gsup.mjs` 198dca46: the frozen-2146 a6b1378c head blob.
- **Export-time check:** the real parent 9f6d37bd plus the patch gives the 7dd3acd0 tree.

**Checks on ef1baaa1:**
- **Prescans** (export-1): gitleaks found no leaks over the export, the frozen receipt and snapshot, and the tools; scan-crypto-keys
  gave 0.
- **Range scan** `7ca36e11..ef1baaa1`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 130 files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Manifest:** 6333 → **6461** (+128, 1,288,598 bytes).
  - **Old entries:** all 6333 are identical JSON and byte-matched. Only MANIFEST.json and README.md were modified, and README kept
    every line.
  - **Tracking:** 6461/6461 entries are tracked and blob-matched. 10 ignored-pattern files were force-added after sha verification.

**Captured besides commits:** the 2217 receipt and the 22:42 live-verification snapshot. The earlier stored bytes of that output
(23c9aeba, and the 2025 and 2100 snapshots) are unchanged.

**Excluded (by instruction or rule):**
- the new D activation kit (`custody-boot-price-activation-20261023`) and the rejected W helper;
- canary-wallet `journals/`;
- the image binaries;
- untracked root files in boot-price-release (`ROOT-ACTIVATION-NEXT.txt`, activation progress/err files, `logs/commit-1.*`);
- all uncommitted WIP, private files, signatures, keys, raw quotes and WASM.

**Post-push:** the 2 frozen inputs are unmoved, and all 5 sources are at their frozen heads.

Root will verify the remote independently.
