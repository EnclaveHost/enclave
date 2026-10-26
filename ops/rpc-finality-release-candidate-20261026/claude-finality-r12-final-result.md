# base-finality-proof-stage/r12-final: THE final composition (FROZEN, PREPARED; qualification PENDING; not installed; not activated)

**Stage:** `base-finality-proof-stage/r12-final`, `SHA256SUMS` `9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e`, 90 files (`logs/`, `bundle/` excluded). Immutable after this freeze.
- **What it is:** frozen r12 (`6303a5c5…`, never run) + root's `r10-recovery-fixture-fix-r3` test + the final installer qualification strings. No other byte differs from r12.
- **Overall status:** **No overall PASS is claimed.** Root's job has not run.

**Static checks Claude ran locally** (the job's own checks):
- `composition OK r12-final` (80 r12 copies, 1 r3 copy, 3 edits = r12 + `integration-r12-final/*.patch`, 5 new);
- the r10 identity check;
- `pins + manifest closure OK: 55 files 14 trees`;
- all 14 pinned receipts (passing and history) match their shas;
- all Python parses, and the job passes `bash -n`.

**Not done:** no tests, live operations or commits. Every other stage and `source/` is untouched.

| File | sha256 | Origin |
|---|---|---|
| `tests/r7-ported/test_reanchor_recovery.py` | `932e17a6…` | **copy** of root's r10-recovery-fixture-fix-r3 (`SHA256SUMS` `8f91139b…`). Reviewed: it permits and **asserts present** exactly `(('stage','unwind','--help'),'help')`, and still rejects every `A.MUTATING` call and any other unwind. The product's `state_below_anchor` refusal is unchanged. |
| `install/install_verified.py` | `690a1c99…` | r12 + strings `## finality-r12-final rc=0` / `## r12-final SHA256SUMS` |
| `tests/test_ops_installer.py` (18) | `d5c3bd7e…` | r12 (with the late-config journal fix) + final strings; r9/r10/r11/**r12** runs refused |
| `install/MANIFEST.json` | `c8da92df…` | unchanged since r11 |
| everything else | – | r12 bytes (the full cascade from r10/r11/r12 is unchanged) |

**Pins** (unchanged; all review flags False; checkpoint expiry about **2026-11-01T19:22Z**, slot-bound):

| Module | sha |
|---|---|
| capture | `47c49b11` |
| harness | `6c1d0b1b` |
| first harness | `dbd4cbe3` |
| tool | `218bbfe5` |
| producer | `2f9450cd` |
| wrapper | `4fc3b970` |
| reproof | `cc9ff0b4` |
| forward_sync | `b41e71a3` |

## The one root job: `jobs/root-finality-r12-final.sh` (`5ef4a078…`)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r12-final
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log $ST/logs/root-finality-r12-final.guard -- unshare -rn bash $ST/jobs/root-finality-r12-final.sh > $ST/logs/root-finality-r12-final.out 2>&1; echo $? > $ST/logs/root-finality-r12-final.rc
```

**Order inside the job:**
1. **Setup** (SETUP rc 9 on any mismatch):
   - loopback, no route;
   - the `SHA256SUMS` of r12-final, r12, r11, r10, the 4 fix stages + r3 fixture and the closure stage, each pinned **and** verified;
   - the recovery-r7, a2-v2, help and fake pins.
2. **Three compositions** (r12-final = r12/r3 + patches; r12 = r11 + patches; r11 = r10/fix stages + patches), **r10 identity**, and the pin cascade, flags and manifest closure.
3. **Receipts:** reused receipts and pinned HISTORY.
4. **Bundle:** `tools/assemble_bundle.py` (origin sha checked before, the exact files after) into `r12-final/bundle`, then the **full bundle closure** against the MANIFEST. A failure in either is FAIL.
5. **Runs:**

| Suite | Count | Why |
|---|---|---|
| ops-installer | 18 | changed fixture + strings |
| forward-sync-r2 | 6 | forward_sync changed |
| reanchor-recovery | 25 | the full suite (r3 fixture) |
| r62-isolated | 2 | imports the fixture |
| forward-sync | 8 | forward_sync + fixture |

The pass rule is an exact `Ran N`, a bare `OK`, rc 0 and no skip.

6. **End lines:** `## r12-final SHA256SUMS <sha>` and `## finality-r12-final rc=<rc>`, which are exactly what this stage's installer requires.

**Reused, explicit passing receipts** (sha, `Ran N` and `OK` checked; bytes proven identical):

| Receipt | Count |
|---|---|
| reproof (0728, all 4 crash boundaries) | 17 |
| capture-r10 (0706) | 3 |
| r10 0702: tool | 34 |
| r10 0702: runtime-pin | 10 |
| r10 0702: integration | 17 |
| r10 0702: parser | 8 + 8 |
| r10 0702: capture-closure | 14 |
| r10 0702: r3-regression | 28 |
| ops-readiness | 27 |
| sampler | 93 |
| recovery-existing | 34 |
| JS core | 20 |

**HISTORY, pinned and never dropped:**
- r10 0702 rc 1;
- ops-followup-r2 0728 ops-installer 17/18;
- recovery-fixture-r2 FAIL (`reanchor-bounds.txt`);
- recovery-fixture-r3 first attempt 0732 (no test ran);
- r3 0733 single-test PASS (informational; the full 25 reruns here).

**Memory:** `--mib 768`. Prior actual peaks were 234 MiB (r10 full suite) and 187 MiB (reproof 17). The queue's 16 GiB host floor is kept.

## Qualification vs activation

A passing run here is **qualification only**. After it come:
1. guest canary r3 / guest diagnostics (root, separate);
2. byte-exact install;
3. `install_verified.py runtime-dirs --commit`, then `--check`;
4. `install_verified.py activate --confirm <sha of this job's .out>`;
5. first bootstrap / reproof;
6. live safe/finalized chain readiness and consumer admission, separately and later.

Nothing is installed or activated.

## Remaining (actual)

- **The r12-final job is UNRUN.**
- **Still missing:**
  - coverage evidence;
  - the bound first-bootstrap harness config;
  - the consumer unit list;
  - the forward-sync per-recovery values;
  - a renewed checkpoint before about 2026-11-01T19:22Z.
- **Ambiguous capture attempts** are released by root by hand.
- **Bundle origins** are workstation paths. The installed closure is stage-relative and hash-pinned.
