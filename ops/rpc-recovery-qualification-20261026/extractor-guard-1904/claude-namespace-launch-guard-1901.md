# 1901: namespace-launch-guard-stage/r1, a small outer launch guard for review 1895 R1/R3 (SOURCE ONLY; nothing run)

**What I did not do:** run tests, queue jobs, builds or mounts; touch data or the network; commit.

**Frozen and still verifying:** bsro r12 (`2911943d…`), capture r3 (`f5424d11…`) and cnq r1 (`ba3ee32d…`). All existing pins are unchanged.

**Nothing was detached, unmounted, killed or held.** The observed fuseblk `/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly` and the active recovery-stage FUSE views were not touched, and no namespace test was run over them.

## Stage
- **SHA256SUMS sha256:** `namespace-launch-guard-stage/r1/` → **`674385cebbcbeeca4129e97796ea1c343cc08495e360e1b93ef6e1c81f04cc85`**
- **Contents:** 4 files, all a-w.

| file | sha256 |
|---|---|
| `guard.py` | `bf2943308b241e17ca8f32dd2da0640d42fb6301c086686c26db205a7b1b5fd3` |
| `tests/test_guard.py` | `d78bb21a390d56a2799b38db900e6fba3ca7ec34cd76f8be5966657db0549232` |
| `jobs/tests.sh` | `9ea5ad76c8402b0cfc018ec7987462575cd5a9a2b0d315786ff4d4fc38ff2a52` |
| `README.md` | `5df7737ec4b510c683791094050ef5cd2763f99429973340f8e25721fbd11add` |

## What the guard does (outside any namespace; before dispatch; rc 3 and NO process on any refusal)
- **Strict arguments:** only four routes (`build-preflight`, `build`, `capture-positive BD`, `capture-fixtures BD`). BD must match `/vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out`, normalized. Anything else refuses; no command, flag or path is passed through.
- **Pins, verified file by file:** r12, capture r3, cnq r1 and this stage, against their SUMS.
  - **Code loaded from hashed bytes:** r12 `bsro_gate.py` `0641637a…` (for `RO_ROOTS`, `STAGE_MARKERS`), r3 `capture.py` `81ddd643…` (`ro_paths`) and cnq `cnq.py` `66e715ee…` (`clone_hazards`).
  - **The entry scripts must equal their SUMS entries and pins:** r12 `jobs/build-outer.sh` `ad46ca16…` and r3 `jobs/run.sh` `822788a2…`.
