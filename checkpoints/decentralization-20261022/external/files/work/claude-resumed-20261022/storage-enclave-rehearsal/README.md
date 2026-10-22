# storage-enclave-rehearsal: Phase A3 production-capture rehearsal against the NEW reproducible indexd binaries

Prepared by Claude on 2026-10-22, from source plus mocked tests. **Nothing was run against a database.**
- No PostgreSQL, docker mutation, Go build, SSH, network, signing or production action.
- No capture was opened, beyond hashing root's two receipt files for the plan.
- This is NOT a fresh production backup, and it authorizes no live data acquisition.

It ports `work/indexd-c2-production-rehearsal/rehearse-c2.py`:
- original hash e2cc1aed; run2 passed 20/20 with the OLD binaries 61413110/e6e812fd (unchanged, `FROZEN-final.sha256 -c` OK);
- to fence-enclave `c67ffa4d` and c2-enclave `2c0e5b06`, the binaries root's isolated eight-stage fixture just passed
  (run 32418fa137c5c05c);
- with matching tool code, and the reviewed ownership discipline of `storage-enclave-fixture`.

## 1. What is unchanged: every rehearsal phase and assertion
The same 20 phases, in the same order:
- **setup;**
- **snapshot (S0–S10):** restore at v26, fixture seed, original binary, backup and verify, upgrade 26→27, upgrade 27→28,
  fixture app operations, admin block/unblock, SIGKILL restart, C2 rollback refused while enrolled, acknowledged C2
  rollback 28→27, rollback 27→26;
- **live dump (L0–L6):** restore, migrate 26→27, migrate 27→28, C2 exercise on real accounts, down 28→27 refused, down
  28→27 acknowledged, down 27→26.

All 19 S/L phase functions and every helper they call are byte-identical by AST to the original (`test_rehearsal.py`). That
covers:
- the digests, production-scoped digests, whole-table digests and column fingerprints;
- schema equality with the restored production schema;
- the receipt counts, schema facts and production-account counts.

Also unchanged:
- **wallet:** `wallet_hash` is NULLed on the disposable copy (S0b), and a fresh fixture recovery phrase comes from
  `indexd seed`. No real wallet seed is loaded.
- **indexd.yml:** identical: loopback ports, peers [], bootstrap/UPnP/explorer off, `slabs.migrations: false`, no sizing
  keys (so enclave-small defaults apply).
- **setup:** every old assertion is kept, including isolation and inputs against root's receipts. The two per-copy hash
  asserts became `copy_pinned()`, which raises on any mismatch; now every migration file is pinned too.

## 2. What changed (`rehearse/rehearse-c2.patch`)
| | old | new |
|---|---|---|
| v27 binary | indexd-fence 61413110 (stock sizing) | fence-enclave c67ffa4d (`storage-enclave-build/out/fence-enclave-a/indexd`) |
| v28 binary | G-C2 e6e812fd | c2-enclave 2c0e5b06 (`.../out/c2-enclave-a/indexd`) |
| v26 binary | from the snapshot, 2d7a637e | same |
| controller | C2 package ce63951e | `storage-enclave-fixture/controller/replicactl.py` 91dc928d (r4 + identity/scope-checked PID files), the one the fixture passed with; hash-verified copy in the stage |
| migrations | digest/down-28 pinned, down-27-26 NOT pinned | all pinned: digest 7f4b137f, down-28-to-27 629f186e (fixture), down-27-to-26 2127a7e2 (indexd-replica-rollout) |
| store tools | rehearsaltool ec8dc6d2 (stock fence source), c2tool bb12eb72 / c2rclient e76693f6 (stock c2 source) | REBUILT from the matching assembled trees (section 3); pins PENDING |
| resources | fixed `c2prh-pg` / `c2prh-tool` / `c2prh-pgdata`; package-dir secrets/state/sock/...; `finally: rm -f` + `pgrep -f` | section 4 |
| inputs | `RH_INPUT_DIR` / `RH_LIVE_DUMP` overridable | pinned to `work/indexd-production-rehearsal` (receipts checked as before) |
| `indexd_hwm` | `int(pid file)` | first field: the controller's identity PID file is `<pid> <start> <boot>` (the old parse would silently lose VmHWM) |
| results | `results/<run>-results.json` | `runs/<id>.results.json`; `passed` additionally requires a CERTAIN cleanup; exit 3 if uncertain |

