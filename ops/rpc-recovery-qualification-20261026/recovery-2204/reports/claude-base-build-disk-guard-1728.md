# 1728: base-state-readonly-stage/r5, a disk-guarded build scratch on /vm (SOURCE ONLY; frozen, nothing built or run)

**Stage:** `base-state-readonly-stage/r5/`, **SHA256SUMS sha256 `71e5fac4008a1776271cb83434311d6ece1621c8cdf0f29f3ba8edf9471c988f`** (files 0444, jobs 0555).
- **Frozen r4:** unchanged (`0d088032…`).
- **What I did:** `bash -n`, `ast`, the test count (10), and **read-only** `findmnt`/`df`/`ls` of `/vm`. No build, test or live action.

**Pinned /vm identity** (read-only `findmnt -T /vm/enclave-volumes`, 1728):

| field | value |
|---|---|
| target | `/vm` |
| source | `/dev/mapper/cryptvm` |
| fstype | ext4 |
| MAJ:MIN | 253:1 |
| UUID | `aaae081c-f829-4484-a50f-a9bbb87d31f9` |

`/vm/enclave-volumes` is `steven 755`. **106 GiB was available at the time.** `rpc-recovery-validation-build` does not exist yet; the guard creates it 0700.

## Change r4 → r5 (only the build scratch location and guard; everything else is labels)
**`jobs/disk_guard.py` (new, stdlib):** one guarded command, following the lifecycle pattern of `mdbx-recovery-validator-stage/r4` `bounded_run`.
1. **Location and mount checks, before anything is created:**
   - `--base`'s parent must be a real directory (no symlink);
   - the mount holding it must be the pinned one (mountinfo maj:min + source + fstype, same `st_dev`, longest mountpoint prefix);
   - the base is created 0700 if absent, otherwise it must be a real directory owned by us on the same device.
2. **Start free space:** `statvfs` free ≥ **64 GiB**, otherwise refused (rc 3) with no run dir.
3. **A NEW run dir** `run-<UTC>-<pid>`, created with `mkdir 0700` (never an existing path, never a symlink).
4. **The command:** it runs in its **own session/process group** with `cwd` = the run dir and `BSRO_RUN_DIR` = the run dir.
5. **Every 15 s the guard samples** `/vm` free space and the run dir's **allocated blocks** (lstat `st_blocks`, never following symlinks; more than 2,000,000 entries counts as over the cap):

| condition | rc |
|---|---|
| free < **40 GiB** | **70** |
| allocated > **20 GiB** | **71** |
| > **7500 s** | **72** |
| SIGTERM/INT/HUP to the guard | **73** |

6. **Stop:** SIGTERM to **its own group only**, ≤ 10 s, then SIGKILL. The leader is kept unreaped (`waitid WNOWAIT`) until both are done, so the pgid cannot be reused; then the single reap.
7. **Never deleted:** the scratch stays for review (`guard-receipt.json`, O_EXCL, holds the samples and the reason). No other process is ever signalled.

A child killed by a signal gives 128+N.

**The jobs:**
- **`jobs/build.sh` (outer):** refuses (rc 9) unless
  - the stage SUMS verify;
  - a **`bsro-r5-guard-tests` receipt for this exact frozen SHA256SUMS** passed;
  - `findmnt` still reports the pinned UUID, source, fstype and maj:min.

  Then it runs `disk_guard.py --base /vm/enclave-volumes/rpc-recovery-validation-build … -- bash jobs/build-inner.sh`.
- **`jobs/build-inner.sh`:** r4's `build.sh` body, unchanged: the pinned rustup env (1.96.0, no auto-install), the isolated `CARGO_HOME` over the cached store, the seeded Base lock, `--offline -j 4 --bins`, the 7200 s cargo timeout, and the cache, rustup and Base-lock checks. Its scratch is `$BSRO_RUN_DIR/scratch` on /vm, and it **refuses outside the guard**.
- **`jobs/env.sh`:** uses `$BSRO_RUN_DIR/scratch` when set. The preflight keeps its tiny `/tmp` metadata scratch (removed at its end), unchanged from the r4 PASS.

**Unchanged from r4 except labels** (diff checked): the helper, `mk_fixture`, `Cargo.toml`, `preflight.sh`, `fixtures.sh` and `positive.sh` (all r3/r4 fixtures and status checks). The normal 4096 main queue and its 16 GiB floor still apply on top.

## Guard tests (`tests/test_disk_guard.py`, 10; `jobs/guard-tests.sh`)
**How they run:** the **real** `disk_guard.py` runs as a subprocess through `tests/guard_wrapper.py`. The wrapper replaces only the **providers**:
- a synthetic mountinfo with the test dir's real maj:min and a fake source;
- a synthetic free-space sequence.

Commands are dummy writers (≤ 4 MiB, in the test dir) and sleepers. Only the tests' own processes are signalled.

**The 10 cases:**
1. **Bad base or args:** a symlink base (nothing created through the link), a file base, a relative base, floor ≥ start, or no command → 3, no base created.
2. **Wrong mount source:** 3, **before** the base is created.
3. **Start free 63.9 GiB:** 3, no run dir.
4. **Normal run:** in a NEW 0700 run dir, with the child's `cwd` and `BSRO_RUN_DIR` both = the run dir, the receipt kept, and the base 0700.
5. **The child's rc is propagated:** 7.
6. **Free drops below 40 GiB:** rc 70. The guarded leader **and its grandchild** are dead, an **unrelated sleeper survives**, `groupLeftAlive` is false.
7. **Real 4 MiB writer vs a ~1 MiB cap:** rc 71, the scratch is kept, and the sampled allocation exceeds the cap.
8. **Timeout:** rc 72 within 30 s.
9. **SIGTERM to the guard:** rc 73, the child is dead, reason `cancelled`.
10. **A pre-existing base with a file:** kept untouched; exactly one new run dir.

```
bash jobs/q-exit-status.sh bsro-r5-guard-tests 256 unshare -Urn bash base-state-readonly-stage/r5/jobs/guard-tests.sh
```
- **Gate:** exactly `Ran 10 tests`, a final `OK`, empty stdout, no bad markers; `receipt.json` is bound to the stage SUMS.

## Root order
1. `bsro-r5-guard-tests` (256) → `## bsro-r5-guard-tests rc=0`.
2. **After the probe ends (~22:13):**
   ```
   bash jobs/q-exit-status.sh bsro-r5-build 4096 unshare -Urn bash base-state-readonly-stage/r5/jobs/build.sh
   ```
   rc: the child rc / 3 refused / 70 / 71 / 72 / 73 / 9 precondition. Binaries go to `runs/build-run-*/`.
3. Then `fixtures.sh` (512) and `positive.sh` (512, `-Urnm`), with the build output dir, as in r4.

The r4 preflight PASS (604 packages = Base lock, 1.96.0, cache untouched) applies unchanged: the resolution inputs are byte-identical.

## Limits (stated)
- **Coarse limits:** the guard bounds space by **sampling every 15 s**. A burst between samples could exceed 20 GiB or dip below 40 GiB by that much before the stop. The margins (64 GiB start, 40 GiB floor) absorb this, and peers' backups are what move /vm free space.
- **What the scratch cap counts:** only the guarded run dir. Other /vm writers are not limited, only observed through the floor.
- **Under `unshare -Urn`:** ownership is checked as the mapped uid, which is consistent for the user's own `/vm/enclave-volumes`.
- **Kept scratch:** a stopped or failed build's scratch is **kept** (no automatic deletion). Root removes it after review.
- **Compilation itself remains unproven** (see 1724: the remaining compile unknowns).
