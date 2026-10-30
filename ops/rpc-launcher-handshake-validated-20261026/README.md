# Base launcher one-shot handshake r3: source tests + sandbox guest canary PASSED (2026-10-26)

## Scope (read first)
This is **NOT** any of the following:
- a full launch-producer qualification;
- a live activation;
- a restart or finality proof.

It publishes source plus two actual root runs:
1. **Local offline unit, crash and concurrency tests**, using fake system/RPC boundaries and a fake executor.
2. **A bounded privileged sandbox canary in the guest.** It used a scratch directory and never touched the real bootstrap
   directory, the DB or any unit.

**Base was never started.** Nothing here was installed, and no unit changed.

**The HOLD flags are still False in this source:**
- `LAUNCH_PRODUCER_REVIEWED = False` (wrapper);
- `FINALITY_PROOF_REVIEWED = False` (producer).

**Still open:** H-F1 (the restart finality proof), the final download, a fresh A1 original-game recheck, A2–A4 and the real
bytecode scan on the real DB, coverage requalification, and blobs/readiness.

## Contents
| path | what |
|---|---|
| `r3-stage/` | The exact r3 stage `base-launch-producer-stage/r3` (`MANIFEST.sha256` `a41d2182b0a1d48e6610629e832b4cc717c00f1f5bae4d3dd7800af42aa67084`). Verify with `cd r3-stage && sha256sum -c MANIFEST.sha256`. The root test run's `__pycache__` was excluded. |
| `actual/local-tests/` | `root-launch-handshake-r3-0202.{out,rc,guard}` and the complete suite outputs `root-r3-tests-20261026T020024Z/*.out`. |
| `actual/guest-canary/` | `root-launcher-guest-canary-0204.{out,rc,guard}` and `launcher-guest-canary-0204/{canary.out,canary.rc,services-after.out}`. |
| `inputs/launcher-service-audit-0143/base-unit.out` | Root's capture of the live base unit, which the drop-in proposal was checked against. |
| `SHA256SUMS` | Every file above. |

## Source in r3-stage
- **Wrapper** `wrapper/chain_service.py` `07276ec8…`. Release mode only, it does the following:
  1. requires a root start plus the drop-in marker;
  2. takes a non-blocking `flock` on a root-owned lock before the first gate;
  3. runs every existing gate unchanged;
  4. verifies the immutable launch record, pinned in chain.json `anchorLaunch {launchSha256}`;
  5. verifies the root-owned, hash-chained journal (the state must be pending and `now ≤ notAfter`);
  6. checks `LAUNCH_PRODUCER_REVIEWED`;
  7. durably appends `consumed` (fsynced partial, then link, then a directory fsync);
  8. drops to rpcbase with initgroups and setresgid/setresuid, verifying that `setuid(0)` fails;
  9. `execve`s in the same process.

  Legacy `bin/base` mode is unchanged.
- **Producer** `producer/base_launch.py` `7e8d295d…`. It provides `produce` (r1 logic), `arm`, `rearm` (both require the
  stopped DB to be unchanged at N, via the harness's own gates), `rollback` (terminal) and `record-bootstrapped` (HOLD). All
  of these use the wrapper's journal functions under the same lock.
- **Tests** `tests/test_r3_launcher.py` `ceae5e2c…`: 27 tests.
- **Job** `jobs/root-r3-tests.sh` `e6013fe1…`.
- **Canary script** `jobs/guest-handshake-canary.sh` `2dfabd78…`.
- **Drop-in proposal** `systemd/60-base-launch-handshake.conf` `47b9c6e9…`. Not installed.
- **Pins and patches:** `inputs/consumed-inputs.sha256` pins the r3 inputs by their absolute paths in the original working
  tree. `tests-r2-to-r3.patch` and `dropin-r2-to-r3.patch` are the diffs from r2.

## Actual results
- **Local tests** (`root-launch-handshake-r3-0202`): rc `0`, queue `EXIT 0`, memory guard `exit=0`.
  - `PASS baseline-existing Ran 34 (expected 34)`;
  - `PASS r3-existing Ran 34 (expected 34)`;
  - `PASS r3-launcher Ran 27 (expected 27)`;
  - `aggregate rc=0`.

  That is 95 tests, with no skips. Each suite output ends in `OK`.
- **Guest canary** (`root-launcher-guest-canary-0204`): rc `0`, `canary.rc` `0`, and `"ok": true` with `"mismatch": {}`.
  - The legacy `User=rpcbase` reference and the drop-in run both show resuid `[994,994,994]`, resgid `[985,985,985]` and
    groups `[985]`.
  - The drop-in run shows: journal `["armed"]` (the real `launch_lock` and `journal_append`); `etcReadOnly` and
    `launchDirReadOnly` true; `dataReadable` true; `capEff` and `capPrm` `0000000000000000`; `noNewPrivs` `1`;
    `setuid0` `EPERM`.
  - `services-after.out` shows `enclave-base-holder.service` `inactive` with MainPID 0 and NRestarts 0. The L1 EL and CL
    are `active` with NRestarts 0, and the snapshot download is still `activating` at archives 115/116.

## Provenance and limits
- **History:** r2's actual failing run (12 errors in A1 fixture setup) is preserved, already published, at
  `ops/rpc-integration-progress-20261026/launcher-r2/`. r3 changed only the tests (the fixture's consistent recheck-mode A1
  test pin, reset per test), the job, and the drop-in file name. The wrapper and producer bytes equal r2's.
- **Canary script bytes:** the canary output records results, not the script's hash. That the canary bytes run are
  `2dfabd78…` (which pins wrapper `07276ec8…`) rests on root's run record, not on these outputs.
- **What the tests mock:** the in-path privilege drop is mocked in the local tests. The real drop is shown only by the
  sandbox canary, which used a `systemd-run` with the unit's sandbox properties, not the unit itself.
- **Residual risks:**
  - root-level journal truncation, or restoring it from a backup, is undetectable;
  - the root launcher reads rpcbase-controlled data with `CAP_DAC_READ_SEARCH`;
  - after one anchored launch, every restart refuses until H-F1 exists.
