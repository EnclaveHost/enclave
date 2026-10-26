# base-finality-proof-stage/r2: fixture fix only (PREPARED; NOT run)

**Root run.** `logs/root-finality-prototype-0211.*` and the run directory `../logs/root-finality-tests-20261026T020942Z-557130` are preserved and untouched:
- JS 20/20 passed;
- Python 26/27 failed `test_replayed_or_not_newer_receipt_refuses`, which expected `not_newer` but got `replayed`.

**Cause.** `make_a1` wrote a byte-identical `run-result.json` for every fixture run, because the times and fields were the same. So the `older` fixture's run sha equalled the first run's, and the product's replay check fired first. **The product behaviour is correct.**

**Fix (test only).**
- Each `make_a1` call gets its own valid run identity: `startedAt = at - (60 + seq)` s, still inside the run window.
- The `not_newer` branch is now reached by a distinct run, and replay detection is unchanged.
- The runner points at `r2`.

**Files.**
- Byte-identical to the frozen stage: `src/`, `vendor/`, `a1gate/`, the JS tests and helper, `README.md` and the integration patch.
- Changed: `tests/test_finality_state.py` (+1 line, 1 changed line, docstring path) and `jobs/root-finality-tests.sh` (paths only).
- `SHA256SUMS` pins r2.

**Flags.** `FINALITY_PROTOTYPE_REVIEWED` stays False. The prototype still qualifies only the same running process; it is not restart qualification (see `../restart-review/DESIGN.md`).

**Root command.**
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r2
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-finality-tests.guard -- unshare -rn bash $ST/jobs/root-finality-tests.sh > $ST/logs/root-finality-tests.out 2>&1; echo $? > $ST/logs/root-finality-tests.rc
```
A pass needs exactly JS 20/20 and Python `Ran 27 tests` + `OK`, with no skips.
