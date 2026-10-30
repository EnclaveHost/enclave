# 1839: base-state-readonly-stage/r8, the storage correction of plan 1837, IMPLEMENTED SOURCE-ONLY (FROZEN; UNTESTED; NOT built; NOT PASS)

**Scope:**
- **What I executed:** reading r7, r5 and the pinned helpers; writing the NEW r8; `cmp`; `ast`; `bash -n`; `sha256sum`.
- **Not done:** tests, builds, queue jobs, mounts, namespace or scope changes, part or original reads, network, installs or commits.
- **Integrity:** r7 (`7d4ccc8f…`) and r5 re-verify unchanged; no other stage was touched.
- **The decision stands: NO build until all 265 parts are committed AND independently verified (CONFIRMED).** The code enforces it (outer and inner completion gates).

## Frozen r8: `base-state-readonly-stage/r8/SHA256SUMS` = **`49a41e28764267797bd0046b90eb193cbfdba57ed3703c8737d96fbb0868c4e9`** (22 files, every file listed, read-only)
**Byte-identical to r7** (`cmp` OK; `disk_guard.py` is also == r5):

| file | sha256 |
|---|---|
| `src/main.rs` | `597a499a…` |
| `src/bin/mk_fixture.rs` | `1db170dc…` |
| `Cargo.toml` | `42dcdc8f…` |
| `jobs/disk_guard.py` | `b42cf8fd…` |
| `jobs/mount_identity.py` | `fc4d1ede…` |
| `tests/test_disk_guard.py` | `366878f5…` |
| `tests/guard_wrapper.py` | `6c6e231c…` |
| `tests/test_mount_identity.py` | `ac6b2308…` |

**Changed or new:**

| file | sha256 | change |
|---|---|---|
| `jobs/bsro_gate.py` (new; the ONE shared helper for runtime and tests) | `96e1b2635b169be92ad7894eec626714e46681f0c5195ff174fba4c59da59d5c` | gates, bounded capture, authenticated receipt, accounting, `verify-binaries` |
| `jobs/build-outer.sh` (new; the queue command) | `d56d52c2e9d80918c013279100348dd1dcadee311745d63a7ba6e2089745174a` | stage SUMS, then `exec bsro_gate.py outer build\|preflight` |
| `jobs/ns.sh` (new) | `cf5c37ff32bc446e8dda64db275f7edc90cc494490502680b3178a765f5189f9` | `ns_harden`: `mount --make-rprivate /` FIRST, then read-only binds of the given dirs |
| `jobs/build.sh` | `896a26b3aae9da9ae98eb75804f9bd9a2c6bb8b016a7db2cedd837ec9a2d541a` | mode/uid/gid/fingerprint args; r7 checks kept; `qualified`; `ns_harden /home/steven /tmp`; inner gate; TERM/INT/HUP trap; the **r7 guard command unchanged** (only the inner script chosen by mode) |
| `jobs/env.sh` | `7abd63ccbc9a0b91aeb1f85619298298ad598fb1232266496bd608c1944111c3` | `prepare()`: requires `BSRO_RUN_DIR`; B/O/T in the run dir; `export TMPDIR`; `TMPDIR` in `E` |
| `jobs/build-inner.sh` | `a7b10d1a3a0ca864ad23ab9921138030d6d7c675d904b8038e7e6a505327ba87` | records the `unchanged`/lock rcs (same rc semantics); binaries to `RUN/out`; + `account` |
| `jobs/preflight.sh` | `e5e6ffae1684d9209c38c30fcfca8b0dccbac66a1a27461e62d3b82d67f49158` | header only; runs via `build-outer.sh preflight` under the guard |
| `jobs/positive.sh` | `41233219e7a6d6d95fc38361af51f66d1626aa5820137fc56d47baea6bf0aeaf` | `verify-binaries` first; root-side copies bounded by `head -c 1 MiB` (PIPESTATUS); r8 names; **the 14 expectations are r7's** |
| `jobs/fixtures.sh` | `897f6100e9cc6b9ad06442e33aced879635cfe50a3cbf00a443ae0a7e0b3baf4` | `verify-binaries` of the binary's dir; outputs bounded; **the 6 cases are r7's** |
| `jobs/guard-tests.sh` | `a04f09abeee93823baa39ffb0cc9804cdafe0d498224d3b1fc0f75669bc1fbb5` | 3 suites (10 + 6 + 11); receipt format `bsro-guard-test-receipt/r8` |
| `jobs/ns-tests.sh` (new) | `904c0663ab4727e1f3bbaeb5751c18a5eca16719ae14b0df8d03247ce701ad71` | refuses unless inside `unshare -Urnm`; `test_ns` (4); `bsro-ns-test-receipt/r8` |
| `tests/test_bsro_gate.py` (new, 11) | `4976bbecd38343ef2270c760eace66818e4c96dbab4134ab0eef4413bdcb5302` | unit tests |
| `tests/test_ns.py` (new, 4) | `55d1daffcdd927fd77202b9f7425d66560946e47ddf16adcd22eb3db7c3179e4` | real-namespace tests |
| `README.md` | `7e397dbc0a06a9fc64287e82ac7c9d4d864bc4adf8809a30596d60a39a28d5a4` | |

