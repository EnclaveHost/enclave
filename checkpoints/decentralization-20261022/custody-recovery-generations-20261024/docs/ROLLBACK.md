# Current rollback note — October24 04:57 UTC

Metal0 is recovered on the original control; both original apps renewed normally. No candidate image cutover occurred in this recovery. The human-approved temporary delegation clear/fund/restore completed and restored the exact original executor. Do not repeat that maintenance or restart the exhausted emergency keeper.

Metal0's operator nomination is confirmed; administrator acceptance remains pending. Until accepted, the operator can cancel this exact pending proposal with `cancelProposal(hostId)`. Once accepted, there is no renounce: transfer requires another propose/accept pair. Do not reset the acceptance handoff journal merely because a wallet response was lost; reconcile its hash/nonce and chain state first.

The original book's sessionVaultFactory is now set. The restrictive factory rollback rule below remains essential: never unset it after a policy relies on beneficial ownership. The separate secretVaultV2 book entry is still zero; no rollback of that entry is needed.

For the future dedicated canary, the guarded stop preserves all other VMs and retains sealed state and logs. `launch-stopped` now checks actual absence and retained ciphertext metadata. It is not an explicit recovery launcher or successful unseal test. Never repurpose the fresh-launch command to overwrite a retained state/capture/log directory. Full production outage/recovery and rollback testing remain unfinished; same-epoch sealed-state rollback is still an acknowledged security limitation.

The dated tables below retain earlier source findings and incident history. Their old Metal0 registration/activation statuses are superseded by this note.

---

# Custody v2: rollback, cancel and protection limits (as of 2026-10-23T22:10Z; corrected 22:29Z per root's rollback review)

## 1. Operational rollback per action (nothing here was executed by this worker)