## 3. Matching tool code: rebuild required (root schedules the offline compile)
The tools link the `contracts` package, which carries the enclave-small constants:
- minContractGrowthRate 8 GiB;
- serviceAccountFundTargetBytes 1 GiB.

So the existing tool binaries, built from stock sources, are NOT the matching snapshot.

Every other package the tools import is byte-identical between the stock sources and the assembled trees: persist/postgres,
accounts, hosts, api/app, api/admin, sharing, slabs. The tools' code paths are therefore expected to behave identically, but
that is not the same as being built from the matching source.

Source closure (`tools/SOURCES.sha256`):
- `tools/src/<tool>/main.go` is byte-identical to the original:
  - c2tool f914a55c (tool28);
  - c2rclient 2ea0c557 (client);
  - rehearsaltool-v27 2ff37377 (work/indexd-prod-rehearsal/tool).
- `go.sum` is identical (bfc51b15, the same as both trees).
- `go.mod` differs by exactly the `replace` line:
  - c2tool and c2rclient → `storage-enclave-build/trees/c2-enclave` (inventory 2e8faf80);
  - rehearsaltool-v27 → `trees/fence-enclave` (d306f997).
- Statically, all 47 requirements of each tool equal the trees' versions and have go.sum entries.
- go1.27.2 (`/usr/lib/go/bin/go` dc36303d); the existing module cache only.

Recipe (`tools/build-tools.sh`, ROOT ONLY): each tool twice (a, b), sequentially, through the queue at 1024 MiB.
- Phase A1's deterministic flags, but `-mod=readonly`: GOPROXY=off, GOTOOLCHAIN=local, CGO off, -p 1, GOMAXPROCS=2,
  GOMEMLIMIT=600MiB, taskset 0-1, `-trimpath -buildvcs=false -ldflags '-s -w -buildid='`.
- A new empty GOCACHE per build.
- `go vet` first, as the original build.sh.
- The tree inventory and tool sources are checked before and after.

**DONE 2026-10-22 (root-approved, recipe f4779ace unchanged).**
- Six sequential queue jobs at 1024 MiB, each as `unshare -rn env PATH=/usr/lib/go/bin:/usr/bin:/bin tools/build-tools.sh <tool> <a|b>`.
- In every job the toolchain resolved to `/usr/lib/go/bin/go`, sha256 dc36303d (the hard pin), go1.27.2-X:nodwarf5, and
  the namespace held only `lo`.
- Every job passed `go vet`, and the tree and tool sources were verified unchanged before and after.
- The queue answered 98 (not started) on 5 tries while another job held the lane; each retry used a new log. Nothing was
  run in parallel.

| tool | a == b (cmp) | sha256 (pinned in tools/pins.json) | GOCACHE | peak tree RSS |
|---|---|---|---|---|
| rehearsaltool-v27 (fence-enclave) | yes | 138605ff63c7ef8a4797932ff78cc9dd999fffd971ff3a1a1bae924b3aa5eb7a | 444 MiB | 494 / 502 MiB |
| c2tool (c2-enclave) | yes | e5d157370f6191f0880f5e6faf776f6526921f5267e46ed0ab4aa4544d1dffcd | 444 MiB | 505 / 517 MiB |
| c2rclient (c2-enclave) | yes | aa500372dc72b97812daed2218d570975b807ca11e80c6ea64377e7b92cd7e59 | 512 MiB | 307 / 284 MiB |

