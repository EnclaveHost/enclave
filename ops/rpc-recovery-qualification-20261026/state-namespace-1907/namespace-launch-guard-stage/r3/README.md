# namespace-launch-guard-stage/r3 (PREPARED by Claude 1901/1903; NOT run; NOT PASS)
r2 = r1 (`674385ce…`, kept frozen) + root 1903. r1's actual unit run (`r1/runs/tests-20261027T111423Z-3130767`) gave 8/9: test 3 dispatched a build with fuseblk on `/var/tmp`, and stdout was not empty.

**The changes:**
- **The whole namespace is checked:** `unshare -m` clones the WHOLE mount namespace, so BOTH routes now also refuse ANY FUSE/fuseblk mount ANYWHERE (`all_namespace_hazards`, using the pinned `cnq.mounts`/`under`/`STAGE_EXTRA`).
  - **The only exception:** `fuse.portal`/`fuse.gvfsd-fuse` at or under the ACTUAL `/run/user/<uid>`.
  - **Stage mounts always refuse.** The root-scoped pinned `cnq.clone_hazards` is kept as well.
- **The discovered (unpinned) cnq receipt** is parsed strictly (`strict_json`: UTF-8, no duplicate keys, no NaN/±Infinity, an object). It is accepted only if the pinned **`cnq.receipt_pass(inside, parent, uid)` == []** (every probe, every parent check, both phases) and format, pass, reasons, stageSums and **all** cnq pins are exactly the pinned ones.
- **Tests:** the guard's own output is captured inside `go()` only. The test count goes from 9 to **12**: r1's 9, with test 7 using a complete fixture, plus 10 (all-namespace FUSE for build AND capture, and the desktop exceptions), 11 (every probe/parent mutation) and 12 (strict JSON at the discovered boundary).
- **Command:** `bash jobs/q-exit-status.sh nlg-r3-unit 256 unshare -Urn bash namespace-launch-guard-stage/r3/jobs/tests.sh` (expect Ran 12, OK, receipt pass). Production commands as below, with `r2/guard.py`.

# (r1 text, routes unchanged)
# namespace-launch-guard-stage/r1 (PREPARED by Claude 1901; NOT run; NOT PASS)
**What it is:** a SMALL outer launch guard for review 1895 R1/R3, with no new revision of the frozen stages.

**What it adds:** `guard.py ROUTE [BD]` runs OUTSIDE any namespace and refuses (rc 3, no process created) unless every check below holds. It then `os.execve`s EXACTLY the pinned entry (same pid; queue semantics unchanged; the entry's own guards all still run):

| route | exact argv |
|---|---|
| `build-preflight` / `build` | `/usr/bin/bash <bsro r12>/jobs/build-outer.sh preflight\|build` |
| `capture-positive BD` / `capture-fixtures BD` | `/usr/bin/bash <capture r3>/jobs/run.sh positive\|fixtures BD` (BD = `/vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out`) |

**The checks:**
1. **Pins:** every pinned stage verifies file by file: r12 `2911943d…`, capture r3 `f5424d11…`, cnq r1 `ba3ee32d…`, and this stage. The entry scripts and the loaded code (r12 `bsro_gate` `0641637a…`, r3 `capture.py` `81ddd643…`, cnq `cnq.py` `66e715ee…`) equal their pins.
2. **Actual receipts (re-hashed; no invented receipt):**
   - **build:** the r12 guard-tests `8038eebe…` and ns-tests `90a01d77…`, both pass, stageSums r12;
   - **capture:** the r3 18-test receipt `5fa5224c…`, plus a PASSING actual cnq r1 ns-qual receipt for this host's r3 `ro_paths(uid)`. **None exists yet: PENDING → refused.**
3. **Roots (R3):** build → r12 `RO_ROOTS` (`/home/steven`, `/tmp`); capture → r3 `ro_paths(uid)` (its own symlink refusal). Each must be present, a directory, and not a symlink.
4. **Clone hazards (R1), with the pinned `cnq.clone_hazards`:** no stage mount anywhere, and no FUSE/fuseblk mount at or under a root. Only desktop `fuse.portal`/`fuse.gvfsd-fuse` are tolerated, and only under `/run/user/<uid>`.
5. **The record:** `runs/<route>-<UTC>-<pid>.json` (O_EXCL), containing the roots, the clear check, the receipt shas and the argv.

**Today it refuses:** the observed fuseblk `…/2026-10-26/my/work/tr004-readonly` and the active recovery-stage FUSE views are hazards. **Wait for the coordinated cleanup after all 265.** The guard never detaches, unmounts or kills anything. There is no driver hold.

**The residual race:** a peer mount appearing between this check and the entry's own `ns_harden` would still be cloned. That race closes only with the coordinated "no peer mounts during build/capture" window. This is local evidence, not authentication against a malicious owner.

## Commands (root; never automatic; lanes as the original entries)
```
bash jobs/q-exit-status.sh nlg-r3-unit 256 unshare -Urn bash namespace-launch-guard-stage/r3/jobs/tests.sh            # Ran 12, OK
bash jobs/q-exit-status.sh bsro-r12-preflight 4096 python3 -I -B namespace-launch-guard-stage/r3/guard.py build-preflight
bash jobs/q-exit-status.sh bsro-r12-build     4096 python3 -I -B namespace-launch-guard-stage/r3/guard.py build
bash jobs/q-exit-status.sh sfc-r3-positive 512 python3 -I -B namespace-launch-guard-stage/r3/guard.py capture-positive <BD>   # needs cnq ns-qual PASS
bash jobs/q-exit-status.sh sfc-r3-fixtures 512 python3 -I -B namespace-launch-guard-stage/r3/guard.py capture-fixtures <BD>
```
