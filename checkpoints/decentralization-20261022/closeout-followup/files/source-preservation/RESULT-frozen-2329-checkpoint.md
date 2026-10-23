# Checkpoint publication, batch "2329": failed 23:10 control recovery receipts, old D kit, live records, current docs

"2329" is this batch's identifier: its actual start, 2026-10-23T23:29:30Z (`date -u`). This is SOURCE and EVIDENCE preservation
only.
- Control recovery is NOT done. The 23:10 activation of `b007d471` failed, and the 23:15:29 rollback restored the unregistered old
  control.
- Health was last observed at 23:16:22.
- The explicit-fee H build `5db2be3f` (running 23:28, not verified, not activated) and any new D build are NOT included.

**Pushed:** `checkpoint/decentralization-20261022` ef1baaa1 → **`48c524ae5bb8a7d9787d44d148cb2f624413bd05`**, tree
**`d3f4e65b2b3b934116d9ca3c77a65f0f010fba32`**.
- **Commit:** made at 23:32:34Z by SteveDeFacto (noreply) as author and committer. The hooks ran; none was bypassed.
- **Push:** a normal fast-forward.
- **Independent check:** `ls-remote` at 23:33:03Z reads checkpoint 48c524ae and main **68b82926968c99503d38ae78dbcb04694cc2c56c**,
  unchanged.
- **Queue:** every job ran in the 256 MiB lane, with peaks of 0–87 MiB. No try answered NOT STARTED, and every job passed on its
  first attempt.
- **Network:** nothing besides git push and ls-remote.

**Before the batch (root-authorized):** the top status of root's public `outputs/decentralization-audit/custody-v2-live-verification-20261023.md`
was corrected at 23:29:55Z, from the current-docs draft. The corrected text:
- states the 23:10 failed recovery and the 23:15 rollback;
- gives health only as last observed at 23:16:22;
- gives both verified renewals;
- labels the fee cause as NOT confirmed (13.2 mwei = SDK scenario / suspected);
- says the `5db2be3f` build is not yet verified and nothing is activated.

The bytes are 4d613dc8 → 60408087, and both versions are snapshotted below.

**Frozen inputs:**

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live8 | b4e1f14 (frozen-2246) → **851f75797b09b7dce8d7b256baedc1b74803f203** | c8abbfae | exact |
| current-docs3 | 1b3c2611 (frozen-2246) → ac48ded, 50f05862 → **967eeb96dfaf7df7ca2f9db334c9f3b8b3d743f2** | 60f2fe7e | exact |
| d-kit (derivative) | root → **8bbd0a745641f8f66d835c75eb3a8e3feef3eb47** | orig 9a5a3b2c (derived be4f7083) | the committed baseline `evidence/original-baseline-20261023T213130Z.json` omitted, blob recorded |

Also stored:
- **Root runtime receipts, explicitly allowed, exact bytes:**
  - `custody-boot-price-activation-20261023/result.json` (511808455bac7ef4…);
  - `evidence/postrollback-health.json` (5f131bf1687044bd…).
- **The 2246 receipt.**
- **The public output, twice:**
  - pre-correction (4d613dc8…);
  - corrected (60408087…).

  The earlier stored bytes of that output are unchanged.

**Reproduction:** `frozen-2329-export/REPRODUCE-CHECK.txt`, with all sides true. Bases were rebuilt from ef1baaa1's stored chains.
INVENTORY `4ca85772` was byte-identical across two exports, in each of export-1 and capture-1.

**Checks on 48c524ae:**
- **Prescans:** gitleaks found no leaks over the export and the 5 frozen and receipt files, and scan-crypto-keys gave 0.
- **Range scan** `ef1baaa1..48c524ae`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 122 files, with no binary, no file over 5 MB, no rewritten literal and no PK block.
- **Manifest:** 6461 → **6581** (+120, 1,012,935 bytes).
  - **Old entries:** all 6461 are byte-identical.
  - **Tracking:** 6581/6581 entries are tracked and blob-matched. 9 ignored-pattern files were force-added after sha verification.
- **Post-push:** the 5 frozen and receipt files are unmoved, and all 3 sources are at their frozen heads.

**Not read or stored:**
- from the D kit: `private-backup/`, raw attestation, `logs/root-*`, `ROOT-*` files, other evidence, and review and progress files;
- the active H (`5db2be3f` / `9b82acc8`) and new D sources;
- images, binaries, keys and uncommitted WIP.

Root will verify the remote independently.
