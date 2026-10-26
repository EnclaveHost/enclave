# base-finality-proof-stage/r11: the one final composition (FROZEN, PREPARED; never run; SUPERSEDED by r12, see claude-finality-r12-result.md)

**Stage:** `base-finality-proof-stage/r11`, `SHA256SUMS` `a890137f6c14a0c927fb9e4109d63f8744fd754352851c7d01ab26807f23ed7c`, 84 files (`logs/`, `bundle/` excluded).
- **What Claude did:** static checks only. The job's own checks were run locally:
  - `composition OK` (65 r10 copies, 6 fix-stage copies, 5 edits each = origin + `integration-r11/*.patch`, 7 new);
  - the identity check `r11 = r10 except [the 18 changed/new files]`;
  - `pins + manifest closure OK: 55 files 14 trees`;
  - every Python file parses, and the job passes `bash -n`.
- **Not done:** no tests, builds, queue jobs, installs, live operations or commits.
- **Untouched:** r10, every fix stage and `source/`.

## Composition (`COMPOSITION.tsv` `dfd7b9c2…`: path, sha, kind, origin, origin path, patch)

| File | sha (prefix) | Origin |
|---|---|---|
| `src/reproof.py` | `cc9ff0b41dc04a5c` | r10-ops-followup-r2 (journal-aware retention), copy |
| `tests/test_reproof.py` (17) | – | r10-ops-followup-r2, copy |
| `install/install_verified.py` | `18c3342c51cd4951` | r10-ops-followup-r2 + `install_install_verified.py-r11` (qualification strings `## finality-r11 rc=0` / `## r11 SHA256SUMS`) |
| `tests/test_ops_installer.py` (18) | – | r10-ops-followup-r2 + r11 strings; an r9 **and an r10** run are refused |
| `recovery/forward_sync.py` | `b41e71a30140bf2b` | r10-forward-log-fix (`os.urandom(16)` suffix on the exclusive log names), copy |
| `tests/forward-sync/test_forward_sync.py` (8) | – | r10-forward-log-fix (forward repair + frozen-clock crash-retry: 4 distinct files, first-attempt bytes unchanged), copy |
| `tests/test_capture_r10.py` (3) | – | r10-capture-fixture-fix, copy |
| `tests/r7-ported/test_reanchor_recovery.py` (25) | – | r10-recovery-fixture-fix-r2, copy |
| `install/MANIFEST.json` | `c8da92df2cb6eb9a` | r10-ops-followup-r2 (reproof sha) + r11: `forward_sync.py` `0aeaaaeb` → `b41e71a3`. Only these two shas differ from r10 |
| `install/MISSING.md`, `CANARY-R3-RECIPE.md` | – | r10 + r11 rows: the runtime-dirs step, the ambiguous-capture release policy, and that the canary bytes are unchanged |
| everything else | – | byte copies of r10 |

**Pin cascade, checked:**
- `forward_sync.py` and `reproof.py` are pinned by no module, only by the MANIFEST.
- `install_verified.py` is not an installed file.
- So there is no change to the harness (`6c1d0b1b`), first harness (`dbd4cbe3`), capture (`47c49b11`), tool (`218bbfe5`), producer (`2f9450cd`), wrapper (`4fc3b970`), units, `bundle-origin.json` or the review flags (all False, `RETH_ENV_PASS = ()`).
- The capture bytes are r10's, so 6d24's canary r3 on the r10 recipe is valid for r11.

## Review notes (asked)

**r2 durable-digest retention:** the misclassification direction is always "preserve".
- **How the barrier works:** the digest covers every non-empty file under the launch directory, plus the A1 ledger and the watermark store. `qualify` writes only to the finality journal, the launch journal (terminal anchoring) and the ledger (after `rules`); `launch_lock` only opens a file. Any change, including an unrelated writer between a kill and the next run, means "ambiguous", so the bytes are kept.
- **Bounded cleanup:** only attempts that failed before the barrier, or whose records are unchanged after it, are retired (newest 2 kept).
- **Fail-closed edge:** if `_durable` cannot read a record file, the sweep raises, and reproof exits 1 until root fixes it. Nothing is deleted.
- **History:** the file is unbounded, but tiny.
- **Ambiguous attempts:** these are released by hand only (`MISSING.md` row).

**Installer:**
- **Configs:** an existing config is never replaced, even with `--replace --include-configs`.
- **Late paths:** a path that appears after preflight is never written over.
- **`runtime-dirs`:** journaled and idempotent; it removes only what it created, and leaves existing paths unchanged (a wrong one refuses).
- **Activation:** `activate` is unchanged (the artifact `/etc/enclave-rpc/finality-activation.json`) and does not itself check the runtime dirs. Their loaders refuse at use if they are missing.

