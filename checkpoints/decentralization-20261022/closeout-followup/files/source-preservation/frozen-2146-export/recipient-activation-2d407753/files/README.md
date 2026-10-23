# metal0 control: image-only activation of the restored custody vaults (ROOT EXECUTES each phase after review)

Prepared 2026-10-23 (source only; nothing here was run against production, the relay, SSH or the chain). It is adapted from the
reviewed Oct-21 `work/linux-post-adoption-release/activation/`, and changes **only config.json `dist`**:

| Field | Value |
|---|---|
| Image | `dist-leasegas-deabf8f90` (ed918e4b) → `dist-leasegas-a6b1378cd` (**ee5df6b8…bc22ec**) |
| Source | `work/custody-recipient-restore-20261023` commit a6b1378c (evidence b03be02d) |

**Preserved exactly:**
- every other byte of config.json, including `leaseGas` (digest 3570d2…);
- the two user drop-ins (80-shield-inference `9f3acb48…`, 95-app-funded-leases `71b3feb3…`): never written;
- WorkingDirectory `metal-deabf8f90` (the launcher files are byte-identical) and KillMode control-group;
- lease-gas journals; guestd; and the app guests: gd9d4a391d (image-generator), gdd0646f2c (EyesOff) per root's 21:13Z baseline.

**Root's files, kept untouched:** `baseline.py`, `baseline.out`, `baseline.guard.log`, `evidence/baseline.json`.

**`verify-operational.py`, `guestrows.py` and `apphealth.py` are BYTE COPIES of the reviewed Oct-21 files** (`REVIEWED-COPIES.json`).
Health, adoption, vouch and authority are not relaxed.

## Phases (run from `/home/steven/Documents/Codex/2026-10-18/wo`; stop and review after each)

| # | Command | Writes | Privilege / impact |
|---|---|---|---|
| 0 | `python3 work/custody-recipient-activation-20261023/stage.py` | `~/enclave-prod/dist-leasegas-a6b1378cd` (via `.staging`, every file hash = INVENTORY), `plan.json` | local copy only |
| 1 | `python3 …/prepare-admission.py` | `admission.json`, `measurement.env` | **read-only** SSH read of the relay env sha+body, drop-in sha, service state; public attestation |
| 2 | `python3 …/admit.py` | relay env (CAS + `.before-a6b1378cd` backup) | **privileged**; restarts `enclave-api-relay.service` |
| 2b | `python3 …/recheck-admission.py` | `admission.json` stage | public read |
| 3 | `node …/preflight.mjs` (< 6 min before 4) | `evidence/lease-preflight.json` (+ timestamped copy) | public chain reads |
| 3b | `python3 work/custody-recipient-activation-20261023/baseline.py` (root's own, again just before 4) | `evidence/baseline.json` | read-only |
| 4 | `python3 …/activate.py` | config.json `dist` (fresh `private-backup/`), `result.json`, `gate.json`, `apps-health.json` | restarts `enclave-metal.service` (the control VM only) |
| 5 | `python3 …/renewal-watch.py` (any time), then `python3 …/keep.py --checked-attestation <root evidence> [--audit … --verified id=tx …]` | `result.json` | read-only on the host |
| R | `python3 …/rollback.py` | config.json back (CAS) | restarts the control |
| R2 | `python3 …/unadmit.py` (only while ed918e4b is attached) | relay env back (CAS on both versions) | **privileged**; relay restart |

## Details root asked for

**Admission (phases 1–2):**
- **Additive.** All **35** currently admitted measurements are kept in their installed order, and ee5df6b8 is appended.
- **What phase 1 checks.** The installed env must be exactly the deabf8f90 admission (`f33a6c91…`, one
  `METAL_ALLOWED_MEASUREMENTS=` line). Its set must equal the PUBLIC allowlist, ed918e4b must be in it and the candidate must not.
  The drop-in must be `21fadc72…`.
- **What `admit.py` does.**
  1. Compare-and-swap against the sha phase 1 read.
  2. Write a fresh backup, refusing if one exists.
  3. Replace the file atomically.
  4. Restart `enclave-api-relay.service`, and check it is active.
  5. **On any failure, put the old bytes back and restart again** (tested).
- **No signature is needed.**
- **Transient impact of the privileged relay restart (admit and unadmit):**
  - every open api.enclave.host request and fleet tunnel drops for the restart, about seconds: metal0's control, custody-metal0,
    other boxes;
  - tunnels reconnect by themselves;
  - metal0 reattaches at ed918e4b, which is still admitted (2b verifies this).
  - Choose a quiet moment. Nothing else on the relay changes.

**Preflight (phase 3):**
- It uses the reviewed `live-preflight.mjs` logic, with the explicit two app ids.
- Lease modules come from the restore repo and are asserted byte-equal to production's `metal-deabf8f90`. The old preflight
  imported `work/enclave`, whose `lease-gas-owner.mjs` and `lease-executor-client.mjs` differ.
- It writes a NEW file; `outputs/…/linux-conduit-funding-preflight.json` is not touched.
- `activate.py` requires it to be under 360 s old, both apps active, the lease margin to exceed adoption (300 s) plus a controlled
  rollback (480 s), reserves enabled and non-empty, one active runner.

**`activate.py`:**
- **Read-only checks first, then one write:**
  - the protected fields equal the known metadata above (config sha 58aa9653…; no private backup is read);
  - a fresh actual-health and `/availability` baseline must equal root's `evidence/baseline.json` (same guests, same history, same
    image-generator title). Otherwise it refuses, and root reruns `baseline.py` and reviews.
  - Then the single textual `dist` replacement: it refuses if the value is ambiguous, and asserts the parsed JSON differs only in
    `dist`, with key order kept.