## How each plan item and root refinement is met
**Storage: everything in the guarded /vm run dir.**
- `prepare()` refuses without `BSRO_RUN_DIR` (no `/tmp` or root fallback).
- `B=RUN/scratch`, `O=RUN/out` and `T=RUN/tmp` (0700) are all fresh.
- `export TMPDIR=$T` covers the bash heredocs and `sort`; `TMPDIR="$T"` is in the build `env -i`, which covers rustc, cc and ld.
- Logs, lock files, `metadata.json` (preflight), the binaries and `accounting.json` are all on /vm, counted by the guard's walk. **Nothing large is written to root.**

**Root writes (≤ 16 MiB budget):**
- `runs/MODE-ID/build-output.txt`: ≤ 1 MiB, written by **a bounded reader**, `run_capture`. The child gets **no rlimit**, so the compiler and the guarded build are never limited by it. Output beyond 1 MiB is drained and counted.
- `runs/MODE-ID/receipt.json`: ≤ 1 MiB, enforced by `write_new`.
- one symlink `out → <run>/out`.
- the small per-case files of positive/fixtures: each ≤ 1 MiB via `head -c`, while the fixture trees themselves are not limited.
- **Outside r8's bound:** the queue's own logs (only small lines are printed).

**Capture correctness (`run_capture`):**
- **Process control:**
  - the child runs in its OWN process group;
  - our SIGTERM/SIGINT/SIGHUP is forwarded once to that group while its leader is unreaped;
  - after the leader exits, EOF is awaited for 120 s, then our group is SIGKILLed;
  - if the pipe is still held 30 s later (a holder outside our group), reading stops and the run is `abandoned`, which is never a success;
  - one reap; the rc is propagated.
- **`build.sh`'s `trap ':' TERM INT HUP`** (a handler, not SIG_IGN, so children keep their default dispositions) keeps the shell until `disk_guard` has stopped its build group (rc 73), so the exit code reaches the receipt.

**Private namespace, specific enforcement only:**
- **`ns_harden`** runs `mount --make-rprivate /` **before any bind**, then bind-mounts `/home/steven` and `/tmp` read-only **in this namespace only**. The host is unchanged and the mounts vanish with the namespace.
- **What it covers:** the cached crate store (behind the symlinked `CARGO_HOME`), the rustup home, `~/.cargo`, the stage and root `runs/`, and tmpfs `/tmp`. Writes there now fail during the build instead of only being detected afterwards (1804 C3).
- **What it does not cover:** **the root filesystem is NOT immutable.** `/var` and other paths outside these two dirs stay writable.
- **The inner gate verifies:** private propagation (no `shared:`/`master:`/`propagate_from:` in mountinfo), ST_RDONLY on the stage, `DEPS/cargo`, `~/.rustup`, `~/.cargo` and `/tmp`, and that `/vm` BASE stays writable.

**Exact uid/gid maps:**
- **Outside:** the initial user namespace (identity maps `0 0 4294967295`), uid ≠ 0 and gid ≠ 0.
- **Inside:** `uid_map` exactly `0 <outer uid> 1`, `gid_map` exactly `0 <outer gid> 1`, `setgroups` = `deny`.

  The r3 owner checks inside therefore mean "owned by the real user"; any other uid appears as overflow and is refused.

