# frozen-2355 export: how to rebuild

"2355" is this batch's identifier: its actual start, 2026-10-23T23:55:07Z (`date -u`). It is SOURCE + EVIDENCE only. Control recovery
is NOT done. Root owns all activation and signing.

**State at the freeze:**
- The 23:36:51 attempt (`5db2be3f`, measurement `bc731956…`) registered with a normal `setProofKey` and adopted both original VMs.
- Its operational gate then FAILED at 23:43:16, and it rolled back automatically at 23:43:19 to the unregistered old control.
- Health was last observed at 23:47:01, with both apps passing.

**Not included:**
- the builder `979a9ef`;
- the lease keeper;
- the funding and gate-v5 work.

**How each side was exported.** From Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- hunk headers carry no function context.

| Side | Base (pushed) | Head |
|---|---|---|
| custody-live9 | 851f7579 (frozen-2329) | **2b0c975b** |
| current-docs4 | 967eeb96 (frozen-2329) | **155a23f4** |
| boot-source3 (PATCH-ONLY) | 9f6d37bd (frozen-2217 boot-source) | **5db2be3f** (not reproduced as a whole tree) |
| d-fee-kit (derivative) | empty | **9d75f953** (committed old baseline omitted) |

## boot-source3: parent-anchored patch only

This follows the boot-source and boot-source2 method. The whole old parent tree is never exported.

**What is published:**
- the literal-free exact patch;
- `metal/guest/gsup.mjs` and `test/registry-advertise-retry.test.mjs` at base and head;
- the new tests `test/boot-gpu-price.test.mjs` and `test/operator-fee-path.test.mjs`.

**Held back:** `supervisor.js`, which carries the rewritten provider name at base and head. It is recorded by blob and sha256, and the
patch's index line names those blobs.

**Base-blob anchors:** every base blob equals a pushed record:
- supervisor.js and the registry test: the frozen-2217 boot-source head blobs;
- gsup.mjs: the frozen-2146 a6b1378c head blob.

**Export-time check:** the real parent 9f6d37bd plus the patch gives the 5db2be3f tree.

## d-fee-kit: committed old baseline omitted

`evidence/original-baseline-20261023T213130Z.json` is omitted, as in 2217 and 2329. Its blob is recorded.

## Root-allowed receipts and outer docs (exact bytes, read and scanned)

- **rootEvidence:** the kit's `result.json` (462acf11…), `gate.json` (ee4007e1…) and `evidence/postrollback-public-health.json`
  (dce2cfde…). Root allowed these as public ids, hashes and status only.
- **frozenSources:** H's outer `NORMAL-FEE-FIX.md` (e6ad5ac3…) and `FEE-AMEND-STATUS.txt` (7b13c7dd…).

**Never read:** `private-backup/`, raw attestation, `logs/root-*`, `ROOT-*` files, plan, admission and build files, and the kit's other
evidence.

## Snapshot

The public output after its 23:54Z top-status correction (6d1e3d31…) is stored. The correction gives health only as last observed at
23:47. It sets out three classes of item: source-tested and inert, proven only by SNP startup tests, and production lifecycle never
executed. It also says payout is not accepted host ownership.

Its pre-correction bytes equal the 2329 snapshot (60408087…) that is already stored, so they are not stored again.