- **Actual receipts (root's runs, re-hashed today; never invented):**
  - **build:** r12 guard-tests `8038eebe…` (10 + 6 + 16) and ns-tests `90a01d77…` (5), both pass, stageSums r12. This is the build's own actual r12 namespace receipt.
  - **capture:** r3 tests `5fa5224c…` (pass, `Ran 18`), plus **a PASSING actual cnq r1 namespace-qualification receipt** (`runs/ns-qual-*/receipt.json`). It must have format `capture-ns-qual-receipt/r1`, pass, no reasons, stageSums == the cnq pin, `inside.set == inside.r3RoPaths ==` this host's r3 `ro_paths(uid)`, and pins equal to r3/r12.
  - **None exists yet → "PENDING" refusal.** The cnq unit run (`runs/tests-20261027T110941Z-3125460`, "Ran 8 tests … OK", `err.txt` `77d39d23…`) is not a namespace qualification and is not consumed.
- **Roots (R3):**
  - **build:** r12 `RO_ROOTS` = `/home/steven`, `/tmp`;
  - **capture:** r3 `capture.ro_paths(uid)` (`/home/steven`, `/tmp` + `/var/tmp`, `/dev/shm`, `/run/user/<uid>` when present, a symlink refusing);
  - each must exist, be a directory, and not be a symlink.
- **Clone hazards (R1):** the pinned `cnq.clone_hazards(mountinfo, roots, r12 STAGE_MARKERS)`. It refuses on any stage mount anywhere (r12 markers + compact-extraction/capture/cnq) and any FUSE/fuseblk mount at or under a root, tolerating only `fuse.portal`/`fuse.gvfsd-fuse` under `/run/user/<uid>`.
- **Dispatch:** it records the roots, the clear check, the receipt shas and the argv in `runs/<route>-<UTC>-<pid>.json` (O_EXCL, KB). Then one `os.execve` of EXACTLY `/usr/bin/bash <entry> <mode> [BD]` with env `PATH=/usr/bin:/bin LC_ALL=C HOME=/home/steven`.
  - **Same pid:** the main-queue semantics (lane, memory guard, the queue's stop) are unchanged.
  - **Every original guard of the entry still runs:** r12 `bsro_gate.outer` (qualified, maps, lane, floors, `no_live_sessions`, all 265, build namespace) or r3 `run.sh` (precheck, `inner.sh` hardening, gates).

## Current expected behaviour
**It refuses:** `/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly` (fuseblk) and the recovery-stage FUSE views are hazards under `/home/steven` or stage mounts.
- **The guard waits** for the coordinated cleanup after all 265 parts (physical originals retained).
- **It never detaches, unmounts or kills anything, and holds no driver.**
- **Capture additionally waits** for an actual passing cnq r1 run (itself only after those mounts are gone).

## The residual race (stated)
The guard checks, then `execve`s; the entry's own `ns_harden` runs later (r12: after `bsro_gate` outer's gates; r3: after `precheck`, inside `inner.sh`).
- **What can slip through:** a peer mount created in that window would still be cloned.
- **How it closes:** only with the coordinated "no peer mounts during build/capture" window. The entry's own `no_live_sessions` re-check narrows it for our stage mounts only.
- **What this is not:** ordinary local evidence on a trusted host, not authentication against a malicious same-user owner.

## Prepared tests (NOT run): 9, mocked `execve` (nothing is ever dispatched)
1. Every pin equals the actual files; the pinned receipts pass.
2. Build/preflight: exactly `["/usr/bin/bash", r12/jobs/build-outer.sh, mode]` + ENV, dispatched once; the record holds roots `/home/steven`, `/tmp` and clear.
3. Hazards refuse before any process and before any record:
   - the observed fuseblk `…/tr004-readonly` shape;
   - a recovery-stage FUSE;
   - `nbdfuse` under home;
   - `fuse2fs` under `/tmp`;
   - fuseblk under `/var/tmp`;
   - a composite stage mount on /vm.
4. A symlinked or missing root refuses before any process (build, and capture via r3's own `ro_paths` refusal).
5. Capture without an actual cnq receipt refuses (PENDING).
6. Capture with a **SYNTHETIC test-only** cnq receipt in a temp dir dispatches exactly `["/usr/bin/bash", r3/jobs/run.sh, kind, BD]`; the record holds the 5 roots; every hazard row still refuses.
7. The cnq receipt predicate: 6 mutations refused.
8. Strict arguments: 11 malformed or injected forms refused, nothing dispatched.
9. AST: no subprocess/shutil/pty/multiprocessing; no `system`/`popen`/`spawn`/`fork`/`execv*` other than the single `execve` in `main`.

## Exact commands (root; never automatic; the lanes of the original entries)
```
bash jobs/q-exit-status.sh nlg-r1-unit 256 unshare -Urn bash namespace-launch-guard-stage/r1/jobs/tests.sh                 # expect Ran 9, OK, receipt pass
# only after the coordinated cleanup (no tr004-readonly fuseblk / recovery FUSE) and all 265 CONFIRMED:
bash jobs/q-exit-status.sh bsro-r12-preflight 4096 python3 -I -B namespace-launch-guard-stage/r1/guard.py build-preflight
bash jobs/q-exit-status.sh bsro-r12-build     4096 python3 -I -B namespace-launch-guard-stage/r1/guard.py build
# then the actual namespace qualification (no FUSE views under the roots): bash jobs/q-exit-status.sh cnq-r1 512 bash capture-namespace-qualification-stage/r1/jobs/ns-qual.sh
bash jobs/q-exit-status.sh sfc-r3-positive 512 python3 -I -B namespace-launch-guard-stage/r1/guard.py capture-positive <BD>
bash jobs/q-exit-status.sh sfc-r3-fixtures 512 python3 -I -B namespace-launch-guard-stage/r1/guard.py capture-fixtures <BD>
```

## Limits
- **The cnq receipt is discovered, not pinned:** it does not exist yet. The guard accepts only a strictly matching passing one and records its sha. A later revision may pin that sha once it exists.
- **The guard does not re-run the entries' own gates** (all 265, floors, lanes); they run after the `execve`, unchanged.
- **Review 1895 R4** (utab/stderr noise in the live capture) and **R5** (the B1 set is not exhaustive) are unchanged.
- **Not a build, fixture, capture, state, canonical or recovery acceptance result.**
