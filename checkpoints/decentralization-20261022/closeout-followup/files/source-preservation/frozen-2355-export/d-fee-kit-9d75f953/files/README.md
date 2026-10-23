# metal0 control: fourth image-only activation, for the boot FEE build (ROOT EXECUTES each phase after review)

This is source only, prepared 2026-10-23 (ROOT-FEE-RELEASE-PREP.txt). **Nothing here ran against production, the relay, SSH or the
chain.**

**Origin:** an isolated copy of the SOURCE of `work/custody-boot-price-activation-20261023` at 8bbd0a74. No runtime files, logs,
ROOT notes, H reviews or private files were copied. That kit's attempt rolled back at 23:15:30Z on "insufficient funds" for
setProofKey. **Suspected cause, not a confirmed live fee:** viem 2.53.1's plain `writeContract` can be re-priced through
`eth_fillTransaction` × 1.2, to about 13.2 Mwei instead of the modelled 7 Mwei
(`custody-boot-price-activation-20261023/FUNDING-MISMATCH-REVIEW.txt`). This is reproduced here with the real SDK.
- **Root's probe** (direct mainnet, 23:19:59Z, not the image's fallback pool): `eth_fillTransaction` failed, so viem fell back
  to 7 Mwei.
- **Status:** root will verify on the exact hardware with the next normal sender's receipt
  (`ROOT-FEE-EVIDENCE-CORRECTION.txt`). The fix and the exact-sender preflight stand either way: they do not depend on which
  path the live node takes.

**Kept exactly:** the 1440 s cutover bound, the fresh pre-gate lease read and block-age watchdog, gate v4 unchanged, the safe
rollback, the signals handling, the strict `attest-price.mjs` keep verdict, and the pending + discovered decision checks.

**Changed:**
- **Candidate:** H's new SIBLING child of 9f6d37bd (the reviewed 7dd delta + `sendOperatorTx` stating explicit fresh fees and
  gas), built in `work/custody-boot-fee-release-20261023`. Its `precheck.py` is byte-identical, so the pin holds. The commit is
  **not yet approved and not yet built**.
- **Admission:** 38 → 39, CAS from root's `136a6553…`. ed918e4b, ee5df6b8, 08d1f838 and b007d471 are retained. The new backup
  name is unique: `.before-<short>`, refusing `.before-a6b1378cd`, `.before-9f6d37bd8` and `.before-7dd3acd06`.