- **Then:**
  1. Restart.
  2. Attach ee5df6b8 within 120 s.
  3. Both apps adopted with the SAME guests within 300 s.
  4. The reviewed gate v4, at its unchanged defaults:
     - ≤ 300 s warm-up, then 420 s continuous actual health;
     - the baseline guests running and owned, with no replacement or second guest;
     - ≥ 3 vouch observations, never stale over 180 s;
     - the journal fails closed; any death, reap, release or respawn line is a hard fail.
- **No extra paid-renewal wait.** The lease code is byte-identical. Renewals seen so far are recorded; `renewal-watch.py` keeps
  recording them for root's audit.
- **Ends PROVISIONAL.**

**Effect on guests and protections:**
- guestd and the app guests are separate host services and are never touched.
- During the restart (about 1–2 min plus attach) there are no new claims and no control API. App data keeps flowing through guestd.
- The new supervisor adopts each running guest by record digest; the records are unchanged.
- Platform host policy, admission bundle, isolation min-TCB, egress and lease-gas: unchanged, because the image delta is gsup only.

**`keep.py`:**
- It requires root's own fresh-attestation evidence file (it must name ee5df6b8).
- It re-asserts, read-only: attached at ee5df6b8, both apps healthy, the same live guests.
- Renewal proof: recorded if root passes `--audit` and `--verified`, and only for renewals `renewal-watch.py` saw. Otherwise the
  keep records "app-paid renewals pending root audit".

**Safe rollback (`activate.py` on any failure; `rollback.py`):**
1. Stop the new control FIRST.
2. Wait past every sponsored deadline it logged, on a block two public RPCs agree on. An unreadable journal means stop + 300 s
   ttl + 60 s.
3. Compare-and-swap: the config must still be what `activate.py` wrote, and the drop-ins must still be the baseline's.
4. Restore the exact old bytes and mode.
5. Start the previous control (ed918e4b is still admitted).

Guests, drop-ins and journals are untouched. All of this is tested with stubs.

## Retained limits

- No custody release or hardware canary is part of this. The fix only removes the supervisor's refusal.
- Still open, and not addressed by this:
  - the owner-gas blocker (INSUFFICIENT BALANCE; metal0's payout = Enclave, no rate-0 for 0x29479…);
  - the r2 two-guest need;
  - the unset address-book `secretVaultV2`.
- guestd's binary-to-source link (9d1562738cde ↔ 174edbb7) is still not rebuild-proven.
- `metal-measured-control` test 4 fails identically before and after the restore. It is pre-existing and not called green.
