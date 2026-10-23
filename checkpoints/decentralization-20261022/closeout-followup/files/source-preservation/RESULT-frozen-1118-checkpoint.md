# Checkpoint publication, batch "1118": TLS + M memory finals, composed storage, E immutability final, seven root reviews

"1118" is this batch's identifier: its actual start, 2026-10-23T11:18:54Z (`date -u`). Every time below is measured, from
`date -u`, file mtimes or git metadata.

**Pushed:** `checkpoint/decentralization-20261022` f2db53ff → **`476c589bb35abd10efd830863b042e8801c18ef0`**, tree
**`2fa822986d9773dce140334f688a308a52be1375`**.
- **Commit:** made at 13:03:20Z (git 06:03:20-07:00), by SteveDeFacto (noreply) as author and committer.
- **Push:** a normal fast-forward at 13:35:54Z (the job's rc time). `ls-remote` read at 13:36:04Z confirms the new head.
- **Not done:** no force push, merge, signing, SSH, production action, wallet or contract change, image build or deployment.
- **Main:** this batch did not touch it. Remote `main` = **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged from the last
  observation. The push script required that value before and after.

| Side | Base (in pushed f2db53ff) → head | Head tree | Reproduces |
|---|---|---|---|
| tls-m | 4106c311 → 1957ff23, 6f6d22f5 (TLS worker final; = HEAD of `nucbox-tls-recovery-20261023/candidate`) → **9f19b7c6** (M) | 7c063b02 | exact |
| s-compose | bcd3d9ca → c74e302c → **92b71784** | 3540c71a | exact |
| rsfc-report | root → ccb55b83 → **dd5c9a59** | 5531c8f6 | exact |
| root-ram96 | root → d3b8e687, 2851f923 → **dd7e7af8** | ff047d83 | exact |
| root-allowlist | **a6186636** | dbfb80f7 | exact |
| root-iface | **73a2c086** | a6c9a313 | exact |
| root-mem | **c1f35cf5** | 562dcef0 | exact |
| root-main-delta | **2d78c982** | 850ac59c | exact |
| root-capacity | **f397cbf1** | b4dc4582 | exact |
| root-immutability | **b0236c87** | 5cb301a6 | exact |
| cache-boundary | root → 7 commits → **ea676d8b** | cf0e322f | exact |
| p-compose | f8351487's derivative → **f8c999ed** | 75cde59e (original fadd9004) | **derivative only** |
| e-final | ca818b75's derivative → a194afe2, 46dbfbef, 901d7b31, 029fdefe, c08331e9, e917c526 → **9c5e0eef** | 5ff100e3 (original 9812accc) | **derivative only** |

- **Reproduction:** `frozen-1118-export/REPRODUCE-CHECK.txt`. All 13 sides are true, built offline from f2db53ff's stored
  patches. 029fdefe and 9c5e0eef touch only `exports/`, so they have no derivative patch; the verifier checks that the
  derived tree is unchanged across them.
- **Stability:** INVENTORY `792510d7` was byte-identical across two exports, in both the export and capture jobs.
- **M's final patch** `windows-memory-accounting.patch` sha256 = eeab54d2…, as root recorded (asserted in the export).

**Omitted, with recipes:**

| What | Why | Rebuild / restore |
|---|---|---|
| P's 5 paths: the upstream lighthouse zip 28405c78, upstream `release.yml` 75a69cf0, and 3 job logs quoting Sigma Prime's public PGP fingerprint | binary / scanner false positive (the scanner is not weakened) | frozen-0931 p-l1 `omittedRecipe` + `omittedFingerprintFiles`; the blobs are identical (asserted) |
| E's `fixtures/artifacts/*.json` (13) | compiled solc outputs | `frozen-0931-e-artifact-recipe.json`; all 13 blobs are unchanged in this range (asserted) |
| E's `exports/` (its own patch series incl. `source-only/ARTIFACT-RECIPE.json`, and a bundle) | duplicates the Git objects; one patch embeds the 2026-10-21 rewritten literal | blob and sha256 in INVENTORY `exportsOmitted` |

**Gap carried forward (flagged, not altered):** frozen-0931 (f2db53ff) published E's `evidence/capture/*.json`, the public-chain
bytecode captures that E's own source-only export treats as non-source. They are unchanged here and not re-exported. Under the
append-only rule the prior entries were not modified. Root decides whether that matters.

**Manifest:** 3042 → **3427** (+385, 4,081,388 bytes); 0 changed, 0 removed.
- **Prescans:** gitleaks found no leaks over the export directory and the 31 staged frozen/evidence files.
- **Range scan** `f2db53ff..476c589b`: scan-crypto-keys 0 and gitleaks no leaks (4.33 MB).
- **Content check:** 387 committed files, with no binary, no private-key block, no rewritten literal, no file over 5 MB, and
  no node_modules, target or cargo-home directory.
- **Hooks:** pre-commit and pre-push passed.
- **Tracking:** 3427/3427 entries are tracked and match their committed blobs.
- **Post-push:** 31/31 frozen sources and root receipts are unmoved.

**Captured besides commits:**
- **M:** RESULT.md and RESULT.json, F-HANDOFF, PROGRESS, the commit message, the final patch, its job scripts, and a log digest.
- **Root notes:** ROOT-E-IMMUTABILITY-FINAL, ROOT-MAIN-ADVANCED, ROOT-MEMORY-ACCOUNTING-OWNER, ROOT-TLS-FINAL and
  ROOT-KERNEL-DELTA-REVIEW.
- **Root receipts:**
  - checkpoint-push-observed (root's independent f2db53ff verification at 11:19:29Z) and checkpoint-remote 10:35Z;
  - main-delta, nucbox-memory-accounting-review, nucbox-ram96;
  - public-rpc-allowlist-review, rpc-interface-review, transaction-evidence-mutation;
  - rpc-nucbox-target (09:45Z inventory) and the rpc-integration-review 0935 notes.
- **The 0931 receipt** and dated 11:22Z snapshots of ROOT-PENDING-LATEST and effective-goal-requirements.

**Not captured:**
- **Untracked or ignored files in every repo:** nucbox-ram96's `activation-readiness.*`, `before.json` and `*.log`;
  root-rpc-host-capacity's guard logs; rpc-storage-final-compose's `scratch/`.
- **Not in this batch's reviews:** `outputs/decentralization-audit/api-mcp-startup-relay-20261023T094137Z.json`, an
  operational probe.
- **ACTIVE work:**
  - P's new cache-composed-kernel-delta;
  - E's rpc-wallet-dependency (E's HEAD has moved past 9c5e0eef only in its new scope);
  - A, B, C, F, S and T;
  - F's windows-final-baseline-compose, including its ROOT-MEMORY-ACCOUNTING-FINAL.txt.
- **Notes not written by root.**

**Attempts (all logs retained):**
- **export-1:** E's two exports-only commits produced no derivative patch, so the commit/patch count assertion fired. Those
  commits are now recorded as `emptyAfterExclusion`.
- **export-2:** `git rm --cached` hit git's working-tree up-to-date safety check in E's live repo. It now uses `-f`, which
  only changes the throwaway index.
- **export-3:** passed export and verify. **export-4:** full export, prescans and verify, passed.
- **capture-1, commit, scan:** each passed after queue waits of 18, 40 and 26 not-started tries.
- **Scan note:** I tried to move the scan to the small lane, but it had already finished. `frozen-1118-checkpoint-scan.note`
  records that nothing was killed or rerun.

Nothing here claims deployment, activation or native verification. M is source accepted for F composition only. RAM 96 is
configured but not active (64 active), and NucBox restart still waits on the experiment. Root will verify the remote
independently.
