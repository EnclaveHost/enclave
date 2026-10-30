# base-finality-proof-stage/r6: operational and security review (read-only; nothing edited, run or installed)

**Scope:** the stage `SHA256SUMS` verifies. Every finding below was re-read at the exact current lines.
- **Excluded:** below-floor sync, which is handled separately, and the r4 findings that r6 addresses.
- **Root's actual run** (`logs/root-finality-r6-0549.out`) is **FAIL**:
  - **tool:** `Ran 34`, with 3 failures and 1 error. The test namespace lacks `max_finality_status_age`; there are `'finality_dir' != 'path'` and `'finality_journal_rolled_back' != 'terminal'` mismatches, and the status-survives test fails.
  - **integration:** it did not run (`FileNotFoundError: /etc/enclave-rpc-vm/disks.json`), so the suite depends on a host file.
  - **So r6 is not qualified as shipped.** Also, the installer requires `## finality-r6 rc=0` (`install/install_verified.py:40`), which root's run does not have.

## Findings (attacker / accident class noted; none needs malicious root replacing code)

**1. HIGH (availability): consumers are stopped and started every readiness cycle.**
- **Cause:** `readiness/require_ready.py:12` sets `MAX_AGE_SEC = 600` on the report's `finishedAt` (`:32-34`). But one sampler run is 8 samples × 120 s (`readiness/readiness_sampler.py:970-972`, about 15–16 min), `finishedAt` is set at the end (`:946`), and the next run starts 30 s after the last one ends (`units/enclave-base-readiness.timer`). So `latest.json` is 600 to about 960 s old for roughly the last 6 minutes of **every** cycle.
- **Effect:** in that window `ready()` is false, so `enforce` (every 30 s, `require_ready.py:43-45`) runs `systemctl stop` on **every listed consumer**, then starts them again when the next report lands. Consumer starts in that window are also skipped by `ExecCondition` (`units/consumer-requires-base-ready.conf`). This happens on a healthy node with no attacker.
- **Minimal fix:** make the bound cover a full cycle with margin, for example `MAX_AGE_SEC = 1500`. Better, derive it from the published report: require `finishedAt - startedAt <= samples*interval + slack` and `age <= (finishedAt - startedAt) + 300`. Keep the post-restart check from finding 2 as the real freshness guard.

**2. HIGH (security / availability): a READY report from before a restart is accepted after the restart.**
- **Cause:** `require_ready.ready()` (`:15-35`) checks only `overall`, `acceptance`, the gate `status` and age. The sampler's gate binds to the node process only at sample time (`readiness_sampler.py:320-325`, pid plus `/proc/<pid>/stat` starttime). Its stored `info` (`:334`) keeps `pid` but **not** `startTime`, and `require_ready` re-checks neither.
- **Failure:** after a Base crash or restart (or an accidental DB restore followed by a permitted restart), the previous report stays READY for up to `MAX_AGE_SEC`.
  - `enforce` restarts consumers against a node with **no post-restart proof**. That contradicts the module's own docstring ("After any Base restart that fails until a post-restart proof…").
  - Each consumer has `BindsTo=enclave-base-holder.service` (implying Requires=). So while the holder is down, `systemctl start <consumer>` also queues a holder start, and through the drop-in `Requires=enclave-base-restart-permit.service` it re-runs the heavy stopped-DB permit every 30 s for that window. This happens even when the permit has deliberately refused, which is meant to leave the node down.
- **Minimal fix:**
  - in the sampler `info`, also emit `startTime: p['startTime']`;
  - in `require_ready.ready()`, require the gate `info.pid` to equal `systemctl show -p MainPID --value enclave-base-holder.service` and `/proc/<pid>/stat` field 22 to equal `info.startTime`, otherwise return not ready.
  
  This also stops consumer starts from pulling the holder up. The holder's MainPID is the node, since the wrapper execs it.

**3. MEDIUM (accident → mixed install): the installer interleaves verification with committed writes.**
- **Cause:** in `install/install_verified.py:168-190`, each manifest entry is verified (`:176-180`, `:173`) and then written immediately (`:181` → `put`, which renames into place, `:105`). Trees are written file by file (`:188`), and the tree-destination check runs **after** writing (`:189-190`). `put` also refuses mid-loop when a destination differs and `--replace` was not given (`:90-91`).
- **Failure:** with `--commit`, any later refusal leaves earlier files already replaced while the rest stay old. Examples: an entry whose source changed, a `flagsFalse` mismatch, the wrapper running, an existing differing file, or an extra file in a tree destination. With `--replace`, `.pre-<stamp>` copies exist but nothing restores them, and without it there are no copies at all.
  - A mixed `/opt/enclave-rpc` set (for example a new `base_launch.py` with an old `chain_service.py`) means the next restart's `permit-restart-auto` can refuse, so the node stays down.
  - Activation correctly refuses on a mixed set (`:133-138`), so this is about availability, not wrongful activation.
- **Minimal fix:** split into two passes. Pass 1 verifies everything for all files and trees (sha, flags, wrapper not running, destination parents, existing-file policy, and the tree destination holding no extra files) without writing. Pass 2 does the writes. On any pass-2 failure, restore from the `.pre-<stamp>` links, or print the exact restore list.

**4. LOW-MEDIUM (deployability): the installer and the runner disagree on the receipt.** `install_verified.py:40` requires `## finality-r6 rc=0` and `## r6 SHA256SUMS <sha>`, but its refusal text and manifest-format message say r5 (`:41`, `:166`). Root should confirm `jobs/root-finality-r6-tests.sh` prints exactly those two lines, or no qualified install is possible. That cannot be confirmed from the failed 0549 run, which ended at FAIL.

## Checked, nothing material
- **Activation artifact:**
  - it pins, per flag, the sha of the **installed** module and requires every non-unit manifest file to be installed byte-exact and root-owned (`:133-145`);
  - a later re-install changes the module sha, so activation lapses, which fails closed;
  - undo means removing the artifact; the previous artifact is kept as `.pre-<stamp>`.
- **systemd:**
  - **Permit and recover:** the permit is a `oneshot` pulled by `Requires=`/`After=` on each holder start; a refused permit fails the holder start job without entering `failed`, so `OnFailure=` recovery does not loop; a crash then triggers recover (15 s, then `start --no-block`), bounded by `StartLimitBurst=5/1h`.
  - **No cycle:** the dependency chain holder → permit is one-way, and consumers and the gate only pull the holder.
  - **Status publisher:** `ProtectSystem=strict` with `ReadWritePaths=/run/enclave-rpc` matches its only write (`src/finality_state.py publish_status`: temp file with `O_EXCL|O_NOFOLLOW`, then replace and directory fsync); `status` takes no lock.
- **Report files:** `require_ready` opens the report with `O_NOFOLLOW` and checks owner and mode before trusting it.

## Notes for root
- **Consumer list:** list only RPC consumers in `/etc/enclave-rpc/base-consumer-units`. `enforce` stops whatever is listed, and the drop-in's `BindsTo=` stops a listed unit on any holder stop. Hosted app VM units must not be listed, or they are stopped on every Base restart and, until finding 1 is fixed, every sampler cycle.
- **Not established:** nothing was run, and the root run's tool and integration failures above are open.
