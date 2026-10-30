# Reconnect in place, attempt 2 (2026-09-25 11:32Z): STOPPED in setup -- a harness error, kept as run

**Nothing was exercised: no relay, no VM, no transaction.** The harness at c6e47492 named its scratch directory after the
results directory, so attempt 1's lab policy keys were still there. `lab-sign keygen` refused to overwrite them ("exists:
not overwritten") and printed nothing, and the harness stopped on "Unexpected end of JSON input".
- **The run's own scan** found neither operator key in the results.
- **The fix:** one scratch directory per run (the run's id is in the name, and an existing one is refused). A keygen refusal
  now stops the run in its own words.
