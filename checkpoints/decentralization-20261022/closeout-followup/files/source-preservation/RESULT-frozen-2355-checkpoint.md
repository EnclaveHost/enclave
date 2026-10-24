# Checkpoint publication, batch "2355": the 23:36 boot-fee attempt, H explicit-fee source, D boot-fee kit, current docs

"2355" is this batch's identifier: its actual start, 2026-10-23T23:55:07Z (`date -u`). It is SOURCE + EVIDENCE preservation only.

**Control recovery is NOT done.** The 23:36:51 attempt (`5db2be3f`, measurement `bc731956…`) went as follows:
- the normal `setProofKey` succeeded (tx `0x12d7a5a4…`);
- it adopted both original VMs with the same IDs;
- the gate then FAILED at 23:43:16, on one EyesOff URLError;
- the automatic rollback at 23:43:19 left the old control unregistered.

**Aftermath:**
- Health was last observed at 23:47:01, with both apps passing.
- The operator has 145,368,427,115 wei at nonce 23760, and no restart is planned.
- The original custody is unchanged, and there are no lifecycle canaries.

**Pushed:** `checkpoint/decentralization-20261022` 48c524ae → **`1a69ae562aaf41f73dfc0db303a3507a7f9a5458`**, tree
**`a5fcab30a5eeb9b93201ed832f047a06d3b27e49`**.
- **Commit:** made at 23:57:03Z by SteveDeFacto (noreply). The hooks ran; none was bypassed.
- **Push:** a normal fast-forward.
- **Independent check:** `ls-remote` at 23:57:33Z reads checkpoint 1a69ae56 and main **68b82926968c99503d38ae78dbcb04694cc2c56c**,
  unchanged.
- **Queue:** the 256 MiB lane, peak 103 MiB. No try answered NOT STARTED, and every job passed on its first attempt. There was no
  network use beyond git push and ls-remote.

## Before the batch

- **current-docs:** 967eeb96 → **155a23f450189d26eb045d2fb5f430d595250132**. It adds the status matrix: source-tested and inert,
  versus proven only by SNP startup tests, versus production lifecycle never executed. It also covers:
  - the 23:31-23:47 facts, all PROVISIONAL;
  - human items pending: the factory page (39672), upload and catalog (39675), and a 0.0001 ETH top-up to `0x29479…`;
  - host enrollment blocked on operator gas; **payout is not accepted host ownership**, and the custody host owner is ZERO;
  - H's keeper is source-only and not installed, and M's funding work is an assessment only.

  It made no claim of migration or old-copy deletion, and kept all earlier limitations. Scans: 13 commits clean.
- **Public output:** the top status of `outputs/decentralization-audit/custody-v2-live-verification-20261023.md` was corrected,
  dated 23:54 UTC. Health is given only as last observed at 23:47. The bytes went from 60408087 to **6d1e3d31**.

## Frozen inputs

| Side | Base → head | Head tree | Reproduces |
|---|---|---|---|
| custody-live9 | 851f7579 (frozen-2329) → **2b0c975b5b299cff4574099f8078ee3d8fce38b5** | 76bc73aa | exact |
| current-docs4 | 967eeb96 (frozen-2329) → **155a23f450189d26eb045d2fb5f430d595250132** | fd4a750e | exact |
| boot-source3 | 9f6d37bd (frozen-2217) → **5db2be3f4d4bed2c543e1e181c976ca9e26aa410** | 2517e494 | **PATCH-ONLY**, parent-anchored: supervisor.js held back (literal); gsup and registry test base blobs equal pushed records; 2 new tests; real parent + patch == head tree asserted |
| d-fee-kit | root → **9d75f953b463c56835934f5262a0aba914087ff3** | orig a3181ada (derived a783511d) | the committed old baseline omitted, blob recorded |

**Exact-bytes files**, read and scanned:
- **Root-allowed receipts:**
  - `custody-boot-fee-activation-20261023/result.json` (462acf11…);
  - `gate.json` (ee4007e1…);
  - `evidence/postrollback-public-health.json` (dce2cfde…).
- **H outer docs:** `NORMAL-FEE-FIX.md` (e6ad5ac3…) and `FEE-AMEND-STATUS.txt` (7b13c7dd…).
- **Also stored:** the 2329 receipt and the corrected public output (6d1e3d31…). The pre-correction bytes equal the stored 2329
  snapshot 60408087 and were not stored again.

**Reproduction:** `frozen-2355-export/REPRODUCE-CHECK.txt`, with every side true. INVENTORY `cc723e5d` was byte-identical across two
exports, in each of export-1 and capture-1.

**Checks:**
- **Prescans:** gitleaks found no leaks over the export and the 7 frozen and receipt files, and scan-crypto-keys gave 0.
- **Range scan** `48c524ae..1a69ae56`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 129 files, with no binary, no file over 5 MB, no literal and no PK block.
- **Manifest:** 6581 → **6708** (+127, 1,151,663 bytes).
  - **Old entries:** all 6581 are byte-identical.
  - **Tracking:** 6708/6708 entries are tracked and blob-matched. 10 ignored-pattern files were force-added after sha verification.
- **Post-push:** the 7 frozen and receipt files are unmoved, and all 4 sources are at their frozen heads.

**Not included:**
- builder `979a9ef`;
- the H lease keeper, M funding and gate v5;
- the D kit's private-backup, raw attestation, `logs/root-*`, `ROOT-*` files, plan, admission and build files, and other evidence;
- the whole old parent tree;
- keys, signatures, images and WIP.

Root will verify the remote independently.
