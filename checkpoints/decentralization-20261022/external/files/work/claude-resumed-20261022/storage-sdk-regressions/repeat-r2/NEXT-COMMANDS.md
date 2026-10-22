# repeat-r2: next commands (root; NOT executed by its author)

Scope:
- Re-run ONLY the uncovered/failed indexd groups: `c2eidxu1`, `c2eidxfeed`, `feidxu1`.
- Not re-run: the 4 groups that passed (c2epos, fec2neg, c2efence, c2eblock: parser-r2 PASS on run
  20261022T074318-2c83b92890fa) and feindexd's 6 feed-mode passes. fefence is under its separate investigation.
- Same pins as the run you executed: image, harnesses cac66513 / 3c8374c4, driver d45df48e, snapshots, base runner ed8e0fdd.

    W=work/claude-resumed-20261022/storage-sdk-regressions/repeat-r2
    sha256sum -c $W/PINS.sha256
    python3 -B $W/diagnose_check.py                                    # offline: the 16 diagnosis checks, all OK
    python3 -B $W/runner_r2.py --config $W/config-r2.json --check      # already OK (logs/check-1.out)
    python3 work/claude-test-queue.py --mib 1536 --log $W/logs/run-1.guard.log -- \
      python3 -u -B $W/runner_r2.py --config $W/config-r2.json --run > $W/logs/run-1.out 2>&1; echo "exit=$?"

Run in the foreground; 98 means not started. Exit codes are as r1: 0 all PASS | 1 group FAIL/NOT_RUN | 2 refused |
3 cleanup unconfirmed | 4 error before the groups.

Envelope:
- one disposable --network none container, as before (1280 MiB, 2 CPUs);
- 14 hosts per group, about 1.4 GB of sector files per group, removed after the group;
- 3 groups; the previous feindexd group took 156 s of driver time;
- worst case 3 x (300 s harness readiness + 1560 s) ≈ 93 min, typically about 15 min.
