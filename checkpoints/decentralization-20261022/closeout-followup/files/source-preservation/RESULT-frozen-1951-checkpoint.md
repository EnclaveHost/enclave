# Checkpoint publication, batch "1951": CPU production activation and the custody v2 corrected-image, durability, dashboard and live-config records

"1951" is this batch's identifier: its actual start, 2026-10-23T19:51:51Z (`date -u`). Every time below is measured. This is SOURCE
and EVIDENCE preservation only.
- **CPU:** the production activation is root's. Per root's receipt and journal, all 9 apps run on exact coupled shares, with strict
  CA/hostname HTTPS 200 on all 18 routes at 19:41Z.
- **Custody v2:** release image e012 is proven quote-only on hardware. It is superseded for activation by root's a5eae96c startup
  fixes, which are source only and not built. Neither is activated. Existing custody is the original single-seat bootstrap, NOT
  decentralized custody.

**Pushed:** `checkpoint/decentralization-20261022` 45bf6552 → **`dc551728a71e29adb8eda127f4607395a4d97b66`**, tree
**`f0e5960cebb31c9446ab5f2aa798be41da236fab`**.
- **Commit:** made at 19:57:36Z (git 12:57:36-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward, which returned by 19:58:27Z. An independent `ls-remote` at 19:58:27Z (postpush job) reads
  checkpoint dc551728 and main **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or history rewrite, no SSH, production, wallet or live action, and no edit in any worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**, with no not-started tries and no job stopped.
  Peaks: 21–167 MiB.

**Frozen input list.** Resolved once at 19:51–19:53Z, and not grown afterwards. Every author and committer is SteveDeFacto (noreply).

| Side | Base (pushed in 45bf6552) → head | Head tree | Reproduces |
|---|---|---|---|
| cpu-activation | root → 3451c90 → **785f77af** | d8d44a53 | exact |
| sched-manager | ea6717d2 (frozen-1726 cpu-enforce) → ab2ed9a2, 2cea9ead → **1bda7b79** | 5aa32ffb | exact |
| sched-guest | root → f7b6ff55, 3dbbf835, 216c3807 → **f6d5fbed** (orig b424a5c4) | 7b29e50c | derivative (1 fixture log) |
| durability2 | 415483ff (frozen-1852 m-durability) → 3ccd4333, 0a6b108e, c95dcd3a → **a5eae96c** (orig d8afe7ff) | — | touched files only (1 test helper omitted) |
| custody-release | root → **44bf8f4f** | afec64f0 | exact |
| dashboard | ff13ebe0 (frozen-1639 e-gen) → 2cf89ae2 … **4acad4a7** | cfaa8d49 | exact |
| custody-live2 | a90f8339 (frozen-1852) → **70019fdf** | bb19b19a | exact |
| root-native2 | 8afbf879 (frozen-1852) → **e859355e** | 3b445521 | exact |

- **Reproduction:** `frozen-1951-export/REPRODUCE-CHECK.txt`. All 8 sides are true. Every base was rebuilt from 45bf6552's stored
  patch chains; the dashboard base needed 20 patches and the sched-manager base 10.
- **durability2:** it continues frozen-1852's touched-file mode, because its base descends from the unpublishable pre-rewrite
  c635fd68.
  - `base-files/` stores the 415483ff blobs of the 11 modified files; the export asserts they equal the frozen-1852 head blobs.
  - The verifier checks all 15 touched path blobs at every commit. The full trees are not claimed.
- **Stability:** the INVENTORY `69d75e7f` was byte-identical across two exports, in both the export-3 and capture-1 jobs.

**Scan findings, reviewed one by one** (export-1 had 8 gitleaks generic-api-key hits; scan-crypto-keys gave 0). None was
allowlisted, and `.gitleaks.toml` is unchanged. The reports are kept as `frozen-1951-prescan-gitleaks.export-{1,2}.json`.
- **`isolation/m3/hv-accept-check-2026-09-25.txt` in the guest repo** (the file and its patch hunk). This is a local QEMU/KVM
  fixture log (not Hyper-V).
  - Its `launcherKey` is the launcher's **public** report verification key: 32 bytes, base64. `hvlab-accept.mjs` judges reports
    with it, so it is not a secret.
  - The file is omitted, which makes sched-guest a derivative. Restore it from the guest repository at f6d5fbed; its blob is in
    `omittedAtHead`.
- **`test/helpers/original-vault-rig.mjs` in durability2** (the file and its patch). The hit is contract identifiers: the V2 vault's
  quoted source-file name followed by its quoted contract name.
  - The file is omitted from the patches and from the touched-path check. Restore it from M's repository at a5eae96c; its blob is
    recorded.
- **4 lines in my own INVENTORY.** Blob SHA-1s were keyed by the path `secret-custody-v2.md`. `touchedBlobs` is now a list of
  `{path, blob}` objects.
- **export-2:** one more hit, in my own REBUILD.md, which quoted that identifier pair. I reworded it, and export-3 was clean.
- **Public certificates:** the committed public CA root and chain `.pem` files in the guest source (isrg-root-x1/x2, sectigo,
  usertrust, two Let's Encrypt/ZeroSSL chains) are certificates, not keys. Neither scanner flagged them, and the content check
  found no private-key block.

**Manifest:** 4929 → **5386** (+457, 7,370,208 bytes).
- **Old entries unchanged** (queue job `frozen-1951-oldbytes-check`):
  - `45bf6552..HEAD` only adds files, apart from MANIFEST.json and README.md;
  - all 4929 old entries and the earlier `appends` records are identical JSON;
  - every old entry's committed blob still matches its sha256 (0 mismatches);
  - README.md kept every old line.
- **Prescans** (export-3): gitleaks found no leaks over the export directory or the 4 staged frozen/evidence files, and
  `scan-crypto-keys --files` gave 0.
- **Range scan** `45bf6552..dc551728`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 459 committed files, with no binary, no file over 5 MB, no rewritten literal in either case, and no
  private-key block.
- **Tracking:** 5386/5386 entries are tracked and match their committed blobs.
- **Post-push:** the 4 frozen files are unmoved, and 7 of 8 source repositories are at their frozen heads. **custody-v2-live has
  advanced** to 574fdc97 (12:54:03-07:00, "Reconcile custody authority and prepare unsigned enrollment and discovery plans"). That
  commit is root's live-probe work and is **NOT captured**; 70019fdf is its ancestor.

**Captured besides commits:**
- root receipts `nucbox-coupled-shares-production-20261023.json` (19:41Z) and `custody-v2-corrected-image-hardware-20261023.json`
  (19:31Z: quote-only, no keys, committee or genesis, not activated);
- the 1852 receipt;
- a snapshot of ROOT-CONTINUE-LATEST (up to the 19:50Z entry). ROOT-PENDING-LATEST and effective-goal-requirements are
  byte-identical to their frozen-1852 snapshots (asserted), so they were not copied again.

**Never read or captured:**
- binaries (the staged runtime `.bin`, launcher `.exe`, custodian images), node_modules, raw quotes, sealed state, private config,
  keys, and canary run directories and logs;
- untracked files in any repo, including custody-v2-live's book-plan output and other workers' task files;
- outer non-repo files;
- commits after the frozen heads (M/R resumed work, root live probes).

**Attempts (all logs retained):**
- **export-1** (rc 1) and **export-2** (rc 1): the gitleaks findings above.
- **export-3, capture-1, commit, scan, content check, old-bytes check, push, postpush and derivative-heads:** passed.

Root will verify the remote independently.
