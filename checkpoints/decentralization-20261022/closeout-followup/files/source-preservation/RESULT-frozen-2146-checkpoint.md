# Checkpoint publication, batch "2146": custody live incident reads, factory/canary/fee fixes, recipient restore and activation, proof app, code admission, publish readiness

"2146" is this batch's identifier: its actual start, 2026-10-23T21:46:39Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only. It is NOT production completion.
- **Activation.** Root's control activation of the restored-vault image ee5df6b8 FAILED adoption at 21:37Z and was rolled back to
  deabf8f9. Boot registration gas still blocks adoption.
- **Custody.** No new custody lifecycle has been done. The original custodian and committee 0x4774 are untouched.
- **Signing.** Factory signing is pending the human. Root owns all activation and signing.
- **Code admission.** R's finding is included as made: the original committee is code-FROZEN, not merely behind a 7-day delay.

**Pushed:** `checkpoint/decentralization-20261022` f2e7009e → **`dfb4b55e627ebd95b647abebf09627296f099862`**, tree
**`385cf45c7b56e2ad9d7709acb152b40e4519edac`**.
- **Commit:** made at 21:56:04Z (git 14:56:04-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, `f2e7009eb..dfb4b55e6`.
- **Independent check:** `ls-remote` at 21:57:04Z (postpush job) reads checkpoint dfb4b55e and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or remote history change. No production, chain, SSH, wallet or hardware access, and no
  edit in any worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**. Peaks were 0–130 MiB. No try answered NOT STARTED
  (no `*.tryN.out` files), and no job was stopped.

**Frozen input list.** Exactly root's designated heads (`custody-code-admission-20261023/ROOT-PRESERVE-2146.txt`), resolved at 21:46Z
and not grown afterwards. Every commit's author and committer is SteveDeFacto (noreply), and there are no merges.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live5 | dc07e225 (frozen-2100 custody-live4) → 1c8403e8, 570947d4 → **1535fcf0** | 0ec5226a | exact |
| factory-wallet2 | 24aac735 (frozen-2100) → 7f11fbf3, 99cf7f16 → **9557ad6d** | daf03b1e | exact |
| production-canary2 | 7bcd501f (frozen-2100) → c4d96a11, cb06e87b, 49fb0a6c → **01525201** | b9184661 | exact |
| operator-fees (new) | root → f2a7b81e, 1ac9ad2c → **7bf4c942** | 2e348c05 | exact (root's uncommitted FEE-NOTES.md edit omitted) |
| recipient-restore (outer) | root → **b03be02d** | 9c26fc2c | exact |
| recipient-restore inner repo | deabf8f9 → **a6b1378cdf430217025987d90c040d0e25a9993d** | d155f20e | touched files (below) |
| recipient-activation (new) | root → 7426b299, 2c5d9b5a → **2d407753** | 6424dd93 | exact (uncommitted operational files omitted) |
| proof-app (new) | root → **e84a1afd** | 71f91f09 | exact (untracked component binary never read) |
| code-admission (new) | root → **8578965c** | 749a99e3 | **exact** with the converted file reversed (below) |
| publish-readiness | root → f0efadbd → **90a2b826** (latest COMMITTED head, resolved once at 21:46Z) | 0bc4e7e3 | exact |

- **Reproduction:** `frozen-2146-export/REPRODUCE-CHECK.txt`, with every side true.
  - Bases were rebuilt offline from f2e7009e's stored chains: custody-live from the 1852/1951/2025/2100 chains, factory-wallet and
    production-canary from their 2100 root chains.
  - INVENTORY `38e37627` was byte-identical across two exports, in each of the export-3, export-4 and capture-3 jobs.

**Handled findings and limits** (nothing allowlisted; `.gitleaks.toml` unchanged; no source repository changed):
- **Inner repo a6b1378c: touched-file reproduction.**
  - **Why:** its parent deabf8f9 is the production linux post-adoption SCRATCH commit. It is not in pushed git objects (only
    file-level diffs in `external/scratch-repos`), and its tree has 26 files containing the rewritten literal.
  - **How:** following the 1852/1951/2025 precedent, `base-files/metal/guest/gsup.mjs` (blob dd8a2ac2) is stored. The patch then
    reproduces all 3 touched blobs.
  - **Cross-check:** the export asserts that base gsup.mjs sha256 `c2896d74…` equals `/opt/metal/gsup.mjs` in the production
    `dist-leasegas-deabf8f90` initramfs inventory already pushed in f2e7009e. So the exact source patch sits on the byte-identical
    production parent.
- **code-admission `tools/compile.mjs`.**
  - **Finding:** export-2 gitleaks reported generic-api-key at line 29 and in the 8578965c patch. The trigger is the vault's file name
    and contract name, two adjacent quoted strings, in a solc lookup. It is not a credential.
  - **Handling:** the documented reversible approach. The file is excluded from the patch and published as a converted copy (one comma
    → semicolon).
  - **Check:** the export asserts the round trip to blob e1013051. The verifier reverses it and reproduces the ORIGINAL tree 749a99e3
    exactly. The report is kept as `frozen-2146-prescan-gitleaks.json` from export-2.
- **Dropped commit.**
  - **Cause:** the first local commit 835c83a4 failed the range scan (gitleaks 2) because MY new REBUILD.md and an export-script
    comment quoted that pair verbatim. It was never pushed.
  - **Drop:** `frozen-2146-drop-commit-1` asserted the remote was f2e7009e, reset, and confirmed closeout-followup was clean (ignored
    files included).
  - **Fix:** both texts were rephrased, and the export prescan now also covers REBUILD.md and this batch's own tool files.
- **Omitted:** production-canary's committed `.gitleaksignore` (edited in this range) is preserved as content. The checkpoint's scans
  never use it. code-admission's test holds anvil's PUBLIC well-known test account key (local anvil only), which both scanners
  passed.

**Checks on dfb4b55e:**
- **Prescans** (export-4): gitleaks found no leaks over the export, the frozen file and the tools, and scan-crypto-keys gave 0.
- **Range scan** `f2e7009e..dfb4b55e`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 278 files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Manifest:** 5860 → **6136** (+276, 2,581,506 bytes).
  - **Old entries:** all 5860 are identical JSON and byte-matched. Only MANIFEST.json and README.md were modified, and README kept
    every line.
  - **Tracking:** 6136/6136 entries are tracked and blob-matched. 23 ignored-pattern files (committed `logs/*.guard.log` etc.) were
    force-added after sha verification (`frozen-2146-force-add.txt`).

**Captured besides commits:** the 2100 receipt. As instructed (exact frozen heads only), this batch has no journal or outputs snapshot.

**Never read or captured:** untracked task files, worker progress/err files, uncommitted WIP, root's in-progress H/W/D recovery
repositories (registration patch, proof-key update, attested-key verifier), images, binaries, CARs, raw quotes, sealed state, keys and
private config. Public hashes, proof-key and renew-intent metadata in committed evidence are kept; no signatures were stored.

**Post-push:** the frozen receipt is unmoved. 7 of 10 source heads are at their frozen heads; the code-admission derivative head is
included in that count.
- recipient-restore → e02b3bd4 (14:48:58-07:00);
- recipient-activation → cb7fa858 (14:48:58-07:00);
- proof-app → ac33146d (14:52:35-07:00).

These are later root/worker commits, NOT captured; each frozen head is their ancestor.

**Attempts (all logs retained):**
- **export-1:** rc 1, my inventory key lookup.
- **export-2:** rc 1, the gitleaks finding.
- **export-3:** passed.
- **capture-1:** rc 1, a missing REBUILD.md before any write.
- **capture-2, checkpoint-commit, oldbytes, content-check:** passed. **checkpoint-scan:** rc 1, after which the commit was dropped.
- **export-4, capture-3, checkpoint-commit-2, checkpoint-scan-2, content-check-2, oldbytes-check-2, push, postpush and
  derivative-heads:** passed.

Root will verify the remote independently.
