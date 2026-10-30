# base-state-readonly-stage/r8: storage correction for the canonical state verifier build (PREPARED by Claude 1839; UNTESTED; NOT built; NOT PASS)
Plan: ../../logs/claude-canonical-build-storage-plan-1837.md. Report: ../../logs/claude-canonical-build-storage-implementation-1839.md.
r7 (`7d4ccc8f…`) and every other frozen stage are unchanged.

**Do not build until ALL 265 parts are committed AND independently verified (CONFIRMED).** The outer gate refuses otherwise.

## Byte-identical to r7
- **The Rust verifier:** `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml`.
- **The unchanged guard and its tests:** `jobs/disk_guard.py` (= r5), `jobs/mount_identity.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py`, `tests/test_mount_identity.py`.
- **The guard's command line:** `--min-start-gib 64 --floor-gib 40 --max-scratch-gib 20 --interval 15 --timeout 7500`.
  - **The 20 GiB cap is SAMPLED, not a hard ceiling:** every 15 s plus the tree walk.
  - **The 40 GiB floor on /vm** equals the full reservation only because the gate requires 0 remaining parts.

## What r8 changes (plan 1837 §4–6)
- **`jobs/env.sh` `prepare()`:** runs ONLY under the guard. Scratch, outputs (logs, lock files, binaries, accounting) and a private `TMPDIR` all live in the ONE /vm run dir; `TMPDIR` is exported and is in the build `env -i`. There is no `/tmp` or root fallback.
- **`jobs/build-inner.sh`:** the r7 body. Binaries stay in `RUN/out` on /vm, and the bounded `accounting.json` (≤ 1 MiB, O_EXCL) is written via `bsro_gate.py account`.
- **`jobs/build.sh`** (inside `unshare -Urnm`; started only by the outer):
  - the r7 checks (stage SUMS, r5 guard bytes, /vm mount identity), with the qualifying receipts now the r8 guard-tests **and** ns-tests receipts;
  - **`jobs/ns.sh`:** propagation made PRIVATE first (`mount --make-rprivate /`), then read-only binds of **/home/steven and /tmp in this namespace only**. This is specific enforcement for those paths: the cache, rustup home, stage, root `runs/` and tmpfs. **The root filesystem is NOT immutable:** `/var` and other paths stay writable.
  - **the inner gate:** exact maps `0 → real uid/gid`, 1 id, `setgroups deny`; propagation private; the read-only and writable checks; the completion fingerprint recomputed == the outer one;
  - then the r7 guard command;
  - a TERM/INT/HUP trap so the exit code propagates.
- **`jobs/build-outer.sh` → `bsro_gate.py outer build|preflight`** (real uid; the queue command):
  1. the stage SUMS and the qualifying receipts;
  2. the outer maps (the initial user namespace, non-root);
  3. the 4096 MiB lane plus the 16 GiB host floor;
  4. the root floor: 40 GiB + 8 GiB native + 16 MiB;
  5. no live sessions or stage mounts;
  6. **the completion gate:** the pinned 1773 runner (verifies frozen r3) + the r3 core `status()`, and 0 remaining via `part_state` (record + current dev/ino/size/mtime/ctime/nlink); **metadata only, never part bytes**;
  7. a new `runs/MODE-ID/`;
  8. `unshare -Urnm bash jobs/build.sh …` through a **bounded reader:** 1 MiB kept, the rest drained; **no rlimit on the build**;
  9. **an authenticated receipt:** the guard run dir is verified, the binaries are hashed IN PLACE on /vm and must equal the accounting, with one symlink only. **The root floor is re-checked (mandatory); the root free delta is ADVISORY.**
  10. **Exit:** a nonzero rc is preserved; rc 0 becomes 0 only if verified, else 10.
- **`jobs/preflight.sh`:** runs only via `build-outer.sh preflight` (metadata on /vm).
- **`jobs/positive.sh` / `jobs/fixtures.sh`:** the binaries are used in place after `bsro_gate.py verify-binaries`; only the root-side copies are bounded (`head -c` 1 MiB); the 14 positive and 6 negative expectations are unchanged.

## Tests (prepared, NOT run)
```
bash jobs/q-exit-status.sh bsro-r8-guard-tests 256 unshare -Urn  bash base-state-readonly-stage/r8/jobs/guard-tests.sh   # PASS: 10 + 6 + 11
bash jobs/q-exit-status.sh bsro-r8-ns-tests    256 unshare -Urnm bash base-state-readonly-stage/r8/jobs/ns-tests.sh      # PASS: 4
```
**Only after all 265 parts are CONFIRMED** (4096 exclusive main lane):
```
bash jobs/q-exit-status.sh bsro-r8-preflight 4096 bash base-state-readonly-stage/r8/jobs/build-outer.sh preflight
bash jobs/q-exit-status.sh bsro-r8-build     4096 bash base-state-readonly-stage/r8/jobs/build-outer.sh build
bash jobs/q-exit-status.sh bsro-r8-positive   512 unshare -Urnm bash base-state-readonly-stage/r8/jobs/positive.sh <guard.outDir from runs/build-*/receipt.json>
bash jobs/q-exit-status.sh bsro-r8-fixtures   512 unshare -Urn  bash base-state-readonly-stage/r8/jobs/fixtures.sh <guard.outDir>/base-state-readonly
```
**Meaning:** a build plus fixtures proves the helper on synthetic fixtures only. It is NOT production database integrity, canonical state or RPC readiness.