| action | how to reverse | what it does NOT reverse | source |
|---|---|---|---|
| `book.set("secretVaultV2", 0xE486…)` (admin) | Sign the recorded rollback calldata. Pages stop at the next action. | Stored policies and bundles stay. | dashboard HANDOFF §4 step 4 |
| `book.set("sessionVaultFactory", 0x1f5c…)` (admin) | **Unset it only while NO policy relies on the factory.** That means confirming, from a live inventory at the time, that no v2 policy's pinned owner is the beneficial EOA of a SessionVault-held deployment. **Once any SessionVault-held policy exists, do NOT unset:** keep the factory and fix the consumer instead. | `beneficialOwnerOf` reads the factory from the book on every call, while a policy's owner is pinned at its first write. Unsetting therefore makes the beneficial owner of those deployments the SessionVault again. `update` / `updateBySig` revert `NotOwner` ("the ledger moved the deployment"), and custodian release checks ownership too. The only contract route forward is `claimPolicy`, which **destroys the bundle**, so it is not a routine recovery. (Policies pinned to a SessionVault while the factory was unset are stranded by SETTING it; that is the activation risk, not this rollback.) | vault 9d43 `beneficialOwnerOf`, `_ownerFor`, `_apply`, `_claim`; dashboard HANDOFF §4 step 5 |
| metal0 owner enrollment (proposeOwner + acceptOwner) | **No renounce.** The only way out is a new propose/accept. | Consumers of the accepted owner (platform host gate, node holds). | custodian `RESULT-R2.md` §3 |
| new committee genesis | None on chain. Stop using the committee, and do not migrate policies to it. | The committee stays recorded. | vault source |
| `proposeCode` (corrected committee only) | `removeCode`, same approval weight, takes effect at once. It also blocks the final ack of a pending handover to that code. | The **same measurement cannot be re-proposed in that epoch** (single-use digest). | code-admission test 21/21 |
| pending handover | Expires after 86400 s; can then be replaced. | | vault source |
| owner switch to a new committee (re-entry or rewrap) | **Before the switch update:** nothing on chain changed, and the old policy, rules, bundle and committee keep working. **After it**, there is no undo: the vault stores ONE current bundle per deployment, and the switch replaced the `0x4774` bundle. Going back is a NEW owner `update` (`setPolicy` committee `0x4774` plus `setBundle` with a FRESH bundle encrypted to `0x4774`'s key). That bundle comes from re-entry, or from a fresh owner-authorized rewrap in the reverse direction (not tested). It needs the original committee still serving. | Revisions only increase (policyRev and secretRev +1 at each step); the old ciphertext is not restorable as the current bundle; credentials rotated at their issuers stay rotated; values already released to guests stay released. Restoring files cannot undo any of these. | vault 9d43 `_apply` (committee change needs a fresh bundle or a clear; `_bundles[id]` holds the current revision only), rewrap.mjs header |
| relay copy delete | **None.** Re-enter the value. The owner must rotate it at its issuer. | Relay backups and snapshots (deleting removes `secrets.json` only). | rollout audit F6, S7 |
| site release delivery (fronts) | Record and verify the EXACT pre-cutover state at deployment time: the front release (`/.well-known/enclave-site-release.json`, or the served `index.html` hash), the public IPNS sequence and CID. Then roll back ONLY to that validated previous artifact: `site/deploy.sh rollback --to <that CID>`, and probe its own stamp. No blind old-CID rollback. The CID and stamp in the r2 handoff were correct at the 2026-10-23 20:20Z public read only. | IPNS: never reset the sequence and never republish a lower-sequence record. If IPNS must roll back, publish a NEW signed record with a HIGHER sequence pointing to the previous CID. r2 is not published today, so nothing needs rolling back now. | r2 RELEASE-HANDOFF §5, §7; ipns-publisher assessment |
| metal0 control image activation (root) | Automatic rollback to the previous config. | **Observed 21:37Z (PROVISIONAL): the rollback restored the old image, not boot registration or adoption.** At 22:14Z the control was still on the old `ed918e4b` image and unregistered. `08d1` is admitted but not activated, because the cutover was stopped before mutation. At 22:50 `b007d471` was admitted (allowlist 38) but NOT activated. At 22:52 root confirmed the old control re-attached, with no restart. **23:10 activation of `b007d471` → adoption failed → automatic rollback at 23:15:29 to `deabf8f90` / `ed918e4b`.** The rollback again restored the old image, not registration or adoption. The original guests and app health were unaffected (23:16:22 read). **23:36:51 `5db2be3f` attempt: registered (setProofKey tx `0x12d7a5a4…`) and adopted the same VMs, then the gate FAILED → automatic rollback 23:43:19**, unregistered again. A successful `setProofKey` is not undone by the rollback: the registry now holds the new proof key `0x0e44…C8B3`. The original VMs were running at 23:44:30 and healthy at 23:47:01. | root journal L498, L521; root 22:56Z (S22); D kit `result.json` and `evidence/postrollback-health.json` (S23, S24) |

## 2. Rollback and replay protection of the custodian: limits

| threat | running image (`c866`, 9d43) | corrected r2 (`70aadff5`, ab589bf8) |
|---|---|---|
| host serves an older epoch's blob | refused (an epoch older than the chain's) | refused |
| host serves an older VALID blob of the current epoch | **not detected**: it unseals and rolls state back | **not detected**: no hardware monotonic counter; the sealed checkpoint can be rolled back from the 20-blob host history |
| per-deployment high-water marks | **memory-only**: they restart from the next read after a restart | memory-only by default (`custodian.mjs` L47) |
| host answers 503, an error, a redirect, an oversize or tiny body, or stalls | treated as absent: it **creates and PUTs a fresh identity** (defect) | startup fails and the supervisor retries; proven on hardware for 503 (7/7, 20:14Z) |
| host answers **404** for existing state | fresh identity; old share orphaned | **the same: not preventable without an external monotonic anchor** |
| host lies about a write, or denies service | not detected | not detected (liveness only) |

Sources: original daemon 9d43e63e8 `custody/v2/daemon.mjs` L78, L86-91 (any GET failure → `null` → fresh identity PUT); rollout audit `RESULT.md` L171-175, L274-282, L352-355; durability `RESULT.md` L133-138; custodian `RESULT-R2.md`
L21, L199-204; harness `README.md` L172-176.
