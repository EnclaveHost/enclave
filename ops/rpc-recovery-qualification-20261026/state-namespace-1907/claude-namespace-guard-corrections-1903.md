# 1903: namespace-launch-guard-stage/r2 = r1 + root 1903 corrections (SOURCE ONLY; nothing run)

**What I did not do:** run tests, queue jobs, mounts or builds; touch data or the network; commit; launch production.

**Frozen and still verifying:** r1 (`674385ce…`), bsro r12, capture r3 and cnq r1, all unmodified.

**The actual r1 unit run** (`r1/runs/tests-20261027T111423Z-3130767`) gave 9 tests, 8 PASS and 1 FAIL:
- **test 3:** a build dispatched with fuseblk on `/var/tmp`, outside the build's RO roots;
- **stdoutEmpty false:** the mocked dispatch prints on purpose.

## Stage
- **SHA256SUMS sha256:** `namespace-launch-guard-stage/r2/` → **`53aa2ac9c0e55d6fe884c617744c6e99d4d24d9f933500c2cedf307b599244ee`**
- **Contents:** 4 files, all a-w.

| file | sha256 |
|---|---|
| `guard.py` | `5972c65f0f98fa844669b144b203cf01b16998577d087d56ce8743605470ece8` |
| `tests/test_guard.py` | `7ec9c06931cc280da64b97cf3744c54eb9cb2f1f7c9fada3da6fc34a490f11c6` |
| `jobs/tests.sh` | `a044ce3ab879f02a717862f862682659b399f529e703b42b4b3fa7f8caf72583` |
| `README.md` | `c2b8117481e6ea8777403e081447afefd46b96821d6bd39efae01e070ec09d0f` |

**Pins (unchanged from r1):**
- **Stage SUMS:** r12 `2911943d…`, capture r3 `f5424d11…`, cnq r1 `ba3ee32d…`.
- **Loaded code:** `bsro_gate` `0641637a…`, capture `81ddd643…`, cnq `66e715ee…`.
- **Entries:** `build-outer.sh` `ad46ca16…`, `run.sh` `822788a2…`.
- **Actual receipts:** r12 guard `8038eebe…`, r12 ns `90a01d77…`, r3 tests `5fa5224c…`.
- **The cnq namespace-qualification receipt:** still **PENDING**, discovered strictly, never fabricated.

## Corrections
1. **The whole namespace is checked (root: `unshare -m` clones the WHOLE mount namespace).**
   - **The new check:** `all_namespace_hazards(mountinfo, uid, STAGE_MARKERS, Q)` uses the pinned `cnq.mounts`/`under`/`STAGE_EXTRA`. It is applied to BOTH routes after the existing root-scoped `cnq.clone_hazards`. It refuses:
     - any `fuse`, `fuse.*` or `fuseblk` mount ANYWHERE;
     - except `fuse.portal`/`fuse.gvfsd-fuse` at or under the **actual** `/run/user/<uid>` (`under()`: exact or with a `/` boundary, so `/run/user/10000` does not match `/run/user/1000`);
     - and any of our stage mounts anywhere.
   - **The record** carries `allNamespaceHazards: []`. A non-int or bool uid refuses.
