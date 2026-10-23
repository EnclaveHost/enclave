# metal0 control: third image-only activation, for the boot GPU-price build (ROOT EXECUTES each phase after review)

This is source only, prepared 2026-10-23. **Nothing here ran against production, the relay, SSH or the chain.** It is adapted from
the frozen `work/custody-boot-activation-20261023` at 86c5fee, whose files are untouched. It changes **only config.json `dist`**:
deabf8f90 (ed918e4b) → the build of the commit root approved in `work/custody-boot-price-release-20261023`.

- **Source:** H 7dd3acd0, a single-parent child of 9f6d37bd.
- **Root's build:** PASS at 22:29:26Z, measurement **b007d471…**.

**Kept byte-identical to the reviewed attempts (pinned by tests):**
- the rewrite, protected fields, remote CAS/restore scripts, journal, `safe_rollback`;
- `preflight_problems` and `preflight.mjs`;
- `verify-operational.py` (gate v4, defaults unchanged), `guestrows.py`, `apphealth.py`;
- everything in `activate.py` after the write, except the additions listed below.

## Phases (run from `/home/steven/Documents/Codex/2026-10-18/wo`; stop and review after each)

| # | Command | Writes / impact |
|---|---|---|
| B | `python3 work/custody-boot-price-activation-20261023/build-record.py --log work/custody-boot-price-release-20261023/logs/root-build-price.out` | `build.json` (local). **Root reviews it, then writes `APPROVED-BUILD.txt` = `build-sha256 <sha>`.** |
| 0 | `python3 …/stage.py` | `~/enclave-prod/dist-leasegas-7dd3acd06` (copy, every hash), `plan.json` |
| 1 | `python3 …/prepare-admission.py` | read-only SSH read. The installed env must be `dd62be7c…` (37 entries, incl. ee5df6b8 + 08d1f838). Writes `admission.json` + `measurement.env` (37 → 38, additive). |
| 2 / 2b | `python3 …/admit.py`, then `recheck-admission.py` | **privileged** relay env CAS with a NEW backup `.before-7dd3acd06` (the `.before-a6b1378cd` and `.before-9f6d37bd8` backups are untouched) + relay restart |
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
