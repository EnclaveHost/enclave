# storage-enclave-fixture (r2): the existing G-C2 eight-stage fixture against the NEW reproducible indexd binaries

Prepared by Claude on 2026-10-22, from source plus mocked tests. **Not executed.**
- No PostgreSQL was started, and no indexd ran on a database.
- No production, SSH, network, chain, signing or spending was involved.
- Root must review the exact pins and cleanup design before authorizing the one isolated run.
- r2 fixes root review R1 (stage ownership) and R2 (process drainage). r1 is kept byte-exact in `ref/r1-reviewed/`.

## 1. What it runs (unchanged semantics)
`fixture/run_c2_fixture_test.py` contains the eight stages of `indexd-c2-implementation/package/fixture`. Every stage
function and every assertion is byte-identical; `test/test_package.py` checks this by AST. The stages cover:
1. v27 baseline with a v3 writer;
2. quiesced backup and restore-verify;
3. upgrade to v28, not enrolled;
4. enrolment, CAS, replay, conflicts and refusals;
5. indexd SIGKILL, restart, enrolment durable;
6. rollback refused while enrolled;
7. acknowledged rollback, schema equal to v27;
8. re-upgrade, not re-enrolled, then re-enrol.

Only the header changed: the paths of the binaries, the stage and the controller come from the runner. `ctl()` points at
the package controller.

## 2. Exact pins (`fixture/run-c2-fixture.py` PINS; `--plan` verifies them; manifest `160424cd4b48ae2b6a58a03e554d5ec654ea87e40d5cfcd9fbfdb59d71d6575c`)
| role | path (under work/) | sha256 |
|---|---|---|
| fence-enclave (v27, enclave-small) | claude-resumed-20261022/storage-enclave-build/out/fence-enclave-a/indexd | c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568 |
| c2-enclave (v28, enclave-small) | claude-resumed-20261022/storage-enclave-build/out/c2-enclave-a/indexd | 2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7 |
| matching fence seed-source tree | storage-enclave-build/trees/fence-enclave, inventory `inventory/fence-enclave.sha256` | d306f997a60105a17d06aea4f824a2d3134ab962936467a403b789de620b72df (218 files, no links) |
| GeoLite2 (pre-placed, never downloaded) | storage-enclave-build/trees/fence-enclave/GeoLite2-City.mmdb | 18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933 |
| fixture client (prebuilt, NOT rebuilt) | indexd-c2-implementation/package/fixture/c2client | 07d43802720b810961d9846b2de9e5dd798b8152fc8954150a8f42f40105e977 |
| go toolchain (seed test only) | /usr/lib/go/bin/go (go1.27.2-X:nodwarf5) | dc36303d0ab49f23ae5922d1468bb73c5a093bbec4e598888155b0dc99e0161d |
| PostgreSQL image (offline, `--pull never`) | postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 | present locally (read-only `docker image inspect`) |

Further pins:
- Package files: `controller/replicactl.py`, `fixture/*.py`, `fixture/rollout_seed_test.go` (c0355fd8, unchanged) and
  `migration/*.sql` (unchanged from the G-C2 package). Their hashes are in `--plan` output and `SHA256SUMS`.
- Both binaries were reproduced byte-identically by Phase A, from their own empty GOCACHEs.
- Both binaries keep enclave-small:
  - minContractGrowthRate 8 GiB;
  - serviceAccountFundTargetBytes 1 GiB;
  - app API timeouts 5 min.
- The node config sets NO contract, funding or timeout key, so the compiled defaults apply (tested).
- The recovery phrase is generated fresh by `indexd seed` of the pinned fence-enclave binary. No live seed is copied.

## 3. Controller: the r4 controller, plus a process-runner identity fix
- `controller/replicactl.py` is storage-migration-r4 (1b189bab) plus one change, `controller/replicactl.r4-to-fixture.patch`.
- r4 instead of the old package controller (ce63951e): r4 is a strict superset for this profile.
  - `-U ${POSTGRES_USER:-postgres}` is the same as before, because the fixture sets `POSTGRES_USER=indexd`.
  - The `config_file_access` exception never applies, because the fixture profile has no such key.
- The delta applies only to `runner: "process"` (the fixture):
  - the pid file is `<pid> <starttime> <boot_id>`, written atomically with mode 0600;
  - a reused pid is never signalled;
  - stop and crash-indexd re-verify the identity through a bound pidfd before signalling;
  - start refuses while the identified indexd still runs;
  - an unparseable pid file is an error, never reported as "stopped".
- The systemd branch and every DB, backup, upgrade and rollback path are AST-identical (`test_package`).

