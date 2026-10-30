# capture-namespace-qualification-stage/r1 (PREPARED by Claude 1895; NOT run; NOT PASS)
**What it is:** an ACTUAL namespace test, narrowly scoped to `state-fixture-capture-stage/r3`'s read-only path set. That set is `/home/steven`, `/tmp`, `/var/tmp`, `/dev/shm` and `/run/user/<uid>` (review 1884 B1; author 1889 U1).

**What it reuses (byte-pinned):** the r12 `jobs/ns.sh` `ns_harden` and `bsro_gate.ns_checks`/`ro_tree_ok`, r3's `inner.sh` loop (verbatim) and r3's `capture.ro_paths`.

**Scope:** no fixture, build, helper, capture, part, backup or original. Report: `../../logs/claude-capture-r3-review-ns-1895.md`.

## What the actual job proves (jobs/ns-qual.sh; MAIN lane 512, normal queue, no recovery-driver hold)
1. **OUTSIDE, before any clone (`cnq.py precheck`):**
   - the pins hold;
   - all five roots exist and are not symlinks (a missing root is a refusal; no skip-as-pass);
   - **no stage mount anywhere, and no FUSE mount at or under a root** (desktop `fuse.portal`/`fuse.gvfsd-fuse` under `/run/user/<uid>` are tolerated). A recursive read-only bind would otherwise clone and pin a peer's or a session's view, e.g. an `nbdfuse` of the original.
   - Then it creates a NEW 0700 work dir on /vm (253:1).
2. **INSIDE `unshare -Urnm` (`jobs/ns-inner.sh`):**
   - it runs r3's loop verbatim, plus the same loop body over an existing-dir symlink in WORK, which must refuse with rc 9;
   - then `ns_harden` exactly as r3, then a bash here-document of 8 KiB with `/tmp` read-only and `TMPDIR` unset (`positive.sh` feeds python a ~6 KiB here-document);
   - then `cnq.py inside`:
     - `ns_checks` over the set + both stage dirs (ro) and WORK (rw);
     - the bash set == r3 `ro_paths(uid)` == the expected 5;
     - an `O_CREAT` probe in EVERY root must fail with EROFS (an unexpected success is removed at once and FAILS);
     - a write in WORK must succeed.
   - It holds the namespace until RELEASE (≤ 120 s).
3. **The PARENT, while the namespace is alive (`cnq.py parent`):** every root is still writable for the parent (`statvfs` not RO + `W_OK`), and the parent's mount table at the roots is unchanged.
4. **ONE receipt** (`capture-ns-qual-receipt/r1`, bound to SUMS): pass only if every check of every root held.

**Writes:** tiny probe/marker files and a symlink in the /vm work dir (kept), plus KB logs in `runs/`.

## Commands (root)
```
bash jobs/q-exit-status.sh cnq-r1-unit 256 unshare -Urn bash capture-namespace-qualification-stage/r1/jobs/tests.sh   # Ran 8, OK
bash jobs/q-exit-status.sh cnq-r1 512 bash capture-namespace-qualification-stage/r1/jobs/ns-qual.sh                   # receipt pass
```
