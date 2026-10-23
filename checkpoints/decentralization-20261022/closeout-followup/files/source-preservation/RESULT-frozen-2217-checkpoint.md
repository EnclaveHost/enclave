# Checkpoint publication, batch "2217": live renewals, boot-registration build and source, activation kits, proof-app publish prep, reconciled custody docs

"2217" is this batch's identifier: its actual start, 2026-10-23T22:17:46Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only. It is NOT production completion, and it claims no rollout.

**State at the freeze** (PROVISIONAL, from root's 22:14Z journal):
- metal0 control recovery is IN PROGRESS. The control is still on the old `ed918e4b` image and is unregistered.
- `08d1f838` is staged and admitted (relay allowlist 37) but NOT activated. Root stopped the cutover before any mutation after a
  pre-discovery GPU-price race was found.
- The new boot-pricing fix is root/worker WIP and NOT included.
- There is no new custody committee, policy, v2 book entry or dashboard publication. Admin controls are preserved.

**Step 1: the current-docs refresh (done first, as asked).**
- `work/custody-v2-current-docs-20261023` advanced dfca5f0 → **a257c0e04bb8fe4d1ae14064758c411ed92c1f5b**. It now carries root's
  22:14Z facts, marked PROVISIONAL and timestamped:
  - the control is still old and unregistered;
  - 08d1 is admitted but not activated, and the cutover was stopped;
  - imagegen's second app-reserve renewal at 22:10:58 (tx `0x398217e3…`, 1,249,747,460,565 wei);
  - a lease renewal extends about 30 min, not 1 h;
  - the original custodian `c866` returned a fresh SNP quote that passed at 22:12:53, with no secret flow;
  - the factory page is still pending the human (journal empty at 22:11).
- `docs/security/` and `patches/` are unchanged.
- **Checks:** the prescan (`scan-2`) and the post-commit scan of all 5 commits (`rangescan-2`) are clean, and the commit went through
  the key-scan hook. All ran in the queue at 256 MiB.

**Pushed:** `checkpoint/decentralization-20261022` dfb4b55e → **`7ca36e11f65c76feaf6c26405b5a27a7457f113d`**, tree
**`8ee31ebad40c1a9353e00ef8361139a8445a2ea9`**.
- **Commit:** made at 22:21:33Z (git 15:21:33-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, `dfb4b55e..7ca36e11`.
- **Independent check:** `ls-remote` at 22:22:14Z (postpush job) reads checkpoint 7ca36e11 and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or history rewrite. No production, chain, SSH, wallet or hardware access, and no edit in
  any worker tree.
- **Queue:** every job ran through the unchanged queue in the 256 MiB small lane. Peaks were 0–125 MiB. There were no NOT STARTED
  tries, and every job passed on its first attempt.

**Frozen input list.** Exactly root's designated heads (`custody-code-admission-20261023/ROOT-PRESERVE-2215.txt`), resolved at
22:17Z. Every commit's author and committer is SteveDeFacto (noreply), and there are no merges.

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live6 | 1535fcf0 (frozen-2146) → **ed2847318caa6a6ab729332a6c271ecad43f0684** | b84ef921 | exact (root metadata, probes and renewal records; no logs or raw quotes in range) |
| recipient-restore2 | b03be02d (frozen-2146) → e02b3bd4 → **8f72453be3b702605b99a01621bd80aeb5211cfb** | 1eb98032 | exact (approved H build record and patch) |
| boot-source | a6b1378c (frozen-2146 recipient-restore-repo) → **9f6d37bd858ad44be1171b6415353910214c2fa5** | 59f0a46d | **PATCH-ONLY** (below) |
| recipient-activation2 | 2d407753 (frozen-2146) → cb7fa858, c83f2b39 → **48cc74bfb8ea2b6d13617b82c5c154789c884cd0** | 9d278ae1 | exact |
| boot-activation (new) | root → fa76e9bb → **86c5fee82c98278e4d1c9446a63f903ab6a131e2** | orig e4b4b85c | derivative: committed runtime baseline omitted (below) |
| proof-app2 | e84a1afd (frozen-2146) → ac33146d → **ad81dd59f1559dfea74629d4133d75b168047c55** | d2aadd32 | exact (catalog and pacing source and evidence; no WASM or component binary) |
| current-docs (new) | root → dd9cc622, 42015b1e, 9d58a8b2, dfca5f05 → **a257c0e04bb8fe4d1ae14064758c411ed92c1f5b** | 89f863af | exact |

- **Reproduction:** `frozen-2217-export/REPRODUCE-CHECK.txt`, with every side true.
  - Bases were rebuilt offline from dfb4b55e's stored chains: custody-live from the 1852/1951/2025/2100/2146 chains, the others from
    their 2146 root chains.
  - INVENTORY was byte-identical across two exports, in each of export-1 and capture-1.

**boot-source: explicit source patch** (no literal waiver; matches the 2146 touched-file method):
- **Why patch-only:** 9f6d37bd's parent lineage, and `supervisor.js` itself at both base and head, contain the provider name the
  2026-10-21 rewrite removed. Neither whole tree nor supervisor.js is published.
- **Published:**
  - the exact `format-patch` (literal-free);
  - `test/registry-advertise-retry.test.mjs` at base and head;
  - supervisor.js's base and head blobs and sha256.
- **Export-time check:** a throwaway index of the REAL parent a6b1378c plus the patch gives the 9f6d37bd tree 59f0a46d.
- **Verifier checks** (from pushed material):
  - the base test file plus the patch, restricted to that path, gives head blob 0fa12218;
  - the patch's index line names supervisor.js `f6b668cb..66ad07d3`;
  - the supervisor.js base sha256 `01ac9cb1…` equals production `/app/supervisor.js` in the deabf8f90 initramfs inventory pushed in
    f2e7009e.

**boot-activation:**
- Root's runtime files (logs/root-*, private, evidence/private, approval, admission and plan files) are ignored and were never read.
- The one COMMITTED runtime record, `evidence/original-baseline-20261023T213130Z.json` (a read-only production unit and config
  baseline), is excluded per "source/provenance/tests only". Its blob and sha256 are recorded.
- The tree is reproduced as derived.
- The committed test and probe queue logs and the test fixtures are kept.

**Checks on 7ca36e11:**
- **Prescans** (export-1): gitleaks found no leaks over the export, the frozen receipt and the tools, and scan-crypto-keys gave 0.
- **Range scan** `dfb4b55e..7ca36e11`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 199 files, with no binary, no file over 5 MB, no rewritten literal and no private-key block.
- **Manifest:** 6136 → **6333** (+197, 1,671,326 bytes).
  - **Old entries:** all 6136 are identical JSON and byte-matched. Only MANIFEST.json and README.md were modified, and README kept
    every line.
  - **Tracking:** 6333/6333 entries are tracked and blob-matched. 16 ignored-pattern files were force-added after sha verification.

**Captured besides commits:** the 2146 receipt.

**Not captured (by instruction):**
- the ongoing H boot-pricing fix;
- the new wallet repository and the new build template;
- all uncommitted WIP, untracked task/progress files, binaries, WASM, raw quotes, keys and sealed state.

**Post-push:** the frozen receipt is unmoved. 6 of 7 sources are at their frozen heads.
- custody-live advanced to **d64f0443** (15:20:09-07:00, "Confirm second EyesOff app-funded renewal …"). It is NOT captured;
  ed284731 is its ancestor.
- The boot-registration repo's checkout is on branch `boot-gpu-price` (0c565d3c, the pending pricing fix, not captured). Its
  `boot-registration-adopt` branch is still at 9f6d37bd.

Root will verify the remote independently.
