# 1895: independent review of state-fixture-capture-stage/r3 (vs 1884/1889) + a prepared capture-namespace-qualification-stage/r1 (SOURCE ONLY)

**What I did not do:** run tests or queue jobs; mount or create a namespace; build; use the network; access data, backup or parts; commit.

**What I read:**
- capture r3 (SUMS `f5424d11…`, verified intact): `jobs/inner.sh`, `jobs/run.sh`, `capture.ro_paths` and its uses;
- reports 1884, 1886 and 1889;
- the pinned r12 `ns.sh` and `bsro_gate.ns_checks`/`ro_tree_ok`.

**Frozen stages are preserved:** r3 and r12 still verify.

**Nothing here is a PASS, a capture qualification or acceptance.**

## Review of capture r3: blockers first
**R1 (BLOCKER for any r3 capture run): the ns clone hazard of peer/session FUSE views is not refused.**
- **What r3 hardens:** `inner.sh` runs `ns_harden` (`mount --rbind -o ro=recursive`) over `/home/steven`, `/tmp`, `/var/tmp`, `/dev/shm` and `/run/user/<uid>`. That **clones every mount below them** into the capture namespace for the whole run (positive: up to 12600 s).
- **What r3 refuses beforehand:** `precheck` → r12 `no_live_sessions` checks only OUR stage markers (`STAGE_MARKERS`) and our session processes.
- **What it misses:** a peer's FUSE view, e.g. HANDOFF's `nbdfuse -r` view of the original or backup under `/home/steven/Documents/Codex/2026-10-26/my/work/tr004/…`, would be cloned. While our namespace lives, that FUSE connection stays referenced. A peer `fusermount3 -u` then detaches only their copy, and their `nbdfuse`/`qemu-nbd` cannot finish. HANDOFF says never to unmount or kill peer resources, and pinning them for hours is the same class of harm.
- **The same applies to bsro r12 `build.sh`'s `ns_harden /home/steven /tmp`.**
- **Fix (smallest), in both r3 `precheck` and the build gate:** refuse before `unshare` if ANY FUSE mount (`fuse`, `fuse.*`, `fuseblk`) is at or under a root, tolerating only `fuse.portal`/`fuse.gvfsd-fuse` under `/run/user/<uid>`. Plus any of our stage mounts anywhere.
- **Reference implementation:** `cnq.clone_hazards` in the new stage (unit test 3).

**R2 (BLOCKER): the extended RO set has never run.** The author states this (1889 U1). The r12 ns-tests cover only `/home/steven` and `/tmp`. The concrete risks:
- `mount --rbind -o ro=recursive` of `/dev/shm` and `/run/user/<uid>` (which may hold FUSE submounts) inside a user namespace;
- `ro_tree_ok` over them;
- bash here-documents with `/tmp` read-only: `positive.sh` pipes a ~6 KiB here-document to python, and `TMPDIR` is unset after `env -i`.

**Prepared:** `capture-namespace-qualification-stage/r1` (below). No r3 capture should run before its receipt passes.

**R3 (should fix): `precheck` does not check the r3 path set outside.**
- `inner.sh` decides the set (exists / not a symlink) only inside the namespace, after `unshare`.
- A symlinked `/var/tmp` etc. is refused there (rc 9), which is fail-closed, but only after a namespace was created.
- **Fix:** run `ro_paths(uid)` in `precheck` too, and record the set in the precheck output.

**R4 (note): live-run risks the namespace test cannot cover.**
- **utab/stderr noise:** `positive.sh`'s `mount --bind`/`remount` inside the hardened namespace may emit libmount utab warnings (`/run/mount` is not hardened but is root-owned). Any stderr line breaks the exact capture parser (fail-closed: a false failure).
- **What the namespace test covers:** read-only, the parent stays writable, and here-docs. Only the first live `sfc-r3-positive` will show this.

**R5 (accept, documented by 1889 U2):** the B1 set is not exhaustive (`/dev/mqueue`, abstract sockets, other uid-writable paths).

**Verified OK in r3 (source):**
- `inner.sh` pins r12 SUMS / `ns.sh` / its own SUMS before `source`, and refuses a symlinked extra root (rc 9);
- the bash set and `capture.ro_paths(uid)` agree by construction: `lexists`/`islink` vs `[ -e ]` after `[ -L ]` refuses symlinks;
- `ns_checks(mi, [*set, R12, HERE], [BD], set)` runs before and after, and `roStillOk` also requires `ro_paths(uid) == ro_list`;
- `precheck` runs outside before `unshare`;
- the 1886 false positive is fixed by the quote-aware `shell_code` + test 15 (as described in 1889; I did not re-trace the tokenizer).

## Prepared: capture-namespace-qualification-stage/r1 (the actual namespace test of r3's set)
- **SHA256SUMS sha256:** **`ba3ee32d3d052b3ed79f1593b4318d52d933b68aa0471070db7a09c564486fd4`**
- **Contents:** 6 files, all a-w.

