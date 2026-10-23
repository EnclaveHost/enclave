# HANDOFF: boot FEE activation kit (source only; pending H's commit and root's approval)

Recorded 2026-10-23T23:35:54Z (date -u). D ran no live operation: no SSH, RPC, keys, signer, chain write or production change.

**Tested source:** 32 files, digest 723cb4ab…08d35ae5 (the sha256 of `TESTED-SOURCE.sha256`). Re-recorded 2026-10-23T23:46:05Z.

**Run:** `logs/t6.out` (queue 512): `run-tests.sh` exit **0**. `t5` (same results) predates the evidence-wording correction.

| Check | Result |
|---|---|
| python | **49/49** |
| node | **16/16** |
| mutants | **89, survived 0**; the unmutated control passes |
| scans | gitleaks 0, scan-crypto-keys 0, literal 0 (77 files) |

**Not passes:** `t1` to `t4` and `n1` are intermediate runs.

**Evidence wording (ROOT-FEE-EVIDENCE-CORRECTION.txt).** The 13.2 Mwei is a reproducible SDK failure scenario, real viem with a
node that fills, and the SUSPECTED production cause. It is NOT a confirmed live fee: root's direct mainnet probe at 23:19:59Z fell
back to 7 Mwei. The fix and the exact-sender preflight do not depend on which path the live node takes. Root verifies with the
next normal sender's receipt.

**Correction:** the first commit 9bcbb881 also swept in root's `evidence/root-guestd-cutover.json`, which was not gitignored. The
commit was amended to remove it (the file stays on disk, untouched) and the dropped object was pruned. A second amend likewise removed
five of H's files (`H-ACTUAL-FAILURE.txt`, `H-actual-failure-*`, `H-lease-keeper-*`) that appeared here meanwhile. The tested list is
now the explicit 8bbd file list + `tests/fixtures/sender-explicit.js`. The repo was never pushed.

## Companion

`work/custody-boot-fee-release-20261023` (979a9efe) is the build template. It is byte-identical to a340762 (precheck e6f3cb97),
with a new README only. Tests 10/10, refusals 5/5.

## Pending (root / H)

1. **H's commit:** a sibling child of 9f6d37bd on `boot-normal-fee`, with the 7dd delta + the explicit-fee `sendOperatorTx`.
   It is not committed yet. Root reviews it and writes `work/custody-boot-fee-release-20261023/APPROVED-COMMIT.txt`, then runs
   the 1024 build.
2. **This kit's own source re-derivation** must accept it. That needs:
   - the pending-GPU markers;
   - the fee contract on `sendOperatorTx`;
   - the gsup REVIEWED line.

   `build-record.py --log <root's build log>` → `build.json` → root's `APPROVED-BUILD.txt`.
3. **A fresh funding run** before any cutover: `funding.py`. It runs the APPROVED sender through viem, read-only, on both RPCs.
   Both decisions must be setProofKey, the prepared fees must equal the sender's, and the 25% headroom must hold.
4. **The cutover** follows the 8bbd rules unchanged: > 1440 s on both leases, the fresh pre-gate read, `activate.py` in a
   surviving session.

**Limits:**
- The fixture sender in the tests is H's PROPOSED text, not a commit. The live run uses only the approved commit's
  hash-pinned sender.
- The node's real `eth_fillTransaction` behaviour is modelled in the inert test as root reported it (2 × base + tip); the live
  preflight uses the real RPC.
