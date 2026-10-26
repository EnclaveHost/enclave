# r6 operational fixes: readiness admission, flapping, installer (PREPARED and FROZEN; every suite UNRUN)

**Stage:** `base-finality-proof-stage/r6-ops-fixes/` (frozen). Its contents:
- `SHA256SUMS`, sha256 `436063d6e9a6be14807eb2737d38f5c01f2651788bf82c151510c891235c5aef`. It verifies over the 60 files, logs excluded.
- `tree/`: a private, coherent copy of r6 with the fixes applied. `tree/SHA256SUMS` is `efc7d23d…20e`, and `tree/install/MANIFEST.json` was re-pinned to the edited files, with 0 mismatches. No `__pycache__` is present.
- `patches/` (diffs against frozen r6), `jobs/root-ops-fixes-tests.sh` and the new tests in `tree/tests/`.

**Not touched:** r6 and every other stage. Nothing was executed except `ast.parse` and `bash -n`. No builds, queue jobs, installs or commits.

## Patches (against r6)
| Patch (sha256) | Change |
|---|---|
| `readiness_require_ready.py.patch` `fb066ae2…49fb` | **Admission now checks the live holder and root's current status, not the report's age alone.** Each check is below |
| `readiness_readiness_sampler.py.patch` `7d34f3dc…0b74` | The post-anchor-finality gate's `info` also carries `startTime` (2 lines) |
| `units_consumer-requires-base-ready.conf.patch` `a8f17ae0…a1db` | `BindsTo=` is replaced by **`Requisite=` + `After=` + `PartOf=`**. Starting a consumer can no longer start a stopped or permit-refused holder. A holder crash is caught by `enforce` (30 s) and `ExecCondition` |
| `readiness_publish_readiness.py.patch` `da547307…7019` | **`--settings <file>` only:** the file must be root-owned, a regular file, not group/other writable and not a symlink, with exactly the REQUIRED keys plus optional allowed ones, type-checked. Anything missing or invalid publishes a **NOT-READY** `latest.json`, replacing any older READY, and exits 4 |
| `units_enclave-base-readiness.service.patch` `59d0aa64…fa1` | `ExecStart=… publish_readiness.py /run/enclave-rpc-readiness --settings /etc/enclave-rpc/readiness-settings.json` |
| `install_install_verified.py.patch` `33bbd473…a6cd` | **Preflight before any mutation, then a journaled commit with exact rollback.** Details below |
| `install_MANIFEST.json.patch` `3e2d670b…3073` | Re-pins exactly the 5 edited manifest sources (sampler, publisher, require_ready, consumer drop-in, readiness unit) |

**What `require_ready.ready()` now requires:**
1. The report is READY with one passing post-anchor-finality gate whose `info` has `{pid, startTime, entrySha256}`. A report from an older sampler, without `startTime`, is refused.
2. The report is within ONE sampling cycle: its own run (at most 3900 s) plus 900 s grace.
3. `enclave-base-holder.service` is `active`, its `MainPID` equals the pid, and that pid's `/proc` start time equals `startTime`.
4. Root's `/run/enclave-rpc/base-finality-status.json` is root-owned and current (at most 900 s old; it is republished every 2 min). It must be `qualified`, with the same entry, freshN and freshBlockHash, and the same pid and startTime.

**What `enforce` now does:**
- It controls only plain `.service` units that are not VM, hypervisor, machine, `enclave-base-*` or `systemd-*` units, and whose `DropInPaths` include a file byte-equal to the reviewed `/etc/enclave-rpc/consumer-requires-base-ready.conf`.
- Any invalid line means **nothing is touched**.
- Start happens only when ready (the holder is then necessarily active). Stop is always allowed.

**What the installer now does:**
- **Preflight (reads only):** source shas, `flagsFalse`, wrapper not running, safe parents, the existing-destination policy, extra files in tree destinations, and that no journal is still open.
- **Commit:** a journal (`/var/lib/enclave-rpc/install-journal/<stamp>.json`) is written before the first write.
- **Backups are COPIES** (a new inode, 0600). The r6 hardlink-plus-chmod changed the live file's mode; this does not.
- **Failure:** any failure rolls back exactly: original bytes, mode and owner, created files and directories removed, any writer's temp files deleted.
- **Interruption:** an interrupted commit leaves the journal `open`. New subcommand `recover` restores it.
- **While a journal is open,** install **and activation** refuse. `activate` also writes its artifact through the same journaled commit.
- **Cosmetic:** the refusal text now says r6, and the qualification lines checked are unchanged.