**The all-265 completion gate (metadata only):**
- **How it loads:** the pinned 1773 runner (`5c33f6e2…`), from its exact bytes. Its own top level verifies the frozen r3 stage SUMS, and r8 also requires its core == r3 `multipart.py` `3159890b…`.
- **The status:** r3 `status(d, msha)` on the pinned manifest `f94807f7…` must give 265 committed == 265 verified (CONFIRMED sessions), `copyComplete`, `verificationCompleteRecorded`, and empty stale/unconfirmed/invalid/failed lists.
- **The remaining bytes:** must be 0 on root AND vm. That is computed with the runner's `part_state`, which compares the record with the **current dev/ino/size/mtime/ctime/nlink** (r3 `dident`) and the confirmed binding or a fresh confirmed PASS.
- **Run twice:** outside, then inside after the maps check. The canonical fingerprint must be **equal**.
- **No part bytes are read:** records, session/verify JSON and `lstat` only.

**Resources:**
- the exclusive **4096 MiB** main lane (own cgroup `memory.max`) and MemAvailable ≥ 16 GiB + 4096 + 256 MiB;
- **root free ≥ 40 GiB + 8 GiB native + 16 MiB metadata**, before the run AND re-checked after it (**mandatory**; a failure makes final 10);
- **the root free delta is recorded as ADVISORY only.** Other host writers move it, so it cannot be a verdict, and the explicit floor is what is enforced;
- `/vm`: the unchanged guard (start ≥ 64 GiB, floor 40 GiB, 20 GiB **sampled** cap every 15 s, 7500 s).

**Authenticated receipt, with no root copy of the binaries:**
- **The run dir:** the guard's announced run dir must be exactly one `## disk-guard run dir` line, a `run-<UTC>-<pid>` direct child of the pinned BASE, our real 0700 dir on the BASE device, and its `guard-receipt.json` (`bsro-disk-guard/r5`) must name it.
- **Build mode:**
  - `RUN/out` must be a real dir on that device;
  - each binary must be a 0555 regular file there, hashed **in place**, equal to `accounting.json` (`bsro-build-accounting/r8`, verdict ok);
  - the receipt records paths, shas, sizes, inodes and the accounting/guard-receipt shas.
- **Downstream use:** `positive.sh`/`fixtures.sh` run `verify-binaries`. The dir must equal a **verified** build receipt's `outDir` for this stage's SUMS, and the binaries must still hash as recorded.

**Accounting:**
- `accounting.json` (≤ 1 MiB, O_EXCL) records the run dir's allocated bytes (the r5 guard's own `alloc_bytes`, loaded from the stage file), the residual `TMPDIR` bytes, the binary shas and sizes, and the build/unchanged/lock rcs.
- **The verdict is ok only if all rcs are 0 and both binaries exist.**

**Exit codes:**

| condition | exit |
|---|---|
| refused before the metadata dir | 3 (nothing written) |
| a nonzero child rc (70/71/72/73/9/127 …) | preserved |
| child rc 0 and everything verified | 0 |
| child rc 0, otherwise | **10** |

**Preserved checks:**
- r7 `build.sh`'s stage SUMS, the r5 guard bytes (`cmp` + r5 SUMS) and the `mount_identity.py` /vm identity;
- the qualifying-receipt check, now **stricter**: the r8 guard-tests receipt (exact suites 10/6/11) **and** the ns-tests receipt (4), bound to these SUMS;
- the toolchain, offline, lock and `unchanged` logic from r7 (`unchanged` is still a post-check, now backed by the read-only binds).

**There is no test-only bypass in production paths.** Test parameters (`base`, `stage`, `grace`, `hard`, `forward`) exist only as function arguments; every CLI path uses the fixed constants.

