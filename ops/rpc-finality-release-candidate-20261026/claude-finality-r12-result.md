# base-finality-proof-stage/r12: the one final composition (FROZEN, PREPARED; qualification PENDING; not installed; not activated)

**Stage:** `base-finality-proof-stage/r12`, `SHA256SUMS` `6303a5c5aa0e16bbe1ac733f123c6147421dd91b6a846d6bae4d4d03940fc372`, 88 files (`logs/`, `bundle/` excluded).
- **r11 status:** frozen (`a890137f…`) and never run, superseded by r12.
- **What Claude did:** static checks only. The job's own checks were run locally:
  - `composition OK r12` (78 r11 copies, 3 edits = r11 + `integration-r12/*.patch`, 6 new) and `composition OK r11`;
  - the r10 identity check;
  - `pins + manifest closure OK: 55 files 14 trees`;
  - every pinned receipt (passing **and** failing) matches its sha;
  - all Python parses, and both jobs pass `bash -n`.
- **Not done:** no tests, live operations or commits.
- **Untouched:** r10, r11, every fix stage and `source/`.

## Root's actual failure and the narrow fix

**What failed:** run 0728 (`r10-ops-followup-r2/logs/root-r10-ops-followup-r2-tests-20261026T072804Z-1136677/ops-installer.txt`) was **17/18**. reproof was 17/17, including all 4 crash boundaries.

**Cause:** `test_a_config_appearing_after_preflight_is_not_written_over` compared the whole tree before and after. `commit` creates and **retains** the install journal (state `rolled-back`, plus backups) by design, and with it the previously absent parents `/var`, `/var/lib` and `/var/lib/enclave-rpc`. That retention is the record `recover`/audit rely on, so the product is unchanged.

**The fix** (`tests/test_ops_installer.py` `deab7ae3…`, still 18 tests). It accounts for every part explicitly; there is no broad filesystem ignore:
1. **Before:** the journal's parents are asserted absent.
2. **After the refused commit, before any cleanup:** root's late `/etc/late.json` is a regular file with **exact bytes and mode 0600**.
3. **The journal is retained:** `state == 'rolled-back'`, its ops are exactly `[/opt/x/a.py, /opt/x/b.py, /opt/y/c.py, /etc/late.json]`, and every step is `rolled-back`.
4. **The backups are retained** with exactly the original bytes (`opt/x/a.py` = `OLD A`, `opt/x/b.py` = `OLD B`).
5. **Every pre-existing path is restored exactly** (bytes and mode). The created `c.py` and `/opt/y` are gone.
6. **Accounted additions:** the only additions are exactly the 3 journal parents (directories) and exactly the journal subtree (`install-journal`, `late.json`, `late.backup/opt/x/{a,b}.py`).

**Other r12 edits:**
- **Installer strings:** `install_verified.py` (`4e78993a…`) qualification strings are now `## finality-r12 rc=0` / `## r12 SHA256SUMS`. The test refuses r9, r10 **and r11** runs.
- **Checkpoint expiry corrected** (`install/MISSING.md`; also corrected in the r11 report): about **2026-11-01T19:22Z**. The age is bound to checkpoint slot 15511008 (2026-10-25T19:21:59Z) + 604800 s, not the 19:38:24Z record time.
- **Nothing else changed:** no other product byte or pin. The MANIFEST stays at r11's `c8da92df…` (reproof `cc9ff0b4`, forward_sync `b41e71a3`; harness, capture, tool, producer, wrapper, units and flags are as in r10; all review flags False).

## Root jobs (UNRUN), in order

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r12
# 1. the full installer suite (18) on the frozen r12 bytes
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-r12-installer-18.guard -- unshare -rn bash $ST/jobs/root-r12-installer-18.sh > $ST/logs/root-r12-installer-18.out 2>&1; echo $? > $ST/logs/root-r12-installer-18.rc
# 2. workstation: assemble the hash-checked bundle into r12/bundle
/usr/bin/python3 $ST/tools/assemble_bundle.py
# 3. the composition qualification
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r12-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r12-tests.sh > $ST/logs/root-finality-r12-tests.out 2>&1; echo $? > $ST/logs/root-finality-r12-tests.rc
```

**Installer job** (`jobs/root-r12-installer-18.sh` `313384d6…`): r12 `SHA256SUMS`, then ops-installer **18** in a private copy. It ends with `## r12-installer rc=`.

**Qualification job** (`jobs/root-finality-r12-tests.sh` `0243cc70…`):
- **Setup:**
  - loopback, no route;
  - the `SHA256SUMS` of r12, r11, r10, the 4 fix stages and the closure stage, each pinned and verified;
  - the recovery-r7, a2-v2, help and fake pins;
  - **both compositions** (r12 = r11 + integration-r12; r11 = r10/fix stages + integration-r11);
  - **r10 identity:** every file outside the changed set equals r10, and nothing was dropped;
  - the pin cascade, flags and manifest closure;
  - the **full bundle closure** (FAIL, not skip, if it is not assembled).
- **Runs:** ops-installer 18, forward-sync-r2 6, reanchor-recovery 25, r62-isolated 2, forward-sync 8. The last three import the r2 recovery fixture; forward_sync changed.
- **Reused, explicit passing receipts** (receipt sha, `Ran N` and `OK` checked; bytes proven identical):

| Receipt | Count |
|---|---|
| reproof (ops-followup-r2 run 0728) | 17 |
| capture-r10 (capture-fixture-fix run 0706) | 3 |
| r10 run 0702: tool | 34 |
| r10 run 0702: runtime-pin | 10 |
| r10 run 0702: integration | 17 |
| r10 run 0702: parser | 8 + 8 |
| r10 run 0702: capture-closure | 14 |
| r10 run 0702: r3-regression | 28 |
| ops-readiness | 27 |
| sampler | 93 |
| recovery-existing | 34 |
| JS core | 20 |

- **Failing receipts kept and pinned as HISTORY:** `logs/root-finality-r10-0702.out` (rc 1: capture-r10, reanchor-recovery 24/25, forward-sync 5F+1E) and the 0728 `ops-installer.txt` (17/18). Each is superseded by the reruns above.
- **End lines:** `## r12 SHA256SUMS <sha>` and `## finality-r12 rc=<rc>`, which are exactly what the r12 installer requires.

**Recovery-fixture-r2:** root's result is still pending. The r12 job reruns reanchor-recovery 25 on those exact bytes, so that result informs the run but is not a precondition.

## Qualification vs activation

1. A passing r12 job is **qualification only**.
2. Guest canary r3 (6d24): the capture bytes `47c49b11` are unchanged since r10.
3. Byte-exact install (existing configs kept).
4. `install_verified.py runtime-dirs --commit`, then `--check`.
5. `activate --confirm <sha of the r12 qualification output>`.
6. First bootstrap / reproof.
7. Live safe/finalized chain readiness and consumer admission, separately and later.

**Nothing has been installed or activated.**

## Remaining (actual)

- **r12 is UNRUN;** the recovery-fixture-r2 result is pending.
- **Still missing:**
  - coverage evidence;
  - the bound first-bootstrap harness config;
  - the consumer unit list;
  - the forward-sync per-recovery values;
  - a renewed checkpoint before about 2026-11-01T19:22Z.
- **Workstation steps:** assembling the bundle reads workstation origins (`bundle-origin.json`). The installed closure is stage-relative and hash-pinned.
- **Ambiguous capture attempts** are released by root by hand only.
