# frozen-2329 export: how to rebuild

"2329" is this batch's identifier: its actual start, 2026-10-23T23:29:30Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing in this capture is signed, sent, activated or published by it. Root owns all activation and signing.

**State at the freeze:**
- Control recovery is NOT done. The 23:10 activation of `b007d471` failed, and the 23:15:29 rollback restored the unregistered
  old control.
- Health was last observed at 23:16:22: both original guests were running with passing health.
- The explicit-fee H build `5db2be3f` (running 23:28) and any new D build are NOT included.

**How each side was exported.** From Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context.

| Side | Base (pushed in ef1baaa1) | Head |
|---|---|---|
| custody-live8 | b4e1f14 (frozen-2246 custody-live7) | **851f7579** |
| current-docs3 | 1b3c2611 (frozen-2246 current-docs2) | ac48ded, 50f05862 → **967eeb96** |
| d-kit (derivative) | empty | **8bbd0a74** (original tree 9a5a3b2c; derived tree in INVENTORY) |

`verify-frozen-2329-export.py` rebuilds every base offline from the stored chains in ef1baaa1:
- custody-live: the 1852-2246 chains;
- current-docs: the 2217 and 2246 chains.

## d-kit: committed baseline omitted

Per root, `evidence/original-baseline-20261023T213130Z.json` (a read-only production unit and config baseline) is omitted. The
2217 batch omitted it the same way from boot-activation. Its blob and sha256 are in `omittedAtHead`.

## Root runtime receipts (rootEvidence)

Root explicitly allowed two of the kit's git-ignored runtime files, after reviewing that they hold only public ids, hashes and
status. They were read, scanned (gitleaks, crypto-key scanner, literal and PK-block guards) and stored as exact bytes:
- `result.json` (511808455bac7ef4…): the FAILED 23:10 run, with start, attach, registry lines, stop and rollback at 23:15:29, and
  boot funding;
- `evidence/postrollback-health.json` (5f131bf1687044bd…): the 23:16:22 read-only health.

Not read and not stored: `private-backup/`, raw attestation, `logs/root-*`, `ROOT-*` files, and the kit's other evidence, review and
progress files.

## Snapshots

Root's living public output `outputs/decentralization-audit/custody-v2-live-verification-20261023.md` is captured twice:
- as it was before the root-authorized correction of its top status (bytes of 22:55:43Z, 4d613dc8…);
- after that correction at 23:29Z (60408087…).

The correction states the failed 23:10 recovery and the 23:15 rollback. It gives health only as last observed at 23:16. The fee
cause is labelled NOT confirmed, and the `5db2be3f` build as not yet verified or activated. The stored bytes from earlier batches
(23c9aeba, and the 2025, 2100 and 2246 snapshots) are unchanged.
