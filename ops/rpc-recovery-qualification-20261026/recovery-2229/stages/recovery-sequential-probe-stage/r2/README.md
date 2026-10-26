# recovery-sequential-probe-stage/r2 (prepared by Claude 1738/1741; NOT run). r1 preserved unexecuted.

A SMALL, BOUNDED, READ-ONLY sequential-read timing of the original `base-origin.qcow2`. Reports: `logs/claude-recovery-sequential-probe-1738.md` (r1) and `logs/claude-recovery-seqprobe-r2-1741.md` (r2; root review 1740).

**Child lifecycle:** every read runs through the exact qualified **`mdbx-recovery-validator-stage/r4/src/mdbx_check.py` (`f0d27e40…`)**, loaded from its sha-checked bytes, using `bounded_run` and its signal deferral. r2 contains no lifecycle code of its own.

**Statistics:** from `qemu-io read -C`. The reported byte count must equal the requested length.

**Results:** per-sample `complete`, an explicit `completeCount`, `measuredBytes` and requested bytes. Any incomplete sample makes the run INCONCLUSIVE (rc 5). Rates are labelled as measured under **concurrent load**.

**Unchanged from r1:** the authenticated sample selection, the read-only original and its identity checks, and the refusal if anything names the original.
- **Bounds:** 4 × 64 MiB, ≤ 256 MiB, ≤ 240 s, concurrency 1.
- **Page cache:** not controlled.
- **Claims:** no integrity, ETA or isolated-throughput claim.

**Tests:** `tests/test_seqprobe.py` has 7. **Jobs:** `jobs/tests.sh`, then `jobs/root-real.sh`.