## Root job (UNRUN): `jobs/root-finality-r11-tests.sh` (`356e5b514d2366f5…`)

```
# 1. workstation: assemble the hash-checked bundle into r11/bundle (excluded from SHA256SUMS)
/usr/bin/python3 /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r11/tools/assemble_bundle.py
# 2. the job
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r11
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r11-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r11-tests.sh > $ST/logs/root-finality-r11-tests.out 2>&1; echo $? > $ST/logs/root-finality-r11-tests.rc
```

**Setup, as SETUP rc 9 on any mismatch:**
- loopback and no route;
- r11 `SHA256SUMS`;
- the `SHA256SUMS` of r10, ops-followup-r2, forward-log-fix, capture-fixture-fix, recovery-fixture-fix-r2 and the closure stage, each pinned **and** verified;
- the recovery-r7 manifest, a2-v2 `a2a4.py`, live help and the pinned fake;
- every `COMPOSITION.tsv` row (copy, or origin + patch);
- **r10 identity:** every file outside the changed set is byte-identical to r10, and nothing was dropped;
- the full pin cascade, flags and manifest closure (the r10 check, recomputed over r11).

**Bundle closure:** every bundle file sha and every tree's exact file set and shas against the MANIFEST. If `bundle/` is missing or wrong this is **FAIL**, not skip; the suites still run.

**Runs** (changed code, changed tests, or a changed fixture they import):

| Suite | Count |
|---|---|
| capture-r10 | 3 |
| reproof | 17 |
| ops-installer | 18 |
| forward-sync-r2 | 6 (forward_sync changed) |
| reanchor-recovery | 25 |
| r62-isolated | 2 (imports the changed recovery fixture) |
| forward-sync | 8 (forward_sync and its fixture changed) |

The pass rule is an exact `Ran N`, a bare `OK`, rc 0 and no skip or expected failure.

**Reused only with explicit passing receipts.** For each, the receipt sha is pinned, and `Ran N` plus a final `OK` are checked (JS: `# pass 20`, `# fail 0`). Their code and tests are proven byte-identical by the identity check, and grep confirms no reused test imports reproof, forward_sync, the installer or the install manifest.

| Receipt | Count |
|---|---|
| r10 run 0702: tool | 34 |
| r10 run 0702: runtime-pin | 10 |
| r10 run 0702: integration | 17 |
| r10 run 0702: parser-recovery | 8 |
| r10 run 0702: parser-first | 8 |
| r10 run 0702: capture-closure | 14 |
| r10 run 0702: r3-regression | 28 |
| ops-readiness (r9 0648) | 27 |
| sampler (r7) | 93 |
| recovery-existing (r6) | 34 |
| JS core (r2) | 20 |

**End lines:** `## r11 SHA256SUMS <sha>` and `## finality-r11 rc=<rc>`, which are exactly what the r11 installer requires.

**Prior actual results:** capture-fixture 3 PASS (0706) and forward-log-fix 8 PASS (0718) are rerun here on the composed bytes, because forward-sync now imports the r2 recovery fixture. ops-followup-r2 and recovery-fixture-r2 results were still pending when this was prepared.

## Qualification pending vs live activation

1. **Qualification (pending):** root's r11 job rc 0. This proves code only.
2. **Guest canary r3 (6d24, active):** the same capture bytes on the guest runtime.
3. **Install** (`install_verified.py --qualification … --rc … --commit`, plus `--include-configs`/units as reviewed): byte-exact, journaled, existing configs kept. Root then fills the config unknowns.
4. **`install_verified.py runtime-dirs --commit`**, then `--check` (and after any reboot).
5. **`install_verified.py activate --confirm <sha of the r11 qualification output> --flags …`**: the activation artifact, before first bootstrap.
6. **First bootstrap / reproof.**
7. **Later and separate:** authenticated live safe/finalized chain readiness and consumer admission. None of steps 1–6 is chain readiness, and nothing here admits consumers or replaces public RPCs.

## Remaining (actual)

- **r11 is UNRUN.**
- **Still missing (`install/MISSING.md`):**
  - coverage evidence;
  - the bound first-bootstrap harness config;
  - the consumer unit list;
  - the forward-sync per-recovery values;
  - checkpoint renewal, before about **2026-11-01T19:22Z** (corrected 2026-10-26: the age is bound to the checkpoint slot 15511008 = 2026-10-25T19:21:59Z + 604800 s, not the 19:38:24Z record time).
- **Portability:**
  - **Workstation steps:** `bundle-origin.json` names workstation origins, so assembling the bundle is a workstation step.
  - **Guest install:** the installed closure is stage-relative and hash-pinned.
  - **CLI defaults:** the capture module's CLI `Sources()` defaults remain workstation paths. Production uses `Sources.from_settings`.
