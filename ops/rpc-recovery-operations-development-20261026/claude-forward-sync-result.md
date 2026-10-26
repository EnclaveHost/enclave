# Below-floor forward-sync recovery (base-forward-sync-stage; PREPARED; NOT run; productionActivated=false)

**Stage:** `base-forward-sync-stage/` (new). `SHA256SUMS` sha256 `287a52f9b25e41df…` (full value in the file), 12 files.
- **Untouched:** r6 (frozen, under root test), r5, recovery r7 and every snapshot.
- **What Claude did:** static checks only: `ast.parse` on every file and `bash -n`.
- **Not done:** no tests, builds, queue jobs, SSH, service, storage or network changes, or commits.

## Is it possible with standard Base semantics? Yes, without new flags

- **The pinned invocation:** production runs the pinned release binary as `base --chain mainnet rpc --datadir … --l1-eth-rpc 127.0.0.1:18645 --l1-beacon 127.0.0.1:15052 …`, with an embedded consensus layer and `BASE_NODE_L1_TRUST_RPC=false` (`chain_service.py _start`).
- **What forward sync is:** that same command, without `--bootstrap.anchor`, on another datadir. The node derives from our L1 and fetches from peers.
- **Where safety comes from:** not the sync source. It comes from:
  - the harness proof on the **stopped** DB that the retained floor block is present (`verify`);
  - then the existing full **A2–A4 re-anchor** at a fresh A1 anchor N ≥ floor (`gate_watermark` refuses lower).
- **The one real precondition:** L1 derivation from the snapshot needs **blobs from the snapshot's L1 origin**. Our beacon prunes them (`--prune-blobs true --blob-prune-margin-epochs 0`). `authenticate` refuses `blob_history_missing` when the origin slot's blobs are gone. That case needs blob history restored; it is not bypassed.

## Implemented (`src/forward_sync.py`, root CLI; pinned wrapper/harness/selection executed from verified bytes)

| Step | What it does |
|---|---|
| `authenticate` | Checks, on the **stopped** DB:<br>• the real harness `gate_static`: units stopped, and the completed-download receipt bound to **this** datadir path and dev/ino, the pinned manifest and the base binary;<br>• every stage checkpoint `== SNAPSHOT_HEAD` (an untouched download);<br>• `SNAPSHOT_HEAD < retained floor` (else `not_below_floor`: the normal re-anchor applies);<br>• the production launch is `rolled-back` (else `production_live`);<br>• the beacon still serves the origin-slot blobs.<br>Then it records `authenticated`. |
| `run` (unit) | Starts one node child:<br>• the **pinned release** (sha), hashed from an open fd and executed as `/proc/self/fd/N`;<br>• **only flags from the production invocation**, each confirmed in the pinned binary's own `--help` / `rpc --help` (else `capability`);<br>• **own ports:** loopback HTTP `eth` only on 28545 (progress), rollup RPC 127.0.0.1:29545, p2p 30333 / 9201 / 9232 / 9233, none of them a production, readiness, lease or L1 port (checked);<br>• **no** `--rpc.forwarding-endpoint` and no `--bootstrap.anchor`; L1 = our pair only;<br>• runs as the service user in its own process group, with a **scrubbed environment** (`PATH, LANG, HOME, TMPDIR, BASE_NODE_L1_TRUST_RPC=false`).<br>It stops itself (SIGTERM to the group, bounded grace, then SIGKILL) once its own finalized label is ≥ floor + margin. The label is a stop heuristic only, never evidence. |
| `verify` | On the **stopped** DB: `gate_static`, **every** checkpoint ≥ floor (else `below_floor`), the header at the floor height hashes to the **retained** floor block (else `floor_conflict`), and identity unchanged. Then it records `synced`. |
| `handoff` | Requires `synced`, the DB file identical since, the floor not lowered, and production still rolled back. It records `handed-off`; the only next step is the existing re-anchor (produce with `reanchor`, fresh A1 capture at N ≥ floor), arm, start. **Nothing here starts production or writes the watermark.** |
| `abandon` | An atomic root-only rename of the datadir to `<datadir>.quarantine-sync-<UTC>`. The floor is untouched. |

**Journal and recovery behaviour:**
- **Journal:** `<recoveryRoot>/journal.jsonl` holds canonical, hash-chained, fsynced lines under a flock. Allowed transitions: `authenticated → started ⇄ stopped → synced → handed-off`, and any state `→ abandoned`.
- **Crash or retry:** a `started` record whose pid and start time are gone is recorded as `stopped` (crashed) and resumed; reth resumes from its DB. The datadir identity is re-checked first, and the datadir must have no other open-file holders.

**Units** (`units/`, source only):
- **`enclave-base-forward-sync.service`:**
  - `Conflicts=enclave-base-holder.service` and `Restart=on-failure` (start-limited);
  - `KillMode=mixed`, so the runner stops its child cleanly;
  - `OnSuccess=` triggers the verify unit.
