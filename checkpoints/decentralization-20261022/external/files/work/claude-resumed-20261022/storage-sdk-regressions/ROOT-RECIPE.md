# storage-sdk-regressions: Phase A2 REAL SDK + REAL indexd interop for the accepted enclave snapshots

This package is source and recipe only. Nothing here built, ran a harness, an SDK driver, PostgreSQL or Docker.
Root schedules the two steps below.

## Why the old evidence does not carry over

- **Harness:** the real-interop harness compiles indexd INTO its binary with `replace go.sia.tech/indexd => <tree>`.
  - Variants: `go.c2.mod` points at `../src` (stock C2), `go.release.mod` at the stock fence tree.
  - It uses indexd's accounts, admin/app API, contracts (the enclave-small sizing), persist/postgres (schema and
    migrations), slabs, pins, hosts and subscriber packages.
  - So `bin/harness-c2` 29b06597 (stock C2, CGO) and `storage-real-indexd/bin/harness-block` 33bee1ac (stock fence) are
    NOT evidence for the enclave-small snapshots. They must be rebuilt from the accepted trees.
- **Driver:** the Rust SDK driver is only a client (sia-s3 and the sia_storage SDK; no indexd code). The prebuilt
  `indexd-c2-implementation/bin/sdk-c2-4-driver` d45df48e is reused by pinned provenance:
  - built offline by `tools/build-sdk-driver.sh` 3acdbe98 from `sdk-snapshot-c2-4` (SNAPSHOT.sha256 still verifies,
    taken 2026-10-20T15:25:30Z);
  - `logs/sdkbuild4.out` records the hash and the 19 real cases.
  - Limit: this is the C2-4 candidate SDK, not the binary currently deployed as sia-s3.

## Step 1: offline harness compile (root; one 1024 MiB queue job; about 4 x 45 s of compile)

    sha256sum -c work/claude-resumed-20261022/storage-sdk-regressions/PINS.sha256
    python3 work/claude-test-queue.py --mib 1024 --log <log> -- work/claude-resumed-20261022/storage-sdk-regressions/build-harness.sh

- **Source:** `harness-src/` is byte-identical to `indexd-c2-implementation/harness` (`cmd/harness-block`, `rtu/*`,
  `go.mod`, `go.c2.mod`, `go.c2.sum`). That copy matches `logs/harness-copy-origin.sha256`.
- **Modfiles:** `go.c2e.mod` and `go.fe.mod` differ from `go.c2.mod` ONLY in the replace target: the accepted c2-enclave
  and fence-enclave snapshots. Their `.sum` files are the shared `bfc51b15`, which is also both trees' go.sum.
  - Offline `go list -deps -mod=readonly` already resolves 465 packages for each, with indexd from the snapshot
    (`logs/golist-check.out`).
- **Build:** each variant twice from independent empty GOCACHEs, byte-identical required. Settings: `CGO_ENABLED=0`
  (static: the one deliberate difference from the old CGO harness), `-trimpath -buildvcs=false -p 1`, `GOMAXPROCS=2`,
  `GOMEMLIMIT=600MiB`, `taskset 0-1`, `GOPROXY=off GOTOOLCHAIN=local -mod=readonly`, inside `unshare -rn`.
- **Checks:** the harness-src pins and both snapshot inventories are checked before and after. Any failed check exits.
- **Then:** put `out/c2e-a/harness-block` and `out/fe-a/harness-block` hashes into `config.json`
  (`harnesses.*.sha256`). Until then `--check` and `--run` refuse ("not built/pinned yet").

## Step 2: the interop run (root; one queue allocation of 1536 MiB, 16 GiB floor; foreground)

    W=work/claude-resumed-20261022/storage-sdk-regressions
    python3 -B $W/sdk_regression_runner.py --config $W/config.json --check
    python3 work/claude-test-queue.py --mib 1536 --log $W/logs/run-1.guard.log -- python3 -u -B $W/sdk_regression_runner.py --config $W/config.json --run

One disposable container runs this run's own PostgreSQL (image 74935e72), both harnesses and the driver.
- **Isolation:**
  - `--network none` with no ports, and IPv6 loopback enabled (the hosts listen on `[::1]`), checked inside the
    container before any group;
  - 1280 MiB memory and swap, 2 CPUs (cpuset 0-1), 2048 pids, a read-only rootfs, `no-new-privileges`;
  - read-only binds for both harnesses, the driver, the GeoLite file and `case-group.sh`; `/scratch` is the only
    writable bind.
