# Finality r6: security fixes, operational wiring and a deliberate activation path (PREPARED; NOT run; productionActivated=false)

**Stage:** `base-finality-proof-stage/r6/` (new). `SHA256SUMS` sha256 `1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c`, 46 files, 11 coherent patches in `integration/`.
- **What Claude did:** static checks only: every Python file parses, the job passes `bash -n`, the patches are recorded against their exact bases, and the manifest shas were regenerated.
- **Not done:** no tests, builds, queue jobs, installs, SSH, live changes or commits.
- **Preserved:** r5, r4, r2, recovery r7, capture r4 and the readiness stages are untouched; their manifests are pinned in the job.
- **Flags:** all four review flags are **False** in source, and no activation artifact was written.

## Root's actual r5 run (`logs/root-finality-r5-0534.out`, rc 1) and what r6 does about it

| r5 suite | Result | Cause | r6 |
|---|---|---|---|
| r3-regression | **PASS** 27 | – | re-run with the r6 swaps and a 1-line mount port |
| recovery-existing | **PASS** 34 | – | re-run |
| reanchor-recovery | Ran **38** OK (expected 24) | My `FinalityRestart(Recovery)` re-ran 14 inherited tests. **Its 5 own tests passed on the real harness:** permit, in-place rollback `below_floor`, `floor_conflict`, DB write after the permit, and the transition rules. | Inherited tests disabled in the subclass: exactly 24 |
| tool | 28/30 | `contradiction`: a correct `a1_replayed` (admission precedes the core, and the test reused an admitted capture). `noble`: the fake `/proc` was still bound to the stub port. Both are fixture errors. | The test uses a new capture and re-binds `/proc`. No assertion weakened. |
| integration | **never ran** (import error) | The wrapper reads `/opt/enclave-rpc/manifest.json` at import | Loaded with those two files stubbed, as r7's wrapper suite does. **The real-tool integration suite has therefore never executed in r4, r5 or yet r6.** |
| sampler | 90/91 | The decoder-parity test needs `../coverage/origin_extract.py` | The job builds a layout with the pinned `coverage-stage/origin_extract.py` |

## Independent-review findings against the code (threat model)

**Accidental or untrusted-owner** means the DB/datadir owner (`rpcbase`), an operator error, a crash, or a restore. **Attacker-with-root** can rewrite journals, flags and binaries, and is out of scope.

