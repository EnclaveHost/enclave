# Checkpoint publication, batch "1639": A credit-vault submitter, E generated-artifact reconcile, root RAM / RPC review / API-MCP

"1639" is this batch's identifier: its actual start, 2026-10-23T16:39:13Z (`date -u`). Every time below is measured. These are
source and test CANDIDATES, not production completion. The coupled CPU/RAM resource-share fix is ACTIVE WIP and is NOT in this
batch; root has queued its frozen source a5e155ec and CPU canary c516049c for the next batch.

**Pushed:** `checkpoint/decentralization-20261022` b995a73b → **`1219a9882904b73349aee9582a9e35b355c03e26`**, tree
**`714664aaa77d8a3204c486587f939697d2ff08e2`**.
- **Commit:** made at 17:19:57Z (git 10:19:57-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran.
- **Push:** a normal fast-forward at 17:20:38Z. An independent `ls-remote` at 17:20:54Z reads checkpoint 1219a988 and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no force push, rewrite, SSH, production, wallet, signing or contract action, and no edit in any worker tree.
- **Queue:** all jobs ran through the existing queue. The first export used 512 (31 not-started tries while other workers held
  the large lane); everything after used the 256 lane (peaks 41–167 MiB). Nothing about the queue was changed, and no job was
  stopped.

**Frozen input list** (resolved once at 16:39–16:41Z from root's journal and your message; not grown afterwards):

| Side | Base (in pushed b995a73b) → head | Head tree | Reproduces |
|---|---|---|---|
| e-gen | ae00cd96 (frozen-1517 e-prod) → **ff13ebe0** | 1cece8e6 (= root's) | exact |
| root-ram96c | 2ed6ba61 (frozen-1339) → 6b756f84, e650fc09 → **3d42d7eb** | 3c4698b4 | exact |
| root-rpc-review | root → 1d4920ca → **803c6975** | 5e995556 | exact |
| root-api-mcp2 | 95ee73dc (frozen-1517) → **844edbf2** | de56753a | exact |
| a-cv | eab4cfac (frozen-1517 a-receipts derivative) → 2 commits → **fd8d5806** (orig d8e0ab06 = root's) | eef1d2f3 | derivative |
| e-gen-report | root → **d37f7a04** (root-accepted; orig 4fe6a9cb) | 06cc5988 | derivative (`exports/`) |

- **Reproduction:** `frozen-1639-export/REPRODUCE-CHECK.txt`. All 6 sides are true, from b995a73b's stored patches.
- **Stability:** the final INVENTORY `d06aab66` was byte-identical across two exports, in both the export-3 and capture jobs.

**Omitted, with restore recipes:**
- **A's compiled MCP guest bundle and its manifest.** They stay held at e32dd607, as in frozen-1517, and A's range does not
  touch them (identical blobs asserted). The 1517-validated rebuild (`--check` rc 0) applies, so no new rebuild was run; only
  new artifact provenance would have warranted one.
- **A's role manifest `credit-vault-submitter.package.json` (fa7403b5).** Its npm-name and sha256 pairs trip BOTH unchanged
  scanners (export-2). It is published converted, as `sha256  path` text plus meta, with the exact rebuild of the committed
  bytes asserted. The committed role bundle (4c25cde6) is exported as text. D did not re-run the package build; root read A's
  t1 at 50/50.
- **E's report `exports/`** (a git bundle and a duplicate patch), and E's report commit after d37f7a04 (59ec6b4, a scan receipt
  root has not accepted). Both are recorded.
- **Untracked files in every repo:** node_modules, foundry out, the relay runtime bundle, RAM activation logs and readiness
  files, E's gen-tree and verify-tree.

**Manifest:** 4439 → **4551** (+112, 4,778,267 bytes); 0 changed, 0 removed.
- **Prescans** (export-3): gitleaks found no leaks over the export directory or the 12 staged frozen/evidence files, and
  `scan-crypto-keys --files` gave 0.
- **Range scan** `b995a73b..1219a988`: scan-crypto-keys 0 and gitleaks no leaks.
- **Content check:** 114 committed files, with no binary, no private-key block, no rewritten literal, no file over 5 MB, and no
  module, target or bundle file.
- **Tracking:** 4551/4551 entries are tracked and match their committed blobs.
- **Post-push:** 12/12 frozen inputs are unmoved, and every input head is at its frozen commit. E's report repo has the later,
  uncaptured 59ec6b4; d37f7a04 is its ancestor.

**Captured besides commits:**
- A's RESULT, HANDOFF and job scripts;
- root receipts `checkpoint-4aaba75-verified`, `nucbox-96gb-active` and `rpc-integration-review`;
- the 1517 receipt;
- snapshots (16:41Z) of root's journal and effective-goal-requirements. These record, as dated coordination evidence, the human
  96 GiB restart authorization, the activation, and the priority order: the resource-share fix, then Custody v2 production SNP
  verification and rollout, with single-seat bootstrap NOT to be labelled decentralized custody.

**Not captured (active, or designated for the next batch):**
- work/coupled-resource-shares and coupled-cpu-enforcement (WIP; root's frozen a5e155ec and c516049c are queued for next);
- baseline 0f1ef848b (a provenance aid only);
- M sealed-startup 8a0a500c and T HDD client recovery (root: next batch);
- A host-role-verifier-cold-closure, E bootstrap-replica publication, and every other active tree;
- nucbox-tls-* operational receipts that were not designated.

**Attempts (all logs retained):**
- **export-1** (export + verify only): passed.
- **export-2** (rc 123): `scan-crypto-keys --files` found 3 eth-key hits and gitleaks found 4, all in A's role-package manifest
  (name/hash pairs). The report is kept as `frozen-1639-prescan-gitleaks.export-2.json`. The fix was to omit the manifest and
  publish it converted; no scanner was changed.
- **export-3, capture-1, commit, scan, push:** each passed first time. The key-scanner prescan added after frozen-1517 caught
  this before any commit was attempted.

**Limitations (root):**
- A: mainnet readiness is not established, and all minted receipts use labelled local fixtures.
- E: generated artifacts differ in metadata only; nothing is deployed.
- Root's RAM records are its own operation, kept as evidence.
- The RPC review records open S receipt-method and P false-zero acceptance gaps.

Root will verify the remote independently.
