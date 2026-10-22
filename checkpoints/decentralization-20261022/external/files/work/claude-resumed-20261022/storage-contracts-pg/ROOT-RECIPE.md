# storage-contracts-pg: database-backed contracts tests in one isolated container (ROOT runs; nothing real was run yet)

This is a bounded local test task; it is not production migration. Nothing here touches production, the existing
PostgreSQL (`enclave-storage-proof-pg`), SSH, the chain, a seed, config or database. It does no downloads, installs or
image builds.

## Before the run (read-only, seconds)

    cd work/claude-resumed-20261022/storage-contracts-pg && sha256sum -c PINS.sha256
    python3 work/claude-test-queue.py --mib 256 --log <log> -- python3 -B contracts_pg_runner.py --config config.json --check
    python3 -B contracts_pg_runner.py --config config.json --dry-run        # exact docker argv, no docker call

## The run: one shared-queue allocation of 1536 MiB, which keeps the 16 GiB host floor

    W=work/claude-resumed-20261022/storage-contracts-pg
    python3 work/claude-test-queue.py --mib 1536 --log $W/logs/run-1.guard.log -- \
      python3 -u -B $W/contracts_pg_runner.py --config $W/config.json --run > $W/logs/run-1.out 2>&1; echo "exit=$?"

Run it in the foreground and wait for a terminal exit. Exit 98 or 99 is not a pass.

## Bounds

- **Workload:** the whole workload (PostgreSQL plus `go test` and its test binaries) is in the container's cgroup.
  - 1024 MiB memory and 1024 MiB memory+swap, so no swap.
  - `--cpus 2 --cpuset-cpus 0-1`, so `GOMAXPROCS=2` and NumCPU=2.
  - `--pids-limit 1024`, a read-only rootfs and `no-new-privileges`.
  - `--network none` and no published ports. The fixtures' `:0` listeners exist only in that namespace.
- **Time:**
  - PostgreSQL readiness: 180 s.
  - Each suite: an inner `timeout -k 10 1500`, an outer 1560 s and `go test -timeout=20m`.
  - Worst case is about 57 min; normally it should be much less.
- **The parent wrapper:** only the Python runner and the docker CLI (tens of MiB).

## What runs inside

1. **The container:** `postgres` from image `sha256:74935e72…`, with `--pull never`.
   - The data goes in the image's anonymous volume `/var/lib/postgresql`, recorded from OUR container's inspect output.
   - The credentials are fresh random dummies in a 0600 `--env-file` inside scratch. They are never printed or put in argv.
   - While the container exists, they are visible to `docker inspect`; that is disposable and isolated.
2. **Isolation check:** the container's inspect output must match the plan before anything else runs:
   - the ID, name, run label and image;
   - NetworkMode none, no port bindings, the memory/swap/CPU limits, a read-only rootfs;
   - `/scratch` as the only writable bind, and exactly one volume.
3. **Readiness:** `pg_isready` over TCP on 127.0.0.1:5432 inside the container. The image's temporary init server listens
   only on its socket, so a TCP answer means the final server is up.
4. **Toolchain check:** `go version` inside the container must equal `go version go1.27.2-X:nodwarf5 linux/amd64`.
   All toolchain binaries are statically linked, so the Debian 13 image needs no glibc match.
5. **Suites,** run sequentially as `docker exec --user <host uid:gid>`, fence-enclave first, then c2-enclave:
   - `timeout -k 10 1500 go test -p 1 -count=1 -json -timeout=20m ./contracts/... ./cmd/...`
   - environment: `GOFLAGS=-mod=readonly GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOENV=off CGO_ENABLED=0 GOMAXPROCS=2 GOMEMLIMIT=600MiB`
   - per suite: its own `GOCACHE` and `POSTGRES_DB_PREFIX` (`fe_<id>_` / `c2_<id>_`).
   - mounts: the snapshots, the toolchain and the module cache are bind-mounted read-only.
   - the snapshot inventory is re-checked after each suite.
6. **Verdict:** a suite is PASS only if `go test` returns 0, no test failed, and the snapshot is unchanged. The
   classifier only adds the failure classes (POSTGRES, TIMEOUT, TEST, PACKAGE_OR_BUILD); it never turns a non-zero
   return code into a pass.

## Ownership and cleanup

- The run id is a timestamp plus 48 random bits.
- Before create, nothing may already carry the name `scpg-<id>` or the run label. If something does, the run refuses
  and touches nothing.
- **Lost or failed create response:** the container is adopted only if it carries the run label and the exact name, and
  uses the pinned image. That label was proven absent just before the create.
- **Removal:** `docker rm -f -v <full id>`, then confirmation:
  - `inspect` says no such object;
  - the run-label query is empty;
  - each recorded anonymous volume is gone. One that remains is removed by its exact name.
- **Scratch:** removed only after that confirmation, and only if its lstat still matches the mkdtemp identity (path,
  device, inode, owner uid) and it is a real directory, not a symlink.
- **Anything unconfirmed:** nothing more is deleted (exit 3). The journal `runs/<id>.journal.json` keeps the state.
  A second process can resume with `--cleanup runs/<id>.journal.json`, which refuses while the journal's own runner
  pid is still running.
- **Absence needs an explicit answer:** a container counts as gone only on an explicit "No such object/container"
  response, and a volume only on "no such volume". A connection, permission or daemon error (even one whose text says
  "no such file") leaves cleanup unconfirmed, and scratch and journal are kept.
- **Volumes recorded first:** before removal, the container's anonymous volumes are read from its inspect output and
  written to the journal. That includes a container adopted by run label after a lost create. If the container vanished
  before its volumes were ever recorded, cleanup cannot be confirmed.
- **Suite scheduling stops at the first uncertain `docker exec` end.**
  - Certain ends: go test rc 0/1/2, and 124, where the in-container timeout killed the process group.
  - Uncertain ends: a parent-side timeout, an OSError, a signal-killed client, or rc 125/126/127/137.
  - After an uncertain end, the remaining suites are NOT_RUN and the runner goes straight to removing the whole
    container.
- There is no host-wide process scan or kill, and no name-only or intent-only deletion.

## Exit codes and outputs

| Exit | Meaning |
|---|---|
| 0 | both suites `go test` rc 0, cleanup confirmed |
| 1 | suite failure(s), cleanup confirmed |
| 2 | refused before any docker change |
| 3 | cleanup unconfirmed, state preserved |
| 4 | run error before the suites, cleanup confirmed |

Outputs:
- `runs/<id>-results/{fence-enclave,c2-enclave}.json` (raw `go test -json`) and `.stderr`;
- `runs/<id>-results/summary.json`;
- `runs/<id>.journal.json`.

## Known first-run risks (each is a visible failure with cleanup, never a silent pass)

- **Read-only module cache:** Go is expected to read the module cache only (all 45 needed modules are present and match
  `go.sum`). If it tries to write there, the suite fails with "read-only file system".
  - The contingency is a reviewed change that copies the needed modules into scratch. It is not prepared.
- **Entrypoint under hardening:** the PostgreSQL entrypoint runs under `--read-only` and `no-new-privileges`. Writable
  tmpfs is provided for `/var/run/postgresql` and `/tmp`, and gosu only uses setuid syscalls. A failure here shows up as
  a readiness error (exit 4).
- **Memory headroom:** the 1024 MiB cap covers compile (about 460 MiB peak in A1) plus PostgreSQL plus the tests. An OOM
  shows as a non-zero `go test` return code and in the container state.