## Root test command (UNRUN), offline, cap 512
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh finality-ops-fixes-1 512 unshare -rn bash base-finality-proof-stage/r6-ops-fixes/jobs/root-ops-fixes-tests.sh
```
The job (sha256 `e5bb50ce…565e8f`) verifies the stage and tree SHA256SUMS first. PASS requires `## finality-ops-fixes rc=0`, with each suite at rc 0, exact `Ran N`, last line `OK`, and no skip, expected failure or unexpected success.

| Suite (UNRUN) | Expected | Covers |
|---|---|---|
| `tests/test_ops_readiness.py` | **25** | **Gate (14):** a realistic 960 s cycle 950 s old stays READY; the frozen r6 helper refused that same report (documents the flapping); a fresh old READY with a dead, reused or different holder pid refuses; holder inactive, failed, activating or deactivating refuses; revoked status, changed entry or block, status for another process, a stopped publisher or a non-root/writable status refuses, even with a fresh READY; an older sampler without startTime refuses; a report beyond one cycle refuses, as does an implausible run; a non-READY or untrusted report refuses. **Enforce (6):** not-ready stops only the listed units; ready starts only those and never the holder; VM, hypervisor, base and system units are never controlled (nothing touched); a missing or unreviewed drop-in is refused; a writable units file is refused; the drop-in has no Requires, BindsTo, Wants or Upholds on the holder. **Publisher (4):** valid settings pass every required input; missing, extra, bad, relative, group-writable or symlink settings fail closed with a NOT-READY report; the gate refuses that stub; the unit uses only `--settings`. **Sampler (1):** `info` carries `startTime` |
| `tests/test_ops_installer.py` | **8** | A late source refusal and a late destination or parent refusal change nothing, byte and mode. An extra file in a tree destination is refused before any write. An injected mid-commit failure restores everything exactly, including the odd 0700 mode, and removes the created directory; the journal ends `rolled-back`. The backup is a copy (another inode, 0600) and the live mode is unchanged. An interrupted commit blocks install and activation until `recover` restores exactly. Activation refuses a partial or altered set. Only the exact r6 qualification lines are accepted |
| r6 `readiness/test_readiness_sampler.py` against the patched sampler | **92** | A regression check for the added `startTime` field; r6's actual baseline was 92 OK |

## Readiness config inputs still MISSING (fail closed until root supplies them)
- **`/etc/enclave-rpc/readiness-settings.json`** (root-owned 0644). REQUIRED keys:
  - `coverage-receipt`, `coverage-verdict`, `coverage-origin` (absolute paths to the reviewed coverage artifacts);
  - `finality-status` (normally `/run/enclave-rpc/base-finality-status.json`);
  - `expect-snapshot-manifest-sha256`, `expect-chain-config-sha256`.
  
  OPTIONAL keys: `expect-kzg-sha256`, `expect-base-sha256` (the sampler has pinned defaults), `samples`, `interval`, `min-window` and `max-finality-status-age`.
  
  **No values were invented.** Until the real coverage artifacts and pins exist, every sample publishes NOT-READY, so consumers stay stopped.
- **The settings file is not in `MANIFEST.json`.** It is site data, written by root after review.
- **The consumer drop-in must be linked by root into each reviewed RPC consumer unit's `.d/`.** `/etc/enclave-rpc/base-consumer-units` must list only those units and never app VM units, and `enforce` refuses otherwise.

## Caveats
- **Nothing was run:** all 125 expected tests, and the job itself, are UNRUN.
- **Unchecked by me:** root's `jobs/check-r6-stale-ready-0555.py` (`logs/root-r6-stale-ready-0555.{out,rc}` now exist). I did not read its result.
- **Crash window:** after `BindsTo=` is removed, a holder **crash** no longer stops consumers instantly; they stop at the next `enforce` tick, within about 30 s. An explicit holder stop or restart still propagates through `PartOf=`.
- **Systemd semantics:** `Requisite=`/`PartOf=` behaviour and `DropInPaths` output are standard systemd semantics, but no test here exercises a real systemd.
- **Untested wiring:** the tests inject the `systemctl` and `/proc` readers, so the production default path (`systemctl show …`) is not exercised offline.
- **Open r6 suite failures:** r6's tool and integration failures (root run 0549) are untouched here. Below-floor sync (50cf) and test-fixture fixes (6d24) are separate.