`buildinfo.txt` is identical within each pair apart from its first line, which is the binary's own path. It records
`go.sia.tech/indexd => ../../../../storage-enclave-build/trees/<tree>`. The pre-build pins are kept in
`tools/pins.pending.json`.

## 4. Ownership and cleanup (reuse, not a copy)
`rehearse/rhfx.py` loads `storage-enclave-fixture/fixture/c2fx.py` read-only, refusing any hash but ff1b092c, the reviewed
r3. It inherits all of it:
- the O_EXCL journal `runs/<id>.journal.jsonl`;
- the exclusive stage `runs/<id>/` (inode + O_EXCL marker; never trusted on intent alone);
- labelled, name-unique docker objects, with pre-existing names refused before any create and lost responses resolved
  by name+label;
- PID files that never signal, read only under a confirmed own stage;
- the drain of this job's own queue scope minus its exact ancestor chain;
- never PASS on uncertainty, and `--recover <id>`.

Every per-run file lives in the stage: secrets (0600, exclusive), state with the consensus.db copy, sock, migration,
backups, releases, bin, profile.json.

rhfx adds exactly two rehearsal-specific pieces:
- **PostgreSQL:** the old flags (socket-only, `listen_addresses=127.0.0.1`, shared_buffers 64MB), plus our name and label,
  `--network none` (setup asserts NetworkMode `none`), `--pull never`, `--memory/--memory-swap 256m`, `--pids-limit`,
  `--cpus 1` and `--read-only`.
