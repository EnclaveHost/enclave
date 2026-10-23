# Review: work/custody-boot-activation-20261023 + H 9f6d37bd (ROOT-REVIEW-RECOVERY.txt)

This was a read-only source review on 2026-10-23, from about 22:00Z to 22:15Z. I made **no edits to H's files**, and ran no
SSH, live network, chain or key operations. H's folder kept changing during the review: `common.py`, `keep.py`, `mutants.py`
and `boot-funding.mjs` changed after my first read, and root's notes now stand beside them.

## 1. CRITICAL: the boot GPU-price race defeats the setProofKey path (root has stopped the cutover)

1. gsup at 9f6d37bd (`metal/guest/gsup.mjs:476`) gives the supervisor `GPU_COUNT: '0'`. So `IS_GPU` starts false, and
   `supervisor.js:3055` sets `SELL_GPU_PRICE6 = 0`.
2. The shielded card is adopted late (see the comment at :3030). The price only becomes the card's `pricePerSec6` (1667) at
   :5858/5859.
3. `advertise()` runs at module end (:12443), and `registerOnChain` (:614-643) does not wait for discovery. The supervisor's own
   comment at :5860 says "Discovery can finish after registration".
4. With row gpu 1667 and desired gpu 0, `bootRegistrationAction` returns "the registered fields differ" → a **full
   register(gpu=0)**:
   - root's estimate for it is about 354e9 worst case, against a 376.1e9 balance;
   - after discovery, a setPrices follows that the balance cannot fund;
   - the on-chain GPU ask stays 0 meanwhile.
5. The boot-funding preflight pins desired gpu 1667, so it cannot see this. H's tests model `IS_GPU=false` with
   `SELL_GPU_PRICE6=2`, and never a pre-discovery 0.

It is a race: a first attempt that backs off past discovery would take the setProofKey path. So the outcome is not guaranteed
either way. Root has stopped the cutover; the fix belongs in a new commit on 9f6d37bd (root will hand it out).

## 2. Funding feasibility and the default sender: sound

- **Sender:** the boot sends via the existing `sendOperatorTx`, which is plain viem `writeContract` at default fees. A failed
  setProofKey is never escalated to register().
- **Root's live numbers** (`custody-boot-registration-20261023/logs/root-live-fees2.out`, block 53001451):

  | Quantity | Value |
  |---|---|
  | gas | 38 772 |
  | maxFee | 7 000 000 wei (5 m base × 1.2 + 1 m tip) |
  | worst case | 271.93e9 |
  | 125% gate | 339.9e9 ≤ balance 376.13e9 |

  The gate passes today. It refuses (fail-safe) once base fee exceeds about 5.6 Mwei, or the tip rises.
- `viemDefaultMaxFee` rounds up, where viem floors. That is conservative, by at most 1 wei/gas.
- **This attempt is one-shot.** Once a setProofKey lands, about 233e9 is spent (gas used × effective price). About 143e9 remains,
  which is less than another worst case, so a rollback plus retry needs funding. A lagging re-read that sends setProofKey again
  is refused by the node for funds before anything is spent. The box then adopts on the next exact re-read, with backoff
  5→300 s.
- **Not visible to the preflight:** a registry read that fails at boot also takes the full-register path (supervisor.js:715).
- **Since my first read:** root's two-RPC block-equality failure (`ROOT-LIVE-REVIEW.txt`) is H's, and is being handled there
  (`block-probe.mjs`).

## 3. Baseline, record digests, gate, rollback, preservation: sound, with small notes

- **`prebaseline.collect`:**
  - It uses root's authenticated guestd listing (0600, ≤ 300 s) and keeps id, name, status, recordSha256 and createdAt only.
  - Each app must have exactly one nonterminal guest, running, with a record digest, equal to the ORIGINAL 21:31:30Z guests
    (gd9d4a391d, gdd0646f2c), with the same failed history.
  - `/availability` held is recorded as absent ("old control adopted nothing"), never pretended.
  - Any status other than `failed` counts as live, so an unexpected status refuses (fail-safe).
- **Record digests:** they are recorded pre-cutover (`preCutoverRecords`). After adoption only the guest **ids** are compared; the
  digests are not re-read. This is optional: re-reading them needs root's guestd listing again.
- **activate.py:**
  - `verify-operational.py`, `guestrows.py` and `apphealth.py` are **byte copies** of the reviewed files.
  - Unchanged: the dist-only rewrite, protected fields, the attach within 120 s, the same guests adopted within 300 s, gate v4 at
    its defaults, and the safe rollback.
- **Gaps in activate.py:**
  - It does not record the `[registry]` boot line (`adopted … tx=` vs `registered … (reason)`). Recording it would show which
    path the boot took, and the setProofKey tx, for root's audit.
  - The lease preflight age is checked at the start; prebaseline and the funding run (≤ 180 s) then spend margin before the
    write.
- **Preservation:** guestd, the guests, drop-ins, WorkingDirectory, leaseGas and the earlier admission backups are never
  written. Admission is additive (36 → 37).
- **Rollback:** it does not restore the registry registration (rollback.py says so).

## 4. keep.py attestation acceptance

- When I first read it, keep.py was **substring-only**. It is now strict: `common.attestation_verdict_problems`, 1800 s,
  measurement = approved, raw 0600 + hash. One residual: `failedChecks` absent counts as OK.
- **Independent cross-check in this repo:** `check-recovery-verdict.py`. It accepts only a `recovery-target.mjs attest` verdict
  with all of:
  - wrapper `recovery-target/1`, target `recovery`, `accepted`;
  - every required check PASS, `failedChecks == []`;
  - observed = expected = 08d1f838, and the test pins this to the wrapper's constant;
  - a 64-hex verifier nonce, VMPL 0;
  - a time after `result.json` attachedAt, parsed and not string-compared, and ≤ 900 s old;
  - the result itself provisional at 08d1f838;
  - its raw answer 0600, hashing to rawSha256.
- **Tests:** 7/7, plus the existing checker's 5/5 (`logs/recovery-verdict-tests-1.out`, 256 lane).
- **Usage:** `python3 work/custody-recipient-activation-20261023/check-recovery-verdict.py evidence/attestation-<UTC>.json`.
  Then pass keep.py the same file.
