# Image-only activation adaptation for the restored custody vaults: source + focused tests (2026-10-23)

ROOT-IMPLEMENT-ACTIVATION.txt.
- **Not done:** nothing executed against production, the relay, SSH, the chain or keys, and root's baseline was not rerun.
- **Preserved, untouched:** root's `baseline.py`, `baseline.out`, `baseline.guard.log` and `evidence/baseline.json`.
- **How:** all checks ran through the unchanged queue (256 lane).

- **Runbook:** `README.md`, phases 0–5, R and R2, with commands, writes, privilege and transient impact.
- **Shared logic:** `common.py`, holding the known current metadata and the candidate's exact hashes.
- **Phase scripts:** `stage.py`, `prepare-admission.py`, `admit.py`, `recheck-admission.py`, `unadmit.py`, `preflight.mjs`,
  `activate.py`, `renewal-watch.py`, `keep.py`, `rollback.py`.
- **Byte copies of the reviewed gate:** `verify-operational.py`, `guestrows.py`, `apphealth.py` (`REVIEWED-COPIES.json`).

## Tests

- **`logs/tests-2.out`:** `tests/test_activation.py`, **16/16**. Everything is stubbed: temp files, a stub `systemctl`, and stub ops
  for the rollback.
  - **dist-only rewrite:** byte preservation, and refusing a missing, duplicated or ambiguous value;
  - **protected fields:** leaseGas, WorkingDirectory, KillMode, unit state, a changed, added or missing drop-in;
  - **additive admission:** the 35 in installed order plus the candidate; seven refusals, each pinned to its reason;
  - **remote scripts:** the exact remote read, compare-and-swap and restore texts, run locally:
    - CAS success writes a 0600 backup and restarts;
    - a changed env, changed drop-in or existing backup is refused, with no restart;
    - a failed restart restores the old bytes and restarts again;
    - restore is compare-and-swap on both versions;
  - **safe rollback:** stops before any write; waits for the deadline block; an unreadable journal means stop + 360 s; refuses a
    concurrent config or drop-in change, and then never starts; restores the exact bytes and mode;
  - **preflight:** staleness, margin, reserve, host, runner and coverage refusals;
  - **baseline:** equality with root's actual 21:13Z record; a moved guest, a changed title or not-ready all refuse.
- **`logs/mutants-1.out`:** 11 mutants of the safety guards; **all 11 killed**.
  - They cover a config write before the stop, no deadline wait, no concurrent config check, no drop-in check, non-additive
    admission, ignoring the public list, re-serialising the config, ignoring WorkingDirectory, ignoring drop-ins, a compare-and-swap
    with no restore, and a zero lease margin.
- **`logs/tests-1.attempt-1.*`:** the first run, rc 1. It was a test-fixture bug: non-hex fake measurements. Kept as evidence.

## Not tested here

`activate.py`, `keep.py` and `preflight.mjs` were not run end to end: they act on production, the relay or the chain, so root runs
them. Their logic sits in tested `common.py` functions, and the gate is the reviewed byte copy.

**Limits:** see `README.md`, "Retained limits". The owner-gas blocker stands.