| # | Finding | r6 status |
|---|---|---|
| 1 | Restart accepts a DB rewritten in place | **Fixed (r5, executed):** `permit-restart` runs the real harness on the stopped DB (checkpoints ≥ floor, header at floor = watermark block, exact dev/ino/size/mtime recorded); the wrapper consumes the permit only if unchanged. **r6:** the anchored start also requires the exact DB identity the launch bound. |
| 2 | Identity checked on another path than served | **Fixed:** `launch_handshake(..., datadir=)` requires `realpath(served datadir) == realpath(launch.bindings.datadir)`, plus exact identity at the anchored start. |
| 3 | Finality directory is a free argument | **Fixed:** only `<launch-dir>/finality` is accepted (`finality_dir`). |
| 4 | Tail truncation or restore goes undetected | **Fixed for recorded and terminal entries:** the launch journal (wrapper-owned, hash-chained) anchors every `bootstrapped` entry (`finalitySeq` plus sha) and a new state `finality-terminal` (only `→ rolled-back`). A missing named entry refuses `finality_journal_rolled_back`. Terminal anchoring is appended under the launch lock and repaired after a crash between the appends. **Gap:** unrecorded qualifications (proved, not yet `record-finality`d) are not anchored, so truncating them only shrinks `prior`. |
| 5 | A1 gate node inherits root's environment | **Fixed:** the harness `header_hash`, `a1_node_gate` and `authenticate` use `{PATH, A/D/G}` only. **Gap:** the harness's reth `Base.run` still inherits the caller's environment minus `BASE_CHAIN` (as r7). |
| 6 | Node binary not pinned | **Fixed:** node must be in the capture module's reviewed `node_accepted` set (`R.accepted_nodes()`), hashed from an open fd and executed as `/proc/self/fd/N` (`pass_fds`) for the gate, header hash and core. |
| 7 | Pinned closures do not cover what runs | **Fixed:** the harness plus `selection.py` (`e6c312f4`) and the wrapper are executed from verified bytes (no path import, no `.pyc`) in both the tool and the producer; the tool is executed from bytes by the producer. **Gap:** `readiness_sampler`, `publish_readiness` and `require_ready` are imported by path from the root-owned install directory (installer-verified, `-I -B`), not self-pinned. |
| 8 | First launch ignores an existing floor | **Fixed:** the producer `arm` refuses `watermark_exists`; the wrapper refuses a pending first-bootstrap start while any floor exists. |
| 9 | Rearm with a caller-supplied config | **Fixed:** `bound_config` requires `configSha256` of the launch and `baseBinarySha256 == HARNESS_BINARY_SHA256` for arm, rearm, permit and quarantine. **Risk:** r7 suites that arm with a config rewritten after `produce` would now refuse; root's run will show it. |
| 10 | Evidence not tied to bytes | **Partly fixed:** the job pins the r2/r5/r7 manifests and the reused logs by sha, uses PATH `/usr/bin:/bin` and `/usr/bin/python3`, and checks every r6 file equals base + patch. A **real** harness A1 rule test (`a1_stale`) was added. **Gaps:** the `test_a2a4`/`make_fixture.mjs` fixtures are still unpinned; the code-hash/ASR/window/symlink A1 rules are exercised only by the harness's and capture module's own suites, not re-added here. |
| 11 | Liveness and accuracy | **Fixed:** every listener on the port must be owned by one process; evidence records the verified/executed byte pins; A1 freshness is re-checked **at append** (`A1_APPEND_MAX_AGE_SEC` 1800, real clock). **Unchanged:** a transient node state may still be recorded `contradicted` (fails closed and strands the launch until rollback/re-anchor); crash recovery between appends still needs the same qualification. |

## Operational wiring (source files; nothing installed)

- **Status** (`units/enclave-base-finality-status.{service,timer}`): root runs `finality_state.py status-publish` every 2 min to `/run/enclave-rpc/base-finality-status.json`.
- **Readiness gate** (`readiness_sampler.py`, gate `post-anchor-finality`). READY needs all of:
  - a root-owned status that is `qualified` for the exact running pid and start time;
  - `publishedAt` ≤ 900 s old (`finality-status-stale`);
  - **the served chain**: the Base EL returns `freshBlockHash` at `freshN` (`served_chain_check`: mismatch is FAIL, missing is INCOMPLETE).
- **Readiness sampling** (`units/enclave-base-readiness.{service,timer}`, `enclave-readiness.sysusers.conf`): the unprivileged sampler runs via `publish_readiness.py` to `/run/enclave-rpc-readiness/latest.json`.
- **Consumers** (`require_ready.py`, `consumer-requires-base-ready.conf`, `enclave-base-consumer-gate.{service,timer}`):
  - each consumer drop-in sets `BindsTo` the base unit and `ExecCondition=require_ready.py check` (a fresh READY report whose finality gate passed);
  - the root timer `enforce`s start/stop of the units listed in `/etc/enclave-rpc/base-consumer-units`;
  - after any Base restart consumers stop and stay stopped until a **post-restart proof** is recorded and republished, and the sampler sees READY.
- **Unattended restart** (`enclave-base-restart-permit.service`, drop-in `50-finality-restart.conf`, `enclave-base-recover.service`):
  - every base start `Requires` the oneshot `permit-restart-auto`, which issues the **same harness-checked permit** with no human step;
  - a crash triggers `OnFailure` → recover (15 s delay) → start (start-limited);
  - a refused permit leaves the node **down**.