- **Tool containers:**
  - each step runs in its own `<pg>-tool-<n>` with `--rm`, `--pull never` and our label;
  - `--network container:<pg>`, so it shares only PostgreSQL's empty namespace;
  - 256m, `--user` RH_UID:RH_GID, the binary bind-mounted read-only;
  - the step is journaled, and the name is re-inspected afterwards: removed by label if the daemon left it, UNKNOWN if
    it cannot be confirmed gone;
  - cleanup resolves every journaled tool intent first. An unresolved one makes c2fx's own rules keep the stage and
    report uncertainty (raised through c2fx's `stop_children` hook; c2fx itself is unchanged).

No host-wide scan, no `pgrep`, no fixed names (static tests).

## 5. Isolation (as the original)
`rehearse/run.sh` is one queue job:
`env RH_UID RH_GID taskset -c 0-1 unshare --user --map-root-user --net -- sh -c 'ip link set lo up && exec python3 rehearse-c2.py --execute M'`.
- The runner refuses, before creating anything, unless:
  - it is in a private loopback-only network namespace with no name resolution;
  - it runs as one queue job (`queue_scope`), at most 512 MiB;
  - every pin matches.
- **indexd:** it and the controller and client run in that namespace on its private fixed loopback ports, with no
  peers, DNS or egress.
- **PostgreSQL:** `--network none`, reached through the unix socket in the stage.
- **Tool containers:** only PostgreSQL's namespace.
- **Docker:** the CLI reaches the local daemon through its socket, as before.
- **Captures:** only read, streamed to `pg_restore`, or copied into the stage (consensus.db, GeoLite).

## 6. Proposed run (ROOT ONLY, after review; not run here)
1. ~~Run the six tool builds~~: done and pinned (section 3).
2. `python3 work/claude-test-queue.py --mib 256 --log <unique>.log -- python3 -B -u work/claude-resumed-20261022/storage-enclave-rehearsal/rehearse/rehearse-c2.py --plan`
   must exit 0. It now does (`logs/plan2.out`), with manifest `ef410653159c964de8ca3f91e15c8ce594c338c2891ab0ffde17d4e423edd50e`.
   While the pins were pending it was `5d8877d7…` and the plan exited 2 (`logs/plan1.out`).
3. `work/claude-resumed-20261022/storage-enclave-rehearsal/rehearse/run.sh <manifest> <unique-log>` runs ONE job. It
   does not retry on 98: 98 means not started and 99 means killed, and neither is a pass.
4. Read `runs/<id>.results.json`:
   - `passed` requires all 20 phases AND a certain cleanup;
   - exit 1 means a phase failed (cleanup certain); 2 means refused; 3 means cleanup UNCERTAIN.
   - On 3, the stage, the journal and the docker names are kept. Run `rehearse-c2.py --recover <id>` as a queue job
     (256). It re-runs the identity-checked cleanup from the journal, including the tool containers and the recorded
     scope drain.

### Memory (explicit; total 1024 MiB proposed; root decides)
| part | cap | basis |
|---|---|---|
| queue job (python, controller, one indexd at GOMEMLIMIT 256MiB, the client, docker/psql CLIs) | **512 MiB** | old run2: process-tree RSS 114 MiB, indexd VmHWM 33-40 MiB; its job-cgroup `memory.peak` reached the old 768 cap, which is page cache (the 499 MB consensus.db copy and restores), reclaimable under a lower cap |
| PostgreSQL container (dockerd, outside the queue) | 256 MiB | as before |
| one tool container at a time (outside the queue; L1-L3 only, no indexd running) | 256 MiB | as before |
| **total** | **1024 MiB** | |

The old layout (768 + 256 + 256 = 1280 MiB nominal) would exceed 1024 and needs root's explicit choice. 512 MiB is
UNPROVEN for this rehearsal: if the cgroup cannot reclaim cache fast enough, the job could fail (never a false pass). In
that case root may choose 768 explicitly.

## 7. Evidence (local, mocked, through the shared queue)
| log | what | result |
|---|---|---|
| logs/build-<tool>-<a\|b>.try*.out (1024) | the six tool builds (section 3) | all EXIT 0; 98s were not-started retries |
| logs/rehearsal3.out (256) | test_rehearsal.py, 20 tests: the 19 below, with the plan test now expecting the pinned state, plus a test that the preserved pending pins are still refused | 20/20 OK, queue EXIT 0 |
| logs/plan2.out (256) | `--plan` after pinning | exit 0, no problems, manifest ef410653…; nothing created |
| logs/rehearsal2.out, logs/plan1.out (256) | the same, before the builds | 19/19 OK; plan exit 2 for the 3 PENDING pins |

The 19 tests cover:
- **Port equality:** the 19 phase functions and their helpers are AST-identical; only ctl, tool, setup, indexd_hwm and main
  changed; the 20-phase order is the same; setup keeps every assertion, with the two copy asserts now raising inside
  `copy_pinned`; the indexd.yml template is identical; `wallet_hash` is nulled; `passed` needs 20 phases and a certain
  cleanup.
- **Pins and sources:** the new binaries and controller are pinned and the old ones are absent; the tool sources are
  identical except one `replace` line.
- **Static safety:** no fixed names, pgrep or 0.0.0.0, and no port publish.
- **Refusals:** the old script's defects are documented; a non-reviewed c2fx is refused; `--plan` and `--execute` refuse
  with nothing created; this host namespace counts as not isolated.
- **Ownership** (fake docker = the fixture's pinned fake plus `--rm`):
  - PostgreSQL is network-none, socket-only, capped, offline and labelled;
  - tools get unique labelled names, share only PostgreSQL's namespace and are confirmed gone;
  - a tool the daemon left behind is removed by label;
  - a lost tool `run` response is resolved by name and label;
  - a foreign container holding a tool name is PRESERVED and the stage is KEPT;
  - an unremovable tool is uncertain, then `--recover` completes;
  - a pre-existing PostgreSQL name is refused before any create.

`ref/old/` holds the original sources byte-exact.

## 8. Not done / residuals
- The rehearsal run itself (root is still reviewing the controller).
- **First run with new pieces:** the rehearsal has never run with these binaries, this controller, the 512 MiB cap or the
  rebuilt tools. Background loops of the enclave-small binaries (contract formation sizing) may change the
  "derivedState" boundary reports; those are reported, not asserted, as before.
- Not a fresh quiesced cutover backup: the B2 backup and the Phase C/D production steps remain root's.
