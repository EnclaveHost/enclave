# Custody v2: rollback, cancel and protection limits (as of 2026-10-23T22:10Z)

## 1. Operational rollback per action (nothing here was executed by this worker)

| action | how to reverse | what it does NOT reverse | source |
|---|---|---|---|
| `book.set("secretVaultV2", 0xE486…)` (admin) | Sign the recorded rollback calldata. Pages stop at the next action. | Stored policies and bundles stay. | dashboard HANDOFF §4 step 4 |
| `book.set("sessionVaultFactory", 0x1f5c…)` (admin) | Set it back to 0. | A policy already pinned to a SessionVault is stranded once the factory exists, and only `claimPolicy` gets past that, which destroys the bundle. | dashboard HANDOFF §4 step 5; factory-consumer review |
| metal0 owner enrollment (proposeOwner + acceptOwner) | **No renounce.** The only way out is a new propose/accept. | Consumers of the accepted owner (platform host gate, node holds). | custodian `RESULT-R2.md` §3 |
| new committee genesis | None on chain. Stop using the committee, and do not migrate policies to it. | The committee stays recorded. | vault source |
| `proposeCode` (corrected committee only) | `removeCode`, same approval weight, takes effect at once. It also blocks the final ack of a pending handover to that code. | The **same measurement cannot be re-proposed in that epoch** (single-use digest). | code-admission test 21/21 |
| pending handover | Expires after 86400 s; can then be replaced. | | vault source |
| owner switch to a new committee (re-entry or rewrap) | The owner sends a new `update` back. The old bundle on `0x4774` stays usable until replaced. | Values already released to guests. | rewrap.mjs header |
| relay copy delete | **None.** Re-enter the value. The owner must rotate it at its issuer. | Relay backups and snapshots (deleting removes `secrets.json` only). | rollout audit F6, S7 |
| site r2 delivery (fronts) | `site/deploy.sh rollback … --to bafybeig3rai3…`, then probe for the base stamp `166bf9d3 · 2026-10-19`. | IPNS (untouched). | r2 RELEASE-HANDOFF §5, §7 |
| metal0 control image activation (root) | Automatic rollback to the previous config. | **Observed 21:37Z (PROVISIONAL): the rollback restored the old image, not boot registration or adoption.** At 22:14Z the control was still on the old `ed918e4b` image and unregistered. `08d1` is admitted but not activated, because the cutover was stopped before mutation. | root journal L498, L521 |

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
