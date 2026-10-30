# recovery-sequential-probe-stage/r1 (prepared by Claude 1738; NOT run)

A SMALL, BOUNDED, READ-ONLY sequential-read timing of the original `base-origin.qcow2`. Report: `logs/claude-recovery-sequential-probe-1738.md`.

**What it does:** 4 deterministic, well-separated 64 MiB ranges, each wholly inside a **written** extent of root's authenticated map (coverage `70180b22…`).
- **Each read:** one pinned `qemu-io -r --image-opts …read-only=on,file.locking=off -c "read OFF LEN"` (qemu-io `085e254e…`).
- **Bounds:**
  - concurrency 1;
  - each read 45 s, then TERM, then KILL 5 s later, in its own process group and always reaped;
  - ≤ 240 s and ≤ 256 MiB in total.
- **Output:** timings and rates only.
- **The original:**
  - it must be on a read-only mount and not writable;
  - the pinned production manifest is checked (`a2843215…`, `discard=ignore`);
  - its identity is compared before and after;
  - the run **refuses if any process names it**.

**What it is not:** page cache is **not** controlled. It is not an integrity check, and not a copy or validation ETA.

**Tests:** `tests/test_seqprobe.py` has 5 fixtures:
1. selection;
2. refusals;
3. read-only `qemu-io` on a known-pattern qcow2;
4. a hung child's group ended and reaped;
5. the original-naming guard and the read-only requirement.

**Jobs:** `jobs/tests.sh`, then `jobs/root-real.sh`.