## 4. Ownership and cleanup (`fixture/c2fx.py`)
Root found that the old `run-c2-fixture.sh` installed its EXIT trap before the stale-secrets refusal. It then deleted
fixed names: node/, secrets/, seed-tree/, `enclave-c2-fixture-pg`, `enclave-c2-fixture-pgdata`. r2 replaces that as follows.

### Journal
`runs/<id>.journal.jsonl`:
- created O_EXCL first, fsync'd, never deleted, with no secrets;
- an intent is recorded before every create, and a result after it.

### Docker
- The names are `enclave-c2fx-<id>-pg` and `-pgdata`, with label `org.enclave.c2fixture.run=<id>`.
- A name that already exists is refused before anything is created.
- After a create, even one whose response was lost or timed out, the object is ours only if it carries our label.
  The idempotent `volume create` returning a foreign volume is caught by this.
- Cleanup removes only labelled objects of this run's intents, then re-inspects them, so a lost `rm` response is confirmed.
- The volume is kept unless the container is confirmed gone.
- The container is:
  - published only on `127.0.0.1:<ephemeral>` (`docker port` must answer 127.0.0.1, otherwise refused);
  - `--read-only`, `--memory 256m --memory-swap 256m`, `--pids-limit 256`, `--cpus 1`, `--pull never`.

### Stage, R1 (root's counterexample `work/root-c2-fixture-review-20261022/stage-race.py`)
An intent never confirms ownership. The stage is ours only with ALL of these:
- a `created` record written after OUR mkdir returned success;
- the device and inode taken right after it;
- a random token in an O_EXCL `.c2fx-owner` marker inside the new, verified-empty directory.

How each case is handled:
- **mkdir fails:** EEXIST or any other error records `create-failed` and re-raises; the path is never touched.
- **Removal:** the stage must still match the recorded inode and marker. It is renamed to `.<id>.removing`, re-verified,
  and only then removed. If it was swapped in between, it is restored, never deleted.
- **Replacement directory, copied marker, foreign marker or symlink at the path:** PRESERVED, and the run is uncertain.
- **Lost confirmation** (an intent without `created`, e.g. a SIGKILL right after mkdir): UNKNOWN, and the stage is
  preserved.

### Processes, R2 (scope drainage, replacing the r1 executable-path filter)
The queue (`work/claude-test-queue.py`) runs every job as
`systemd-run --user --scope -p MemoryMax=<cap>M node enclave/test/helpers/memory-guard.mjs ... -- <command>`:
- the scope is `run-p<G>-i<n>.scope`, where G is the memory guard;
- the guard spawns the command detached;
- the queue's own Python process is outside the scope;
- everything the job starts stays in the scope, including orphans (reparented to the user manager).

At start, `queue_scope()` refuses unless:
- the runner is inside such a scope;
- its ancestors stay inside it up to G;
- G's cmdline is `memory-guard.mjs`;
- every scope member is on that ancestor chain.

It records the chain as (pid, starttime): guard, optional `timeout`, runner.

At cleanup, every live member not on the chain is this run's workload, whatever its executable:
- go tool children, the python client, grandchildren whose parent exited, indexd;
- each is signalled only through a pidfd whose starttime AND cgroup membership are re-verified after binding;
- SIGTERM, then SIGKILL, then a re-query, for at most 5 rounds;
- ancestors and the cleaner's own ancestry are never signalled.

Nothing outside the scope's `cgroup.procs` is read or signalled: no host-wide `/proc` scan and no name patterns
(static test). A gone scope, or one whose cgroup inode changed, cannot hold the run's processes, and its new namesake
is untouched.

`child()` on a timeout stops only its direct child; the drain handles the rest (tested).

### Never PASS on uncertainty
Any UNKNOWN keeps the stage (with its 0600 disposable secrets), the journal and the docker names, and exits 3.
`--recover <id>` (through the queue) re-runs the identity-checked cleanup from the journal, including draining the
recorded scope.

## 5. Isolated execution recipe (ROOT ONLY, after review; not run here)
1. Review `SHA256SUMS`, then: `python3 work/claude-test-queue.py --mib 256 --log <unique>.log -- python3 -u work/claude-resumed-20261022/storage-enclave-fixture/fixture/run-c2-fixture.py --plan`.
   Expect exit 0, `pinMismatches: []`, inventory 218 files, and manifest `160424cd…` (changes if any pinned file changes).
