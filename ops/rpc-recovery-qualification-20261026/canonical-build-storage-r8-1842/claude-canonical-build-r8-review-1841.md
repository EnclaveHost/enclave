# 1841: independent source review of base-state-readonly-stage/r8 (author 1839). Source review only; NO r8 test, namespace or build has run; nothing is PASS

**Scope:** read-only.
- **What I read:** `jobs/bsro_gate.py`, `build.sh`, `build-outer.sh`, `ns.sh`, `env.sh`, `build-inner.sh`, `ns-tests.sh`, `guard-tests.sh`, `positive.sh`/`fixtures.sh` (the gate lines), `tests/test_bsro_gate.py` and `tests/test_ns.py`, against r7 and report 1839.
- **The one observation beyond source:** I read `/proc/self/mountinfo` and `findmnt /tmp`, and ran `mount --version` (read-only, nothing mounted).
- **Not done:** tests, builds, queue jobs, namespace or scope changes, part/original reads, network, installs, commits or edits to r8.

| item | sha256 |
|---|---|
| r8 `SHA256SUMS` (22 entries, `sha256sum -c` OK; r7 unchanged) | `49a41e28764267797bd0046b90eb193cbfdba57ed3703c8737d96fbb0868c4e9` |
| `jobs/bsro_gate.py` | `96e1b2635b169be92ad7894eec626714e46681f0c5195ff174fba4c59da59d5c` |
| `jobs/build.sh` | `896a26b3aae9da9ae98eb75804f9bd9a2c6bb8b016a7db2cedd837ec9a2d541a` |
| `jobs/ns.sh` | `cf5c37ff32bc446e8dda64db275f7edc90cc494490502680b3178a765f5189f9` |
| `jobs/build-outer.sh` / `env.sh` / `build-inner.sh` | `d56d52c2…` / `7abd63cc…` / `a7b10d1a…` |
| `tests/test_bsro_gate.py` (11) / `tests/test_ns.py` (4) | `4976bbec…` / `55d1daff…` |
| unchanged from r7 (`cmp` OK): `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml`, `jobs/disk_guard.py` (= r5), `jobs/mount_identity.py`, three r7 tests | |

## Production blocker (concrete, fail-closed, not caught by the prepared tests)
**PB1. `ns_harden /home/steven` will fail on this host while mounts exist below `/home/steven`** (`jobs/ns.sh:9`, called at `jobs/build.sh:30`).
- **The evidence:** read-only mountinfo now shows persistent mounts **under** `/home/steven`:
  - `…/2026-10-26/my/work/tr004-readonly` (`fuseblk /dev/sda2`, ro: the USB original);
  - `…/2026-10-26/my/work/tr004/l1-files` (`fuse.ext4`, ro).
- **They are not stage mounts,** so `no_live_sessions()` (`STAGE_MARKERS`, `bsro_gate.py:48, 247-250`) does not refuse them. They are expected to persist after preservation (the preservation-run FUSE mounts under `recovery-multipart-stage/r3/runs/…` are refused by the outer gate).
- **Why the bind fails:**
  - after `unshare -Urnm`, mounts inherited from the more-privileged namespace are **locked**;
  - the kernel refuses a **non-recursive** bind of a path that has locked child mounts (`do_loopback`/`open_tree` → `has_locked_children` → EINVAL);
  - `mount --bind "$d" "$d"` is non-recursive, so `ns_harden` returns 1 and `build.sh` exits 9 ("namespace hardening failed").
- **Consequence:** fail-closed, never an unsafe write, but the production build **cannot start** on this host.
- **Why `test_ns` cannot detect it:** it hardens only a fresh `TEST_TMP` directory with no inherited submounts (`tests/test_ns.py:40-64`; the docstring says /home/steven and /tmp are never bound there).
- **Minimal fix:**
  - **(a) Bind recursively and make the whole bound tree read-only.** `mount --rbind "$d" "$d" && mount -o remount,bind,ro=recursive "$d"` (util-linux 2.42.4 here supports recursive attributes via `mount_setattr`). Or refuse unless every mount at or under `d` is already ro.
  - **(b) Extend `inner-gate`'s check.** Besides `statvfs` of the listed paths (`bsro_gate.py:166-173`), require every mountinfo entry at or under each `--ro` root to have the `ro` mount option.
  - **(c) Add one `test_ns` case** that runs `ns_harden /home/steven /tmp` in the test's own private namespace (namespace-only, harmless) and asserts both are read-only. That exercises the real locked-submount and tmpfs case.
- **Related, unverified, and covered by (c):**
  - `/tmp` is `tmpfs rw,nosuid,nodev`. Inside a user namespace those flags are locked, so `remount,bind,ro` must keep them. With libmount 2.42 (fd-based mount API) that should succeed, but no prepared test proves it.

## Minor findings (actionable, non-blocking)
**m1. `run_capture` never checks the grace or hard bounds while data keeps arriving** (`bsro_gate.py:291-301`).
- **Where:** the `if b: … continue` path skips the leader-exit, grace and kill checks.
- **The effect:** a descendant that keeps writing to the pipe after the leader exited would keep the loop running indefinitely, and `total` keeps growing.
- **Fix:** evaluate the leader-exit, grace, kill and hard checks every iteration, independent of whether data was read.

**m2. A signal window between `Popen` and the handler installation** (`bsro_gate.py:271` vs `284-285`).
- **The effect:** an outer SIGTERM in that window kills the outer with the default action, leaving the child un-owned.
- **Fix:** install the forwarding handlers (with "pending until `p` exists") or block the three signals around `Popen`.