- **`enclave-base-forward-sync-verify.service`:** runs `verify` then `handoff`.
- **Consumer isolation:** no consumer gate, consumer unit or app VM is touched. Isolation comes from identity and ports: consumers, readiness (`:18545`) and status publication never address this node.

**Datadir identity (exact):** the completed-download receipt binds the datadir **path** and dev/ino (`gate_download`). The route therefore runs **in place** on the explicit datadir the authenticated snapshot was downloaded to, and the re-anchor uses that same datadir. "Stop before transfer" means the node is stopped and `verify`/`handoff` recorded before the A2–A4 pipeline takes the DB. A rename would break A2's receipt check, so there is none.

## Tests (`tests/test_forward_sync.py`, 8, real modules)

They run inside the r7 copy with the r6 harness and wrapper and the r6.1 producer, using the **real** harness (`gate_static` with receipt, checkpoints, `read_header`/`header_hash`, `gate_watermark`) on r7's fake reth, and the real wrapper journal/watermark functions. The node child is a fake release binary. Covered:
- an isolated run stops at the target (argv ports ∩ production ports = ∅, no forwarding or anchor flag, L1 pair, scrubbed env);
- authentication refusals: `production_live`, `blob_history_missing`, `not_snapshot`, and `not_below_floor`;
- an unknown flag never runs (`capability`);
- crash then retry resumes;
- `verify` proves the floor block (`below_floor`, `floor_conflict`), then handoff, and the re-anchor still refuses below the floor;
- a DB changed after verify refuses handoff;
- abandon quarantines and keeps the floor.

## Root's r6 run 0549 (rc 1): actionable defects and the scoped r6.1 follow-up (r6 not edited)

| Defect | Fix in this stage |
|---|---|
| **Real code bug:** `bound_config` compared the config binary with the constant `HARNESS_BINARY_SHA256`, not the launch's recorded `bindings.harnessBinarySha256`, so every arm/rearm in the r7 fixtures refused `binary_pin` (r3-regression 14 errors, reanchor-recovery 15) | `r6-followup/producer/base_launch.py` (`integration/r6-producer-bound-binary.patch`): it now requires the launch's binding. In production produce records the pin itself, so nothing is weakened. |
| tool: 3 expectations predate r6's stronger refusals (`finality_dir`, `finality_journal_rolled_back`, `refused`) and 1 fixture lacks `max_finality_status_age` | `integration/r6-tool-test-expectations.patch` (expected codes only; every case still refuses / is not qualified) |
| integration: a third import-time file, `/etc/enclave-rpc-vm/disks.json` | `integration/r6-integration-boot-files.patch` (stubbed `{"disks": {}}`) |
| sampler 92 and recovery-existing 34 | **passed:** not repeated |

**Note:** the r6.1 producer changes the producer's sha. The r6 install manifest is therefore stale for the producer, and root must re-freeze (r6.1) before any install.

## Root command (affected suites only)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-forward-sync-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-forward-sync-tests.guard -- unshare -rn bash $ST/jobs/root-forward-sync-tests.sh > $ST/logs/root-forward-sync-tests.out 2>&1; echo $? > $ST/logs/root-forward-sync-tests.rc
```

**Gates:** the r6 `SHA256SUMS` and r7 manifest, pinned and verified; each follow-up file equals r6 plus its patch.

**Executed** (exact count, no skip):

| Suite | Count | Where |
|---|---|---|
| tool | 34 | private r6.1 copy |
| integration | 16 | private r6.1 copy |
| reanchor-recovery | 24 | r7 copy |
| r3-regression | 27 | r7 copy |
| forward-sync | 8 | r7 copy |

## Remaining gaps (exact)

1. **Nothing run.** The forward-sync suite and the r6.1 fixes are unexecuted. The integration suite has still never run successfully, and may hit further import-time or fixture issues.
2. **Unverified live facts:**
   - the pinned binary's real `--help` output (checked at runtime; a missing flag refuses);
   - the actual sync duration;
   - whether the embedded consensus advances `finalized` from our L1 in a usable time;
   - `OnSuccess=` support in the guest's systemd.
3. **Blob history:** recovery from a snapshot whose L1-origin blobs are already pruned is refused (`blob_history_missing`). It needs restored blob history, which is not provided here.
4. **The re-anchor itself:** the A2–A4 re-anchor after hand-off is the existing pipeline. It still needs a fresh real A1 capture at N ≥ floor, under `A1_CAPTURE_REVIEWED` (HOLD until activation).
5. **Not addressed here** (they don't intersect this route):
   - harness reth `Base.run` environment inheritance. This route's units start with systemd's clean environment and its own node child is scrubbed.
   - unrecorded-qualification anchoring and append-crash stranding.
6. **Not established:** the r6 security review (da0's) and the live snapshot download.
