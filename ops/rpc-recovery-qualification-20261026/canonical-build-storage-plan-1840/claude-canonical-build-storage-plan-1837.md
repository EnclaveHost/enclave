# 1837: narrow storage plan for the canonical state verifier build: a future base-state-readonly-stage/r8 (PLAN ONLY: nothing implemented, built or run)

**Scope:** reading source and bounded metadata only.
- **What I read:**
  - `base-state-readonly-stage/r7` (SUMS `7d4ccc8f…`, `sha256sum -c` OK): `jobs/{build.sh, build-inner.sh, env.sh, disk_guard.py, preflight.sh, positive.sh, fixtures.sh, guard-tests.sh}` and `tests/`;
  - the rejected `logs/claude-state-build-admission-1804.md`, the archive `source/ops/rpc-recovery-qualification-20261026/build-hold-1808/`, and `logs/state-build-hold-1807.txt`;
  - `findmnt` and `df` metadata.
- **Not done:** builds, tests, queue jobs, mounts, scope changes, part or original reads, network, installs or commits. The rejected 1804 admission script and r7 are **not** run, extended or modified.
- **Decision unchanged: NO build until all 265 parts are committed AND independently verified (CONFIRMED).**

## 1. Facts from the r7 source (why 1804 was rightly rejected)
**Where r7 writes during `build.sh` → `disk_guard.py` → `build-inner.sh` → `env.sh prepare build`:**