- **Credentials:** the shared 55432 fixture and its credentials are never used. Fresh dummy credentials go in through
  `--env-file`; the group script writes a 0600 copy only until the harness has read it.
- **Ownership and cleanup:** root's accepted `contracts_pg_runner.py` ed8e0fdd, loaded read-only from its pinned bytes.
  - fresh run label + exact name + image;
  - removal by full ID, confirmed by an explicit "no such" for the container and its recorded anonymous volume;
  - scratch removed only by its mkdtemp dev/inode identity;
  - anything unconfirmed → exit 3, state kept; `--cleanup <journal>` resumes it.
- **Driver check:** before the groups, `sdk-driver --list --ignored` must include all 19 configured cases. This also
  proves the driver's glibc 2.39 / libgcc_s needs are met by the image.

| group | harness (snapshot) | SIAS3_REAL_INDEXD | cases | covers |
|---|---|---|---|---|
| c2epos | c2e (c2-enclave) | c2 | 5 real_c2_* | G-C2 positive semantics (was real-runs group c) |
| fec2neg | fe (fence-enclave) | c2 | real_c2_an_indexer_without_cas_and_op_nonce_is_refused | a C2 client refuses the actual Phase C step-3 tree (was group o, on the stock fence) |
| c2efence | c2e | c2 | 4 real_fence_* | fence API under C2 (was group r) |
| c2eblock | c2e | c2 | 2 real_fence_blocked_* | admin blocklist + fence (was group b); admin block/unblock preserved |
| fefence | fe | fence | 6 real_fence_* | fence semantics on the fence-enclave v27 intermediate |
| c2eindexd | c2e | v060 (feed) | 7 real_indexd::* | NEW: the unfenced SDK path that production keeps (accounts not enrolled) |
| feindexd | fe | v060 (feed) | 7 real_indexd::* | NEW: the same path on fence-enclave |

That is 32 case runs and all 19 distinct cases.
- **Group verdict:** PASS only if the driver returns 0, every configured case shows `... ok` exactly once,
  `test result: ok. N passed; 0 failed` has N equal to the case count, and the harness exited 0.
- **Scheduling:** certain group ends (0/101/3/4/124) continue to the next group. An uncertain end (outer timeout,
  OSError, signal, 125/126/127/137) stops scheduling, leaves the rest NOT_RUN, and goes straight to container removal.
- **Evidence:** `runs/<id>-results/<group>/{driver.log,events.jsonl,evidence.json,resources.txt}` and the harness log,
  with `sc|ss|sf=` query values redacted as in the old script. Also `summary.json` and the journal.
- **Exit codes:** 0 all PASS | 1 group failure/NOT_RUN | 2 refused | 3 cleanup unconfirmed | 4 error before the groups.

### Resource envelope

- **Memory:** the previous C2 groups peaked at 570-625 MiB for harness + driver with PostgreSQL outside. Adding the
  in-container PostgreSQL (about 150-250 MiB) and page cache gives the 1280 MiB cap. The parent process is small, so a
  1536 MiB queue reservation covers it.
- **Disk:** about 1.2 GB of host sector files per group, on the work disk, removed after each group.
- **Time:** each group is bounded by harness readiness (300 s) plus `timeout -k 10 1500`, with a 1560 s outer limit.
  Previous groups ran 0.1-53 s of driver time; the 7 `real_indexd` cases are unmeasured on fence/C2.
  - Worst case is about 3 h; typically well under 1 h.
- **CPU:** harness and driver now share 2 CPUs; previously they used 2+2.

## Coverage limits (not proven by this run)

- The enclave-small app-API timeouts (`cmd/indexd/run.go`) are not exercised: the harness builds its own HTTP servers
  with no timeouts. Contract sizing (the `contracts` package) IS exercised.
- The driver is the C2-4 candidate SDK, not the deployed sia-s3 binary.
- The `real_c2_*` cases use the harness's FIXTURE lease16 authority. They prove nothing about the production
  front/generation binding (the driver's own note).
- Each group runs sequentially on one 3-indexer / 12-host loopback cluster with simulated chain facts.