## Tests: PREPARED, NOT RUN (the actual results will be root's)
**`jobs/guard-tests.sh`** (`unshare -Urn`, 256 small lane):
- `test_disk_guard` (10) and `test_mount_identity` (6), unchanged;
- **`test_bsro_gate` (11):**
  1. completion: complete, plus 12 refusals;
  2. exact maps inside and outside (7 + 3 refusals);
  3. propagation tags;
  4. the lane and the root floor boundaries;
  5. receipts: both suites required, a short run refused, the old format refused;
  6. capture: 3 MiB in, 1 MiB kept, rc 7 propagated, no overwrite;
  7. capture: an owned background holder is killed; a `setsid` holder is abandoned, and the test kills its stray;
  8. a real forwarded SIGTERM ends only the child group (rc −15);
  9. authentication: success, plus 7 refusals (mode, sha, verdict, symlinked out, wrong receipt name, two lines, outside base), the `final_rc` table, and `verify-binaries` with no receipt;
  10. accounting: bounded, O_EXCL, a missing binary is not ok, an oversize refused;
  11. **`env.sh prepare build`** in a tmp run dir: B/O/T/TMPDIR placement, `E` contains `TMPDIR` and `HOME` in the run dir, nothing new in stage `runs/`; without `BSRO_RUN_DIR` it refuses (rc 9). This runs only `rustc -V`/`cargo -V` and the cache manifest `find`; there is no compilation.
- **Strict gate:** exact counts, OK, empty stdout, no ResourceWarning/skip/FAIL/ERROR/Traceback.

**`jobs/ns-tests.sh`** (`unshare -Urnm` required; **it fails, never skips**, outside one): `test_ns` (4):
1. the real maps are exact, and outer + 1 is refused;
2. `ns_harden` on a TEST dir gives private propagation, ST_RDONLY and **EROFS** on write, then it is unmounted;
3. the read-only and writable checks refuse the wrong state;
4. `maps_outside` refuses inside a namespace.

**ResourceWarning hygiene:** every `open` is in a `with`, subprocesses are reaped, and `run_capture` closes its fd and pipe in `finally`.

## Safe test commands (root; normal queue; no build, no part data)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh bsro-r8-guard-tests 256 unshare -Urn  bash base-state-readonly-stage/r8/jobs/guard-tests.sh   # expect PASS (10/6/11)
bash jobs/q-exit-status.sh bsro-r8-ns-tests    256 unshare -Urnm bash base-state-readonly-stage/r8/jobs/ns-tests.sh      # expect PASS (4)
```
**ONLY after all 265 parts are CONFIRMED**, in the exclusive 4096 main lane: `build-outer.sh preflight` first, then `build-outer.sh build`; then `positive.sh` / `fixtures.sh` with the receipt's `guard.outDir` (commands in the README).

## Remaining risks (not hidden)
1. **The guard's 20 GiB cap is sampled** (15 s plus the walk): overshoot is unmeasured. Starting at ≈ 83 GB free, the 40 GiB floor leaves ≈ 40 GB of headroom, and the start check needs ≥ 64 GiB (≈ 14 GB margin).
2. **Only /home/steven and /tmp are read-only.** A tool writing to `/var/tmp` or another root path outside them would not be stopped. TMPDIR, HOME and CARGO_HOME point to /vm, so this is not expected, but it is not enforced.
3. **The read-only binds will FAIL the build if cargo or rustup need to write** the cached store (e.g. an unextracted crate) or the rustup home. That is fail-closed. Run `preflight` mode first to see it early.
4. **Memory:** `-j 4` plus release linking in 4096 MiB may be OOM-killed (fail closed).
5. **Timeouts:** cargo 7200 s and the guard 7500 s are unmeasured for a reth release build (rc 72).
6. **Kept scratch:** the guard keeps its /vm run dir (scratch, target, binaries) until root removes it.
7. **An abandoned capture** (a holder outside our group after 120 + 30 s) stops reading and is never a success. A process in D-state has no bound.
8. **Fingerprint equality:** if anything changed between the outer and inner gates (nothing should; the main lane is exclusive), the inner gate refuses.
9. **Test 11 needs the real toolchain and cached store present** (read-only use) and network-less execution (the guard-tests job runs under `unshare -Urn`).
10. **A successful build plus fixtures proves the compiled helper on synthetic fixtures only:** no production database, canonical state or RPC claim.
