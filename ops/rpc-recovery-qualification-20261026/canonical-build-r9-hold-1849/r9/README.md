# base-state-readonly-stage/r9 = r8 + review 1841 / root 1843 corrections (PREPARED by Claude 1844; UNTESTED; NOT built; NOT PASS; production HOLD)
Report: ../../logs/claude-canonical-build-r9-corrections-1844.md (r8: 1839; plan 1837). r8 (`49a41e28…`) is preserved unchanged. Its ACTUAL
tests passed: guard 10 + 6 + 11 and namespace 4, at r8/runs/guard-tests-20261027T063200Z-2864392 and ns-tests-20261027T063230Z-2864943
(archived 77ca5aefc). Review 1841's "no tests run" means only that the reviewer did not run them.

**Do not build until ALL 265 parts are committed AND independently verified (CONFIRMED).** The outer and inner gates refuse otherwise.

## Unchanged (byte-identical to r7/r8)
- **Rust and Cargo:** `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml`.
- **The disk guard and old tests:** `jobs/disk_guard.py` (= r5), `jobs/mount_identity.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py`, `tests/test_mount_identity.py`.
- **The guard command** (64 GiB start, 40 GiB floor, 20 GiB SAMPLED cap every 15 s, 7500 s).
- **The all-265 gate and resource policy:** 4096 exclusive lane + 16 GiB host floor; root 40 GiB + 8 GiB native + 16 MiB metadata; everything of the build in the guarded /vm run dir; binaries in place on /vm.

## r9 corrections
- **PB1 (`jobs/ns.sh` + `bsro_gate.ro_tree_ok`):**
  - `mount --make-rprivate /` first;
  - then `/home/steven` and `/tmp` are bound **recursively, read-only recursively** (`mount --rbind -o ro=recursive`, else rbind + `remount,bind,ro=recursive`), so the inherited, locked submounts are included;
  - then the bound tree is made private again;
  - the inner gate (and `ns-check`) require that **every visible mount at or under each root is `ro`** (mountinfo tree from the top mount at the root; shadowed originals ignored), plus private propagation and ST_RDONLY.

  This is specific enforcement for those two roots, not a read-only root filesystem.
- **Root #1 (authentication):** `guard-receipt.json` must show `reason` null (present), `childRc` exactly int 0 and `groupLeftAlive` exactly false. Otherwise the run is not verified (final 10 if the build rc was 0).
- **Root #2 / m1 (`run_capture`):** a bounded read per iteration, then the lifecycle ticks EVERY iteration: leader exit, the grace or TERM-wait deadline, then KILL of our group (leader still unreaped), then hard abandonment. **Continuous output can no longer postpone it.**
- **m2:** the forwarding handlers are installed BEFORE the spawn; a signal during the spawn stays pending and is forwarded once the child exists.
- **Root #3:**
  - a spawn failure closes the capture fd, and the exception propagates (the outer records rc 127);
  - a capture-sink write or fsync failure sends ONE SIGTERM to our group: `build.sh`'s trap keeps it and `disk_guard` ends its OWN build group in order (rc 73). Draining continues, the run is never verified, and the deadlines stay bounded;
  - any unexpected error closes the pipe, sends TERM, waits a bounded time, sends KILL to our group only, and reaps.

  There is no queue kill and no subreaper.
- **m3:** a descendant OUTSIDE our group that still holds the pipe after our group's KILL makes the run `abandoned`: reading stops and it is **never a success**. Ending it is left to the queue's own tree kill (no subreaper by design).
- **m4:** early cancellation (before the trap: checks, hardening, inner gate) ends `build.sh` with rc 143. **Nothing has started then.**
- **m5:** `positive.sh`/`fixtures.sh` must be given the **/vm** `guard.outDir` named by a verified build receipt (not the root `runs/build-*/out` symlink).
- **The ns-tests job refuses while a recovery or composite stage mount exists,** since a mount namespace would pin a live session's FUSE mount.

## Tests (PREPARED, NOT RUN)
```
bash jobs/q-exit-status.sh bsro-r9-guard-tests 256 unshare -Urn  bash base-state-readonly-stage/r9/jobs/guard-tests.sh   # PASS: 10 + 6 + 14
bash jobs/q-exit-status.sh bsro-r9-ns-tests    512 unshare -Urnm bash base-state-readonly-stage/r9/jobs/ns-tests.sh      # PASS: 5 (main lane: no live session mount)
```
**Only after all 265 parts are CONFIRMED** (4096 exclusive main lane): `jobs/build-outer.sh preflight`, then `jobs/build-outer.sh build`, then `positive.sh <guard.outDir>` and `fixtures.sh <guard.outDir>/base-state-readonly` (commands as in r8, with r9 paths).

**Meaning:** a build plus fixtures proves the helper on synthetic fixtures only; it is not production database integrity, canonical state or RPC readiness.