2. Run ONE job: `python3 work/claude-test-queue.py --mib 768 --log <unique>.log -- python3 -u work/claude-resumed-20261022/storage-enclave-fixture/fixture/run-c2-fixture.py --execute 160424cd4b48ae2b6a58a03e554d5ec654ea87e40d5cfcd9fbfdb59d71d6575c`.
   The runner refuses anything but a queue job of at most 768 MiB. It performs these steps:
   1. journal and exclusive stage;
   2. labelled volume and container (offline image);
   3. seed at v27 through the fence-enclave store code: a scratch copy in the stage; the inventory re-checked before and
      after; `go test -run '^TestRolloutSeed$' ./persist/postgres/` with GOPROXY=off, -mod=readonly, GOTOOLCHAIN=local,
      GOMAXPROCS=2, GOMEMLIMIT=400MiB, a per-run GOCACHE, taskset 0-1; go.mod/go.sum unchanged. This compiles a TEST
      binary inside the run; no release or image build;
   4. the node: loopback ports chosen for this run, peers [], bootstrap/UPnP/explorer off;
   5. the 8 stages;
   6. cleanup.
3. Read `runs/<id>.result.json`:
   - exit 0 only if all 8 stages passed and the cleanup is certain;
   - 1: a stage, the seed or the setup failed (cleanup certain);
   - 2: refused;
   - 3: cleanup UNCERTAIN (run `--recover <id>` through the queue at 256).

   Stage results are copied to `runs/<id>.c2-fixture-results.json` before the stage is removed.

### Memory (the budget is root's decision)
| part | cap |
|---|---|
| the queue job: runner, seed `go test` compile (GOMEMLIMIT 400MiB), then indexd (GOMEMLIMIT 320MiB, one at a time), controller, c2client | 768 MiB cgroup MemoryMax (covers detached indexd too; note the memory guard's tree-RSS view does not see reparented indexd, the cgroup cap does) |
| the PostgreSQL container, under dockerd (outside the queue's scope and accounting) | 256 MiB (`--memory`/`--memory-swap`) |
| **total proposed** | **1024 MiB** (the old fixture's "768" ignored docker's separate 256) |

512 + 256 might fit, but it is unproven for the seed compile. 1024 overall is not exceeded.

### Known residuals (for root)
- **Docker network.** The container is on docker's default bridge: it is published only on 127.0.0.1, but has
  outbound NAT. It runs only postgres from the pinned image with `--pull never`. Other containers on docker0 could reach
  its port 5432; access still needs the random disposable password. A per-run `--internal`
  network was not added (it would be another owned resource).
- **Port selection.** indexd's loopback ports are chosen by bind(0) and released (TOCTOU). Readiness requires this run's
  admin password, so another listener cannot pass as ours.
- **Very late container create.** A docker create answered after the post-create re-inspect window could appear after
  cleanup. It carries our label, and `--recover` finds it by its journal intent.
- **Inode check window.** The window between mkdir and the inode/marker record is within the private 0700 `runs/`; the
  name is a random 64-bit id.
- **Untested binaries.** The 8 stages have passed only with the OLD binaries (61413110/e6e812fd). The new binaries
  differ only by the enclave-small patch (build/meta.go, cmd/indexd/run.go, contracts/form.go, contracts/funding.go), but
  the stages are UNVERIFIED with them until root's run.

## 6. Evidence (local, mocked, through the shared queue; no PostgreSQL)
| log | what | result |
|---|---|---|
| logs/ownership3.out (512) | test_ownership.py, 48 tests, 0 skipped: collisions, lost responses, R1 stage ownership (root's counterexample in-process AND root's script byte-exact), lost confirmation incl. real SIGKILL after mkdir + recover, replacement/foreign marker/symlink/swap, identity, real-scope drain (grandchildren with exe outside stage writing in it after parent exit; child() timeout leaving a descendant; undrainable -> UNKNOWN; replaced scope untouched; unrelated process in its own scope survives; ancestors never signalled), runner SIGTERM / exit 3 / SIGKILL+recover | 48/48 OK, queue EXIT 0 |
| logs/negative-r1.out (256) | the reviewed r1 c2fx (b5ae3e88) on the same R1/R2 scenarios | all 3 defects REPRODUCED (expected), queue EXIT 0 |
| logs/package3.out (256) | static: 8 stages unchanged, controller delta limited, r4 superset, loopback config / no sizing override, no host-wide scan, pins | 6/6 OK |
| logs/plan2.out (256) | `--plan` | pins match, manifest 160424cd… |

Earlier r1 evidence is kept: ownership1 (1 failure in a test precondition, fixed in r1), ownership2, package1/2,
scope-probe.

Note: `fixture/__pycache__/c2fx.cpython-314.pyc` was written at 23:44:07 by root's stage-race.py import of c2fx. It was a
bytecode cache only and was removed; no source or log was removed.
