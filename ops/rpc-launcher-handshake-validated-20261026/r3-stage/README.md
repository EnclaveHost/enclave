# base-launch-producer-stage/r3: one-shot launch handshake, corrected TEST suite (PREPARED; NOT run; source-only)

r2 is preserved unchanged: sources, `MANIFEST.sha256` `5275dfe6…`, and root's log `r2/logs/root-r2-tests-20261026T014740Z`.
r1 and the wrapper-integration stage are also unchanged. `LAUNCH_PRODUCER_REVIEWED` and `FINALITY_PROOF_REVIEWED` stay
**False**.

## What changed from r2
- **Wrapper and producer: no change.** `wrapper/chain_service.py` `07276ec8…` and `producer/base_launch.py` `7e8d295d…` are
  byte-identical copies of r2. No production check is altered.
- **Tests: replaced** by `tests/test_r3_launcher.py` (27 tests; `tests-r2-to-r3.patch`).
  - **Root cause of r2's 12 errors** (run root-launch-handshake-r2-0148): the fixture's default A1 mode, `fresh-initial`,
    records the sha of a synthetic receipt. That can never equal the production `A1_INITIAL_SHA256` `b9a90847…`, so
    `produce` correctly refused with `a1`.
  - **Fix:** r3 uses the fixture's own `original-game-recheck` mode (`TA.Recheck.use_recheck`). The fixture sets its
    consistent test pin in `A.A1_INITIAL_SHA256`, and `TA.Case.setUp` plus this suite's `tearDown` reset it to production.
    Every test asserts the production pin at start. `test_the_production_a1_pin_refuses_the_fixture_receipt` proves the
    real pin still refuses.
- **Added production negative cases:**
  - `produce` (r1's never-run cases, ported, plus the A2/A4, A3 and harness-binary bindings);
  - `base_release` (every deviation);
  - launch-record bindings, through the real `run('base')`.
- **Test fixes:**
  - the vacuous mount assertion now uses the single boundary `mount` mock, which records the journal state at the first
    gate;
  - the 1.5 s concurrency sleep is replaced by a pipe barrier: the lock holder blocks inside its gates until the parent
    releases it.
- **Drop-in:** renamed to `systemd/60-base-launch-handshake.conf` so it sorts after the live `50-enclave-rpc-vm.conf`
  (`dropin-r2-to-r3.patch`). It was checked against root's capture `launcher-service-audit-0143/base-unit.out` `612fee0b…`.
  Its directives are unchanged.
- **Guest canary:** `jobs/guest-handshake-canary.sh` is a byte-identical copy of r2's (it pins the wrapper `07276ec8…`).
  It is still required for the real privilege drop.

## Root command (local, offline; exact counts 34 + 34 + 27)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r3
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-r3-tests.guard -- unshare -rn bash $S/jobs/root-r3-tests.sh
```
A pass needs all of: `PASS baseline-existing Ran 34`, `PASS r3-existing Ran 34`, `PASS r3-launcher Ran 27`, no skips,
`aggregate rc=0`. Anything else fails. Exit 98 from the queue means the job did not start.