2. **The discovered cnq receipt.**
   - **Parsing:** `strict_json` requires UTF-8 and an object, with no duplicate keys and no NaN/±Infinity. A malformed receipt is skipped, and if none qualifies the result is a "PENDING" refusal.
   - **Acceptance (`cnq_receipt_errors(r, uid, roots, Q)`)** requires all of:
     - **the pinned `Q.receipt_pass(inside, parent, uid) == []`** (every root's EROFS probe, ns_checks, WORK writable, symlink refusal, heredoc, every root parent-writable, mounts unchanged, inner alive, bash/r3/expected set);
     - exact format `capture-ns-qual-receipt/r1`, `pass is True`, `reasons == []`;
     - `stageSums ==` the cnq pin;
     - **`pins ==` the pinned cnq PINS, all of them**, and those equal this guard's r3/r12 pins;
     - `inside.set == inside.r3RoPaths ==` this host's r3 `ro_paths(uid)`.
3. **Test output:** `go()` captures the guard's own stdout/stderr (`redirect_stdout`/`redirect_stderr`) and asserts on it. Nothing else is suppressed, so unittest failures and the `stdoutEmpty`/`lastLineOK`/bad-marker job checks are unchanged.

## Prepared tests (NOT run): 12 = r1's 9 + 3 (`nlg-r2-unit`, 256, `unshare -Urn`, mocked `execve`)
**Kept:**
- **1** pins;
- **2** exact build argv + record;
- **3** observed hazards incl. fuseblk `/var/tmp`, which now refuses the build too;
- **4** symlinked/missing roots;
- **5** capture PENDING;
- **6** exact capture argv (complete synthetic cnq fixture in a temp dir) + hazards;
- **7** the cnq predicate (complete fixture accepted; format, pass, pass=1, reasons, stageSums, one pin, empty pins refused);
- **8** strict arguments;
- **9** AST, a single `execve`.

**New:**
- **10:** FUSE refuses BOTH routes, nothing dispatched, "REFUSED" on stderr, for each of:
  - `/opt/peer` `fuse.nbdfuse`;
  - `/var/tmp/q` `fuseblk`;
  - `/mnt/x` `fuse.sshfs`;
  - `/media/u` `fuseblk`;
  - `/opt/peer/v` `fuse`;
  - `fuse.portal` under `/run/user/1001` or at `/opt/doc`;
  - `fuse.sshfs` under `/run/user/1000`;
  - `fuse.gvfsd-fuse` under `/run/user/10000`;
  - a recovery stage mount on `/srv`.

  The desktop `fuse.gvfsd-fuse` + `fuse.portal` under `/run/user/1000` dispatch both routes, with clear true. A bool uid refuses.
- **11:** every meaningful probe and parent check is required, each mutation alone must be rejected:
  - each root's probe as `errno 13`, `CREATED` or missing;
  - each root parent-writable as false or missing;
  - `nsChecks`/`workWritable`/`symlinkRefused`/`heredocOk` false;
  - `mountsUnchanged`/`innerAlive` false;
  - `bashSet` short, the set reordered, the parent or inside phase dropped.

  The complete fixture gives [].
- **12:** strict JSON: a duplicate key, NaN, Infinity, a non-object and invalid UTF-8 each raise, and are refused as PENDING at discovery.

**The synthetic cnq receipts exist only in temp dirs** and are never an actual qualification.

## Commands (root)
```
bash jobs/q-exit-status.sh nlg-r2-unit 256 unshare -Urn bash namespace-launch-guard-stage/r2/jobs/tests.sh     # expect Ran 12, OK, receipt pass
# NOT now: production only after the coordinated cleanup (no FUSE anywhere but desktop under /run/user/<uid>), all 265 CONFIRMED,
# and (capture) an actual passing cnq r1 run:
bash jobs/q-exit-status.sh bsro-r12-preflight 4096 python3 -I -B namespace-launch-guard-stage/r2/guard.py build-preflight
bash jobs/q-exit-status.sh bsro-r12-build     4096 python3 -I -B namespace-launch-guard-stage/r2/guard.py build
bash jobs/q-exit-status.sh sfc-r3-positive 512 python3 -I -B namespace-launch-guard-stage/r2/guard.py capture-positive <BD>
bash jobs/q-exit-status.sh sfc-r3-fixtures 512 python3 -I -B namespace-launch-guard-stage/r2/guard.py capture-fixtures <BD>
```

## Limits (unchanged except where noted)
- **cnq r1's own precheck is root-scoped:** its `clone_hazards` checks only the roots plus stage mounts, so it does not refuse a FUSE mount outside the roots (e.g. `/opt/peer`) before its own `unshare -m`. I did not change frozen cnq. **The cnq namespace qualification should be run only when root has confirmed there is no non-desktop FUSE mount anywhere**, which is the same condition this guard enforces for build/capture.
- **The check-to-dispatch race and local-evidence scope** are as in 1901. The pending namespace qualification, all 265, resource and lane gates are preserved (the entries' own gates run after `execve`).
- **Not a build, capture, state or acceptance result.**