- **Fee contract:**
  - **Source:** `source_record` slices the approved commit's `sendOperatorTx` (sha256 → `build.json` `senderSha256`). It must, inside
    `_txChain.then(`, call `chainClient.estimateFeesPerGas()` and `chainClient.estimateContractGas(`, and state `gas`,
    `maxFeePerGas` and `maxPriorityFeePerGas` on its single `wallet.writeContract({...})`. 7dd's sender is refused (test).
  - **Funding:** `boot-funding.mjs` **runs that exact sender text** against the image's own viem 2.53.1 (H's `node_modules`),
    once per RPC, with a NO-SIGN account. The recording `writeContract` passes exactly what the sender gives it to viem's real
    `prepareTransactionRequest`. Every call is a read; nothing can be signed or sent.
  - **Gate:** the prepared gas and fees must EQUAL what the sender stated, on both RPCs. Otherwise the fill path re-priced them,
    and the gate refuses. The worst case is the larger per-RPC prepared `gas × maxFee + L1 upper bound + operator fee`, with
    the same 25% headroom.
  - **SDK failure-scenario test** (real viem, inert stub transport where the node fills 2 × base + tip): the 7dd sender comes out at 13.2 Mwei and is refused; the explicit
    sender (fixture = H's proposed text, `tests/fixtures/sender-explicit.js`, NOT a commit) keeps 7 Mwei and passes. Where
    `eth_fillTransaction` is unsupported, viem falls back to 7 Mwei, the only path the old kit modelled.
  - **Not used:** `fee-fit.mjs` stays from 8bbd for its arithmetic tests; the funding gate no longer uses its `viemDefaultMaxFee`.

## Phases (run from `/home/steven/Documents/Codex/2026-10-18/wo`; stop and review after each)

| # | Command | Writes / impact |
|---|---|---|
| B | `python3 work/custody-boot-fee-activation-20261023/build-record.py --log work/custody-boot-fee-release-20261023/logs/<root's build log>` | `build.json` (local). **Root reviews it, then writes `APPROVED-BUILD.txt` = `build-sha256 <sha>`.** |
| 0 | `python3 …/stage.py` | `~/enclave-prod/dist-leasegas-<short>` (copy, every hash), `plan.json` |
| 1 | `python3 …/prepare-admission.py` | read-only SSH read. The installed env must be `136a6553…` (38 entries, incl. ee5df6b8, 08d1f838, b007d471). Writes `admission.json` + `measurement.env` (38 → 39, additive). |
| 2 / 2b | `python3 …/admit.py`, then `recheck-admission.py` | **privileged** relay env CAS with a NEW backup `.before-<short>` (`.before-a6b1378cd`, `.before-9f6d37bd8` and `.before-7dd3acd06` untouched) + relay restart |
| 3 | `node …/preflight.mjs` (< 6 min before 4) and `python3 …/prebaseline.py --guestd-vms <root's private listing>` | read-only |
| 3c | `python3 …/funding.py` | read-only |
| 4 | `python3 …/activate.py --guestd-vms <listing ≤ 300 s old>` | config `dist` + restart of the control VM only |
| 5 | `node …/attest-price.mjs attest`, then `python3 …/keep.py --checked-attestation evidence/attestation-<UTC>.json --attestation-raw evidence/private/attestation-raw-<UTC>.json` | `result.json` |
| R / R2 | `rollback.py` / `unadmit.py` | as before |

## What is new, and why

**1. Source and build (`source_record`, `build_problems`).**
- **Source:** re-derived from git objects with the build folder's own `precheck.py`, hash-pinned at a340762, and root's 3-line
  `APPROVED-COMMIT.txt` there. The commit must also carry `SHIELDED_GPU_EXPECTED` in gsup and supervisor, and `gpuPricePending`.
- **Recorded:** the sha256 of `supervisor.js`, `gsup.mjs` and the sliced `bootRegistrationAction`.
- **Build:** every `build-price.sh` success line must appear exactly once, with no refusal line. These must all agree:
  - `stage/build-record.json`, `INVENTORY.sha256` and the `BUILD-RECORD` hash;
  - MEASUREMENT;
  - the kernel and cmdline, which must equal 08d1's;
  - the initramfs and manifest, which must not.
- **Checked offline against root's REAL 7dd3acd build: no problems.**

**2. Boot funding (`boot-funding.mjs`, `boot_funding_problems`).**
- The approved commit's decision function is used, with the file AND function hashes taken from `build.json`.
- It is evaluated twice: GPU price **pending (null)** and **discovered (1667)**. Both must be exactly `setProofKey`.
- The row must still be exactly endpoint / repo / measurement 0 / 834 / 1667.
- Unchanged: same sender, 25% headroom, two-RPC canonical block, nonce = pending, delegation pinned.
- 9f6d37bd's decision is refused: pending → register (test).

**3. Shielded expectation (`shielded_expectation_problems`).**
- The pinned launcher (`metal-deabf8f90/metal/enclave-metal.mjs`, :307) derives the two shielded workers 9501/9502 only when
  config.json `isolation.shieldedInference === true`, with valid pricing.
- Otherwise the new boot would not pend its GPU price, so activate refuses.

**4. Lease margin (ROOT-MARGIN-REVIEW, including root's 22:44 ruling and H-REVIEW).**
- **Last check before the write:** every lease, at the actual time, must have **more than 1440 s** left:
  - that is the 600 s watchdog floor + the 420 s stable gate window + attach 120 + adopt 300;
  - renewals land only in a lease's last 300 s, below the floor, so they can never help the gate;
  - the 900 s bound (attach + adopt + rollback 480) only protects the rollback;
  - warm-up is not pre-paid, so root waits for a paired renewal;
  - `result.json` records each app's actual seconds left (`cutoverLeaseSeconds`).
- **Immediately before launching the gate,** `lease_before_gate` takes a FRESH verified read with the existing read-only
  `preflight.mjs`. It retries only failed or stale reads, for at most 105 s. The read must have:
  - an agreed block -30..105 s old;
  - the cutover read's holder (runner, operator, host active);
  - every lease > 600 s from expiry.

  Otherwise the activation fails into the safe rollback. That read seeds the watchdog, with its own block age, never reset.
- **While gate v4 runs** (unchanged, a child in its own process group, stdout not piped), `gate_watchdog` reads again at most every
  60 s, each read capped at 45 s.
- **It stops ONLY its own gate,** whole process group, reaped, then the group SIGKILLed again. The activation then fails into the
  normal `safe_rollback` when any of these holds:
  - the last accepted read's agreed block is > 105 s old (absolute block age);
  - the holder changed;
  - any lease is ≤ 600 s from expiry.
- **Renewals:** only a later fresh verified read can move an expiry.
- **A stopped gate is never a PASS.** After a gate PASS, `lease_after_gate` needs a fresh read by the same holder with > 480 s
  left, retried within 105 s.
- **Signals:** SIGHUP/SIGTERM become the normal failure path (H-REVIEW finding 4), and are ignored once the rollback starts.
  Root still runs `activate.py` in a surviving session.

**5. Registry record.** The new boot's `[registry]` lines, its path (setProofKey + adopt / read-only adopt / full register()) and
its setProofKey tx are recorded in `result.json`, after the gate or after a rollback. This is for root's receipt audit, and is
never a pass/fail input.

**6. Attestation.**
- **`attest-price.mjs`:**
  - its measurement comes ONLY from `build.json` + `APPROVED-BUILD.txt`, never a constant;
  - every present image location is re-hashed: `~/enclave-prod/<name>` and the build stage;
  - the frozen `attest-control.mjs` (2d407753) and `verify-recipient-proofkey.mjs` (cb7fa858) are hash-pinned, and get one
    in-process target, `priceRecovery`.
- **`keep.py`** accepts only that wrapper's verdict, with all of:
  - target priceRecovery, `accepted`, `buildSha256` = the approved one;
  - `failedChecks` exactly `[]`;
  - pass, the approved measurement, nonce, VMPL 0;
  - after attach, ≤ 1800 s old;
  - its raw answer 0600 and hash-matched.
- **Legacy limit, unchanged:** the proof key is NOT SNP-bound (relay-routed); only the quote is.

## Retained limits

- A rollback does not restore the registry registration. After a landed setProofKey, about 143e9 wei remains, so the attempt is
  one-shot.
- Root times the cutover so that both leases have > 1440 s (24 min) left at the write: just after a PAIRED renewal. The watchdog
  fails closed rather than waiting for a renewal.
- A lease read slower than about 40 s, right after a 60 s poll, can push the last accepted block past 105 s and stop the gate.
  This fails closed, by design; staleness is not extended.
- H-REVIEW finding 5 (residual): the discovered GPU price under pool pricing. Root confirmed the live price 834/1667 at 22:46:12Z.
- Root re-reads the guest record digests after KEEP; activate compares guest IDs.