**m3. Holders outside our process group are only abandoned** (`bsro_gate.py:304-311`).
- **What happens:** after the SIGKILL of `build.sh`'s group, any holder outside it keeps running. That includes `disk_guard.py`'s own build group, which is a separate session, if the guard died abnormally. The outer is not a subreaper.
- **The result:** abandonment is recorded and never a success, but the processes are not ended.
- **Options:** become a subreaper and reap adopted orphans (the r9/r6 pattern), or document that the queue's own tree kill is the backstop.

**m4. The trap is installed late** (`build.sh:34`): the `trap ':' TERM INT HUP` comes after the r7 checks, `ns_harden` and `inner-gate` (which runs the completion scan).
- **The effect:** a forwarded TERM during those steps kills the shell immediately (rc 143, preserved as nonzero). That is acceptable because nothing has started yet, but it is worth stating.

**m5. `verify_binaries` compares `os.path.normpath(bin_dir)` with the receipt's `/vm` `outDir`** (`bsro_gate.py:442`).
- **The effect:** passing the root `runs/build-*/out` symlink is refused (fail-closed).
- **Fix:** make the jobs and README always name the `/vm` path, or compare `realpath`.

## Checked and sound (source)
**`run_capture`'s ownership and reaping:**
- the child is its own session and process group;
- the forward sends one SIGTERM to that group, and only while the leader is unreaped (`waitid WNOWAIT`);
- the SIGKILL goes to our group only;
- there is a single `p.wait()` reap; the rc is propagated; and `abandoned` is never verified.

**The cancellation path:** a forwarded TERM reaches `build.sh` (trap `:`, a handler not SIG_IGN) and `disk_guard.py` (its handler stops its own build group), giving rc 73. bash defers the trap until the foreground guard returns, so the rc reaches the receipt.

**Gate ordering:**
- **Outer:** SUMS (in `build-outer.sh`), then `qualified` (both r8 receipts exact), then the initial user namespace and non-root uid/gid, then the 4096 lane + floor, then the root floor, then no live sessions or stage mounts, then the completion check. Only after that does it create the metadata dir and capture.
- **Inner:** the r7 checks and `qualified`, then the `/vm` identity, then `ns_harden`, then `inner-gate` (exact `0 → outer uid/gid`, 1 id, `setgroups deny`, private propagation, read-only and writable checks, the completion fingerprint == the outer one), then the trap and the unchanged r7 guard command.

**The all-265 gate (metadata only):** the pinned 1773 runner (verifies frozen r3) plus core == `3159890b…`; `status()` on manifest `f94807f7…` with 265/265/265, both complete flags and empty lists; 0 remaining on root and vm via `part_state` (record + current identity). It reads records, verify/session JSON and `lstat` only, never part bytes. Inside the namespace, the owner maps to 0, so `open_dir`'s owner check still means "our files".

**Pinned receipts and runtime:**
- `qualified()` requires the exact suites 10/6/11 and 4 bound to these SUMS;
- the r5 guard is `cmp` + r5 SUMS;
- `authenticate()` matches the guard's single `## disk-guard run dir` line (`disk_guard.py:139`, printed early, so inside the 1 MiB kept capture), a `run-*` child of the pinned BASE, 0700, ours, on the BASE device, with `guard-receipt.json` naming it;
- the binaries are 0555 regular files on `/vm`, hashed in place == `accounting.json` with verdict ok.

**Resources and metadata:**
- root files: `build-output.txt` ≤ 1 MiB (bounded reader), `receipt.json` ≤ 1 MiB (`write_new`), one symlink, and the positive/fixtures per-case files ≤ 1 MiB (`head -c`);
- the root floor (40 + 8 GiB + 16 MiB) is checked before and after the run;
- the scratch, outputs, TMPDIR (exported and in `env -i`) and accounting are all in the guarded `/vm` run dir;
- the guard limits are r7's (64 GiB start, 40 GiB floor, 20 GiB sampled cap, 7500 s).

**Compiler limits:** no file-size rlimit on the child, `cargo --offline -j 4`, the 7200 s cargo timeout inside the 7500 s guard, and the 4096 MiB cgroup. An OOM or failed build is a nonzero rc, never a success.

**USB:** nothing writes to `/mnt/usb` or the original. The original's ro mount stays ro, and with fix PB1(a) it would be covered recursively anyway.

## Readiness of the prepared unit and namespace tests (source review)
**`guard-tests.sh`** (`unshare -Urn`, 256 small lane):
- the 10 + 6 unchanged suites plus `test_bsro_gate` (11) use only synthetic stages and receipts, `TEST_TMP`, fake bases and owned subprocesses (`sleep`, `setsid sleep`, which the test kills itself);
- `rustc -V`/`cargo -V` (test 11) do no compilation;
- **no test calls `outer`, `live_completion` or `no_live_sessions`,** so no preservation targets, sessions or `/vm` are touched;
- the footprint is small Python processes.

**Fits the 256 small lane** beside the recovery's 4096 reservation and the 16 GiB floor.

**`ns-tests.sh`** (`unshare -Urnm`, 256): the binds are made only on `TEST_TMP` dirs inside the test's private mount namespace (`make-rprivate` first; unshare's default propagation is private too), so there is **no host effect.** It fits the 256 lane.

**But** it does not cover PB1; add the test in PB1(c).

**Not proven by any prepared test:** a real build, real `/home/steven` and `/tmp` hardening, cargo working with a read-only cached store (an extraction into the read-only store would fail closed), and memory use under 4096 MiB.

## Verdict
- **The unit and namespace tests can be queued in the 256 small lane** (root runs them; no result is claimed here).
- **The production build stays forbidden** until full preservation, and in any case **PB1 must be fixed first.** As written, `ns_harden /home/steven` fails on this host because of the inherited locked submounts (fail-closed, but the build cannot start).
- m1–m5 are minimal, non-blocking improvements.