| file | sha256 |
|---|---|
| `cnq.py` | `66e715ee2ce6233aeb532cded94adc47a61aff1f70d7c5b759feba6115db0809` |
| `jobs/ns-qual.sh` | `c0cbe65a3d72024f280ae2c2ae53024155e8d08a7fc468067ac9932bd88a0a06` |
| `jobs/ns-inner.sh` | `9189ca1a349a684388473fb5e2384e5eee2f381ecf81541c694dc7ca0a24add2` |
| `jobs/tests.sh` | `387e159a6add3fbc1b5249468c4f3d1bc3fb7734d92591685107595b7986271e` |
| `tests/test_cnq.py` | `72832eff66750378bb095c0e8d861399f00c201e9d680646bdd5cfc661f9763a` |
| `README.md` | `6513c97a94cb12cb1f5c93c6885b1c0cd6d6b79c9db52121428f372b0730d879` |

**Pins (in `cnq.py`, `ns-inner.sh`):**
- r12: SUMS `2911943d…`, `bsro_gate.py` `0641637a…`, `ns.sh` `b8b4560c…`;
- capture r3: SUMS `f5424d11…`, `capture.py` `81ddd643…`, `jobs/inner.sh` `51bc15a9…`.

**The job (`jobs/ns-qual.sh`, MAIN lane 512, normal queue, no recovery-driver hold; the private namespace is invisible to the driver):**
1. **OUTSIDE (`cnq.py precheck`), before any clone:**
   - the pins hold;
   - **all five roots exist and are not symlinks** (missing = refusal; no skip-as-pass);
   - **no stage mount anywhere and no FUSE mount at/under a root** (the R1 rule);
   - a NEW 0700 work dir `/vm/enclave-volumes/tr004-base-recovery-20261026/capture-ns-qual-<UTC>-<pid>` on 253:1.
2. **INSIDE (`unshare -Urnm bash jobs/ns-inner.sh`):**
   - re-checks the pins;
   - `source`s the pinned r12 `ns.sh`;
   - runs **r3's loop verbatim** (unit test 5 requires the text to be byte-identical to r3's);
   - runs **the same loop body over an existing-dir symlink** created in WORK, which must exit 9;
   - **`ns_harden $RO` exactly as r3**;
   - runs an 8 KiB here-document with `/tmp` read-only and no `TMPDIR`;
   - then `cnq.py inside`:
     - the pinned r12 `ns_checks(mi, [5 roots + r3 dir + r12 dir], rw=[WORK], ro_roots=5 roots)`;
     - **bash set == r3 `ro_paths(uid)` == the expected 5**;
     - an **O_CREAT probe in each root must fail with EROFS** (an unexpected success is unlinked at once and FAILS);
     - a write in WORK must succeed.

   It writes HARDENED and holds until RELEASE (≤ 120 s; no kill).
3. **The PARENT, while the namespace is alive (`cnq.py parent`):** each root is still writable for the parent (not ST_RDONLY + `W_OK`), the parent's mount table at the roots is unchanged, and the inner pid is alive. Then RELEASE and `wait` (trap `TERM INT HUP`: the evidence is still taken).
4. **The receipt (`capture-ns-qual-receipt/r1`, SUMS-bound)** passes only if every check of every root held. The job rc is 4 if the inner or parent rc ≠ 0, or if a mount of WORK is visible in the parent.

**Writes:** tiny files and a symlink in the /vm work dir (kept), plus KB logs in the stage `runs/`.

**Unit tests (8, pure; `cnq-r1-unit`, 256, `unshare -Urn`):**
1. the pins;
2. the set == pinned r3 `ro_paths` (incl. r3's own symlink refusal and missing-skip, which this job refuses);
3. `clone_hazards`: desktop FUSE under `/run/user` tolerated; FUSE under the other roots, sshfs under `/run/user`, and stage mounts refused;
4. the receipt predicate (every root, every check, both phases; 13 mutations);
5. r3's loop is verbatim and the symlink probe reuses its body;
6. the inner order;
7. the outer order + lane + no kill/umount/fixture;
8. the work-dir shape.

**Commands:**
```
bash jobs/q-exit-status.sh cnq-r1-unit 256 unshare -Urn bash capture-namespace-qualification-stage/r1/jobs/tests.sh   # Ran 8, OK
bash jobs/q-exit-status.sh cnq-r1 512 bash capture-namespace-qualification-stage/r1/jobs/ns-qual.sh                   # receipt pass
```

## Limits (stated)
- **No real symlinked system dir is tested:** a real symlinked `/var/tmp`/`/dev/shm`/`/run/user/<uid>` cannot be created without host changes. The refusal is proven by r3's exact loop body over a WORK symlink (only the list substituted) and by r3's Python `ro_paths` with injected fakes.
- **The R1 rule is conservative:** with any non-desktop FUSE mount under `/home/steven` (e.g. a peer's view during preservation), this job and a fixed r3 refuse until it is gone. This is intended; it blocks rather than pins.
- **R4 (utab/stderr in the live capture) is not covered** by a namespace-only test.
- **A pass qualifies only the hardening of r3's path set on this host.** It is not a fixture, build, capture, state or acceptance result.

## Order (no claims)
1. `cnq-r1-unit`, then `cnq-r1` (when there is no FUSE view under the roots).
2. A capture r4 with R1 + R3 (the same `clone_hazards` in `precheck`) and the r12 build gate's equivalent. I did not make that change; capture r3 and bsro r12 are frozen.
3. The remaining capture prerequisites as in 1889.