- **Producer CLI:** `record-finality <launch-dir> <chain.json> <rpc-url>`, `permit-restart`, `permit-restart-auto`, and `quarantine`.

## Activation (deliberate, not done)

Each module's `reviewed(name)` is true only through its False source constant **or** `/etc/enclave-rpc/finality-activation.json`.
- **Artifact checks:** root-owned 0644, not a symlink; format `enclave-finality-activation/v1`; for that flag, the sha256 of **that module's own installed bytes**.
- **Flags per module:**

  | Flag | Module |
  |---|---|
  | `FINALITY_PROOF_REVIEWED` | producer |
  | `FINALITY_PROTOTYPE_REVIEWED` | tool |
  | `LAUNCH_PRODUCER_REVIEWED` | wrapper |
  | `A1_CAPTURE_REVIEWED` | harness |

- **To activate:** after a passing r6 run and a byte-exact install, run `install_verified.py activate --qualification <out> --rc <rc> --confirm <sha256 of out> --flags F1,F2 --commit`.
- **No source edit,** so every pin stays valid. **Undo:** remove the artifact.

## Root commands

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r6-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r6-tests.sh > $ST/logs/root-finality-r6-tests.out 2>&1; echo $? > $ST/logs/root-finality-r6-tests.rc
```

**Executed** (exact count, no skip):

| Suite | Count |
|---|---|
| tool | 34 |
| real-tool integration | 16 |
| sampler | 92 |
| r7 private copy with the r6 harness/wrapper/producer and ports: reanchor-recovery | 24 |
| same copy: r3-regression | 27 |
| same copy: recovery-existing | 34 |

**Reused** (sha-pinned logs): JS core 20 and baseline 34.

**After a pass:** run `install/install_verified.py` as a dry run, then `--commit` (`--include-wrapper` with the units stopped, `--include-units` then `daemon-reload`), then the deliberate `activate`.

## Below-floor recovery

- **Implemented:** `quarantine <launch-dir> <config>`, an atomic root-only rename of a rolled-back launch's datadir; the floor is untouched.
- **Precise blocker:** a DB **below** the floor can only reach the floor by forward execution. The reviewed pipeline anchors only a DB whose checkpoints are ≥ N ≥ floor (`gate_watermark` plus `step_plan`). No stage provides a reviewed, consumer-isolated forward-sync unit for a quarantined or new datadir. Its output would still need the full A2–A4 re-anchor at a fresh A1 anchor at or above the floor, which already exists.
- **Recovery today:** a newer snapshot at or above the floor, then re-anchor.

## Remaining gaps (exact)

1. **Nothing has executed for r6.** The integration suite has never run (r5's import error). Untested assumptions:
   - `permit-restart-auto` with `gate_stopped` while the base unit has a queued start job, expected to be `inactive`/`failed`;
   - that dependency failure does not trigger `OnFailure`;
   - the sampler rig serving block 1000;
   - r7 suites under the bound-config and served-datadir rules.
2. **Status covers recorded proofs only.** Unrecorded qualifications are not anchored in the launch journal.
3. **Reth environment:** the harness reth `Base.run` still inherits the environment (minus `BASE_CHAIN`).
4. **Readiness Python closure is not self-pinned** beyond the installer.
5. **Real A1 rule tests:** only `a1_stale` is re-added here; the code-hash/ASR/window/symlink tests rely on the harness and capture suites.
6. **Strandings remain:** transient-contradiction stranding and same-qualification crash adoption are unchanged.
7. **Consumer list:** the consumer unit list (`/etc/enclave-rpc/base-consumer-units`) and the actual consumer unit names are root's.
8. **Live verification needed:** installing units, the sysusers account and the actual systemd behaviour all need live guest verification.
9. **No isolated forward-sync for below-floor snapshots** (see the blocker above).
10. **Not established:** live snapshot readiness, SNP, a mainnet proof, and qualification itself. `productionActivated=false`.