| what | path | filesystem | bounded? |
|---|---|---|---|
| scratch: `tree/`, fresh `cargo-home/`, `target/` | `$BSRO_RUN_DIR/scratch` (`B`) | **/vm** (guard run dir) | sampled by the guard (§3) |
| **outputs**: `toolchain.txt`, `build.log`, `Cargo.lock.resolved`, `lock-check.json`, **both release binaries (copied 0555)** | `O=$S/runs/build-<run>` (`env.sh:26`, `build-inner.sh:9-14`) | **root** | **no**: the binaries alone may be hundreds of MB; `build.log` is unbounded |
| rustc/cc/linker temp files | **`TMPDIR` unset** in `E=(env -i …)` (`env.sh:29-30`), so `/tmp` | **tmpfs (RAM)**: `/tmp tmpfs size=65437300k` | **no**: it uses host RAM (shmem charged to the build's cgroup), outside the guard's accounting; leftovers persist in RAM |
| bash heredoc temp files (`lock_check`) | `$TMPDIR`, default `/tmp` | tmpfs | tiny |
| writes through `cargo-home/registry` and `cargo-home/git` **symlinks** into the cached store `$DEPS/cargo` (`env.sh:28`) | `derivation-client-stage/combined-r1/build/deps-…` | **root** | **no**: only detected afterwards by `unchanged()` (1804 C3) |
| rustup home (`RUSTUP_HOME=/home/steven/.rustup`) | `/home/steven/.rustup` | **root** | not expected; only post-checked by `rman()` |
| the guard's `guard-receipt.json` | the run dir | /vm | small |

**Correction to the "root TMP leak" wording:** `/tmp` here is **tmpfs**, so the unset TMPDIR is a **RAM** leak, not a root-disk one. It still breaks the 1804 requirements: uncontrolled TMPDIR and no terminal accounting, and it weakens the 16 GiB host floor.

## 2. Capacity at the point the build becomes allowed (your figures; metadata today: / 82.4 GB, /vm 706 GB free while preservation runs)
- **When all 265 parts are complete, the remaining multipart reservation is 0 on both targets.** The existing **absolute** guard floor (40 GiB on /vm) then equals the full-remaining reservation (0 + the 40 GiB manifest floor). This is what resolves 1804's C1, **but only if the gate proves completion**.
- **/vm free ≈ 83 GB.** The guard requires ≥ 64 GiB (68.7 GB) at start, which leaves a **≈ 14 GB start margin**. Headroom above the 40 GiB floor (42.9 GB) is ≈ 40 GB; the scratch cap is 20 GiB (21.5 GB).
- **Root margin ≈ 0.8 GB** beyond the 40 GiB floor + 8 GiB native (both retained). The plan therefore puts **nothing large on root**: only ≤ 16 MiB of bounded metadata.
- **Exclusive 4096 MiB main lane:** the build holds the main flock for its whole run; preservation is finished by then. It does not run concurrently with any composite production run. The host memory floor stays 16 GiB.

## 3. The existing guard, stated honestly (unchanged in r8)
**What `disk_guard.py` (byte-identical to r5, `cmp` enforced by `build.sh:18`) does:**
- runs the build in its own process group in a NEW 0700 run dir on the pinned /vm mount (mountinfo majmin + source + fstype; start ≥ 64 GiB free);
- samples every **15 s** (plus the time of an `lstat` walk of up to 2,000,000 entries) for free space < 40 GiB (rc 70) or run-dir allocation > 20 GiB (rc 71); stops after 7500 s (rc 72) or on SIGTERM (rc 73);
- stops = TERM, then KILL of its OWN unreaped group only.

**It is NOT a hard 20 GiB ceiling.** Overshoot = write rate × (15 s + walk time), and it is unmeasured.
- **What actually protects /vm** is the 40 GiB floor, with ≈ 40 GB of headroom at start.
- **To breach it,** a single interval would have to add > ≈ 18 GB beyond the 20 GiB cap. That is unlikely for rustc/linking, but **not proven**.
- **The guard also never sees** tmpfs `/tmp` or root writes. That is exactly what §4 removes.

## 4. Proposed r8 (minimal; reuse everything else byte-for-byte)
**Unchanged:**
- `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml` (the Rust bytes);
- `jobs/disk_guard.py` and `tests/test_disk_guard.py`/`guard_wrapper.py` (r5 bytes, `cmp` kept);
- `jobs/mount_identity.py` and its test;
- the pinned toolchain env (RUSTUP_HOME/TOOLCHAIN 1.96.0, `RUSTUP_AUTO_INSTALL=0`, offline, `-j 4`, 7200 s), the seeded Base lock and `lock_check`, the `man`/`rman`/`unchanged` post-checks;
- the guard arguments (`--min-start-gib 64 --floor-gib 40 --max-scratch-gib 20 --interval 15 --timeout 7500`).

### 4a. `jobs/env.sh`, `prepare()` only (≈ 6 lines)
- **Require `BSRO_RUN_DIR`:** no `/tmp` fallback in r8. A bare run is refused, and preflight also runs under the guard (§4d).
- **Under that run dir:**
  - `B=$BSRO_RUN_DIR/scratch` (as now);
  - **`O=$BSRO_RUN_DIR/out`** (was `$S/runs/…`, on root);
  - **`T=$BSRO_RUN_DIR/tmp`** (`mkdir -m 0700`).
- **`export TMPDIR=$T`** (for the bash heredocs), and add **`TMPDIR="$T"`** to the `E=(env -i …)` array, so rustc, cc and ld temp files land in the guarded /vm run dir and are counted by the guard's walk.
- **Result:** every build byte (scratch, cargo-home, target, temp, logs, final binaries) is inside the ONE guarded /vm run dir.

### 4b. `jobs/build-inner.sh` (≈ 5 lines)
- **No logic change:** binaries, logs and lock files land in `O` (now /vm) automatically.
- **Add terminal accounting:** after `unchanged`/`lock_check`, write `O/accounting.json` containing:
  - the run dir's allocated bytes (reuse `disk_guard.alloc_bytes`, imported from the same pinned file);
  - the bytes left in `T`;
  - the binaries' sizes and sha256;
  - the `unchanged` and lock-check verdicts.
- **No change to its exit-code semantics.**

### 4c. `jobs/build.sh` (inside the namespace; the queue command becomes `unshare -Urnm`, as r7's `positive.sh` already does)
Before the unchanged guard invocation, add:
1. **Identity:**
   - `/proc/self/uid_map` must be exactly one line `0 <outer uid> 1`, and `gid_map` likewise (the outer ids are passed in by §4d);
   - `/proc/self/setgroups` must be `deny`.

   Otherwise refuse. This makes the inside ownership checks (r3 `open_dir` owner == `getuid()`) mean "owned by the real user". Files of any other uid then appear as overflow 65534 and are refused.
2. **Root read-only inside the private mount namespace** (no change to the host):
   - `mount --bind /home/steven /home/steven && mount -o remount,bind,ro /home/steven`, and the same for `/tmp`;
   - verify `statvfs(…).f_flag & ST_RDONLY` on `$S`, `$DEPS/cargo`, `/home/steven/.rustup` and `/tmp`; refuse otherwise.

   Any write to the cached store (through the symlinks), the rustup home, the stage, root `runs/` or tmpfs then **fails the build** (fail closed) instead of landing on root or in RAM. This turns 1804 C3 from a post-check into **enforcement during the run**. `/vm` is a separate mount and stays writable.
3. **Re-run the completion gate inside** (§4e) after the RO bind. It only reads records and `lstat`s, so it closes the window since the outer gate.
4. **Keep:** the r7 checks (stage SUMS, r5 guard bytes, guard-tests receipt, `mount_identity.py`), then the **identical** `disk_guard.py` command line.

### 4d. New small `jobs/build-outer.sh` (real uid; the queue command), **plus a mode for preflight**
**Queue command:**
```
bash jobs/q-exit-status.sh bsro-r8-build 4096 bash base-state-readonly-stage/r8/jobs/build-outer.sh [preflight|build]
```
1. Check the stage SUMS.
2. **Completion gate (§4e), outside the namespace, as the real uid.**
3. **No live sessions:** no live preservation or composite session, and no stage mount. Reuse the pinned r6 `session_guard.py` and the r10 `memory_gate.py guard` read-only (pinned by sha), plus the r6 stage-mount pattern.
4. **Lane:** own cgroup `memory.max` == 4096 MiB, and MemAvailable ≥ 16 GiB + 4096 + 256 MiB (the 16 GiB floor kept).
5. **Root:** free ≥ 40 GiB floor + 8 GiB native + the 16 MiB metadata budget (remaining = 0 is required by step 2). Record root free *before*.
6. **Metadata dir:** create `runs/<mode>-<ID>/` on root (0700).
7. `unshare -Urnm bash jobs/build.sh <mode> <outer uid> <outer gid>`, with its stdout captured into the metadata dir under `ulimit -f 1024`.
8. **Afterwards, under `ulimit -f 1024` (≤ 1 MiB per file):** write `receipt.json` with:
   - the rc and the guard run dir (parsed from the guard's `## disk-guard run dir` line, verified as a real 0700 dir under the pinned base);
   - the sha256 of `guard-receipt.json` and `accounting.json`, and of the two binaries (read from /vm; nothing is copied to root);
   - root free before and after, and the delta;
   - the verdict.

   Optionally add **one symlink** `runs/<mode>-<ID>/out → <run dir>/out`, so a reviewer finds the binaries.
9. **Final rc:** a nonzero build rc is preserved. Build rc 0 becomes **10** if accounting, receipt or verdict is missing or malformed, or if the root free delta exceeds the metadata budget plus a small tolerance (other host writers make it advisory but fail-closed).
10. **`preflight` mode:** the r7 `preflight.sh` body (cargo metadata, lock check, unchanged checks), run through the same guard with the same `BSRO_RUN_DIR`. Its `metadata.json` (tens of MB) then lands on /vm, not root. Do **not** run the r7 standalone preflight, which writes to root `runs/` and `/tmp`.

**Root output budget:** ≤ 8 files × 1 MiB plus the queue's own small log lines ≈ **≤ 16 MiB**, far inside the ≈ 0.8 GB margin. **The queue's `logs/bsro-r8-*.{out,guard,rc}` stay external:** `build.sh` prints only tails, toolchain, lock check and sha lines.

### 4e. Completion gate (one small Python function, shared outside and inside)
- **The rule:** the pinned recovery-multipart r3 core (`3159890b…`), loaded from its exact bytes, `status(d, msha)` on the pinned production manifest (`f94807f7…`) must give:
  - `copyComplete` and `verificationCompleteRecorded` true;
  - `partsCommitted == partsVerifiedRecorded == 265`;
  - `stale`, `unconfirmed`, `invalidRecords` and `failedVerification` all empty.
- **Cross-check:** the remaining bytes per target are 0, via the pinned 1773 runner's `part_state`.
- **It reads only records, session/verify JSON and `lstat`; it never reads part bytes.**
- **Inside the namespace** it runs only after the uid/gid map check of §4c-1, so ownership means the same thing on both sides.

## 5. Fixture compatibility
- **The jobs take the binary location as an absolute argument** (`positive.sh <BD>`, `fixtures.sh <binary>`), so pass `<guard run dir>/out` on /vm. /vm is `ext4 rw,relatime` (no `noexec`) and is visible inside `unshare -Urnm`.
- **The r8 copies are r7's with only the r8 stage path.** Their own writes are tiny: mk_fixture cases in `/tmp` (tmpfs), plus per-case JSON and log files in `runs/positive-*` and `runs/fixtures-*`.
- **r8 wraps those root-side writes in `ulimit -f 1024`** (an explicit small budget). The 14 positive cases and 6 negative cases keep their exact expectations.
- **No `runs/build-*` symlink is required** by any existing job. The optional symlink is for reviewers only.

## 6. Validation before any actual build (small; no compilation)
1. **Unchanged guard suites:** `test_disk_guard` (exactly 10, r5 bytes) and `test_mount_identity` (6).
2. **New tests:**
   - **completion gate:** pure, on synthetic status dicts: complete passes; each of stale, unconfirmed, invalid, failed, 264 verified, or remaining > 0 refuses;
   - **uid/gid map parser:** exact `0 <uid> 1` only; multi-line, wrong uid or wider ranges refuse;
   - **`prepare build` placement:** under a temporary `BSRO_RUN_DIR` (runs the real `rustc -V`/`cargo -V` only, no build), assert that B, O and TMPDIR are inside the run dir, that `E` contains `TMPDIR`, and that nothing new appears in the stage `runs/` or `/tmp`;
   - **RO-bind hardening under `unshare -Urnm`:** a bound read-only test dir gives EROFS on write, and the ST_RDONLY checks refuse an unbound dir;
   - **final-rc/accounting decision:** a nonzero rc is preserved; missing or malformed accounting turns 0 into 10;
   - **`build-outer.sh` refusals:** outside the 4096 lane, or with an incomplete status (using an injected status provider in the unit test only).
3. **Then, only after all 265 parts are complete:** the actual `preflight` mode, the actual `build`, and the positive (14) and fixture (6) runs against the /vm binaries.

## 7. Remaining risks (not hidden)
- **Guard overshoot is real (§3):** 15 s sampling plus the walk; the 20 GiB cap is not a hard ceiling. The /vm floor margin is ≈ 40 GB at an ≈ 83 GB start. **Start margin is only ≈ 14 GB above 64 GiB:** if /vm has less free space at completion, the build is refused (fail closed).
- **Memory:** `-j 4` rustc plus release linking inside a 4096 MiB cgroup may be OOM-killed (fail closed, no partial output trusted). Moving TMPDIR off tmpfs removes temp files from RAM. The 16 GiB floor is still admission plus the queue guard.
- **The read-only binds will make the build fail if cargo or rustup need to write** to the cached store (for example an unextracted crate) or the rustup home. That is correct fail-closed behaviour, but it would block the build until the offline cache is complete. Run the r8 `preflight` mode first to find out early.
- **Kept scratch:** the guard keeps its run dir (scratch, target, binaries), possibly ~10–20 GB on /vm, until root reviews it and removes it. A later job that needs /vm space must account for it.
- **The root free delta is advisory:** other host writers can move it. The real enforcement is the read-only root inside the namespace.
- **The timeouts** (cargo 7200 s, guard 7500 s) may be too short for a reth release build. That is rc 72 or a timeout, fail closed. They are unmeasured.
- **A successful build and fixtures prove** the helper's compiled behaviour on synthetic fixtures only, **not** production database integrity, canonical state or RPC readiness.

## 8. Exact change list for a future r8 (for review before any code)
| file | change |
|---|---|
| `jobs/env.sh` | `prepare()`: require `BSRO_RUN_DIR`; `O=$BSRO_RUN_DIR/out`; `T=$BSRO_RUN_DIR/tmp`; `export TMPDIR=$T`; add `TMPDIR="$T"` to `E` |
| `jobs/build-inner.sh` | + `accounting.json` (alloc bytes via `disk_guard.alloc_bytes`, residual temp, binary sizes and shas, verdicts) |
| `jobs/build.sh` | + mode arg; + uid/gid map and `setgroups` check; + RO bind of `/home/steven` and `/tmp` with ST_RDONLY verification; + inner completion gate; guard command unchanged |
| `jobs/build-outer.sh` (new) | outer completion gate, live-session/mount guards, 4096 lane + 16 GiB floor, root floor check, `unshare -Urnm`, bounded root metadata receipt and final rc |
| `jobs/preflight.sh` | body unchanged; runs only via `build-outer.sh preflight` under the guard |
| `jobs/positive.sh`, `jobs/fixtures.sh` | r8 paths; root-side writes under `ulimit -f 1024`; expectations unchanged |
| tests | + the new small suite (§6); guard suites unchanged |
| unchanged bytes | `src/**`, `Cargo.toml`, `jobs/disk_guard.py`, `jobs/mount_identity.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py`, `tests/test_mount_identity.py` |
