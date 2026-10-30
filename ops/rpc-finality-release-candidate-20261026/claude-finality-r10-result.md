# base-finality-proof-stage/r10: r9 + runtime-pin + root's r9/canary repairs (FROZEN, PREPARED, UNRUN; productionActivated=false)

**Stage:** `SHA256SUMS` sha256 `1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb`, 79 files (`logs/` and `bundle/` excluded).
- **What Claude did:** static checks only. Every Python file parses, the job passes `bash -n`, and the job's own checks were run locally:
  - the composition check: `composition OK 64` (46 copy, 14 edit, 4 new; every edit is origin + `integration/<name>.patch`);
  - the pin and manifest-closure check: `pins + manifest closure OK: 55 files 14 trees`;
  - `sha256sum -c` on `SHA256SUMS`.
- **Not done:** no tests, builds, queue jobs, installs, live operations or commits. The runtime-pin job was not run (its tests are UNRUN; r10 supersedes it).
- **Untouched:** r9, runtime-pin and every older stage. I did not touch 6d24's guest-capture-canary-stage.
- **Flags:** all four review flags are False, `RETH_ENV_PASS = ()`, and `HARNESS_BINARY_SHA256` = `9c44836d…`. The job checks all of these.

## Actual r9 results (root run 0648, `r9/logs/root-finality-r9-tests-20261026T064649Z-1069706`, rc 1): all suites read

| Result | Suites |
|---|---|
| PASS | tool 34, ops-readiness 27, ops-installer 13, parser-recovery 8, parser-first 8, forward-sync-r2 6 |
| FAIL | integration (17 × `NameError: py`); reproof (1 F + 7 E, the same `py` NameError) |
| FAIL at import (`NameError: WORK`, `test_reanchor_recovery.py:48`) | reanchor-recovery, r62-isolated, forward-sync |
| FAIL (1 of 28) | r3-regression: `FirstBootstrapStateFrontier` expected an A2 refusal, but A2 passed |

**Guest canary r2** (`logs/next-capture-repairs.txt`): Ethereum finality was authenticated, but the initial A1 run targeted `elUrl` 28645 (workstation) and the overall capture failed. This is **not** Base proof readiness.

## Fixes (each one an `integration/*.patch`)

1. **Capture `verify()` NameError** (`capture-elurl-and-verify-py`): `py = rec.get('python') or {}` is bound from the validated record immediately after the mandatory `runtime_accepted(rec, files, pins)`.
2. **Initial capture used the workstation EL:**
   - `derive_a1_config` now sets `cfg['elUrl'] = el_url` in the `initial` branch, as recheck already did.
   - Any `el_url` other than `http://127.0.0.1:<port>` is refused (`el_url`), so a non-loopback or https EL, or `localhost`, can never be derived.
   - `verify` re-derives from the stored config, so it stays consistent.
3. **`WORK` undefined in the r9 recovery fixture:** the ported `test_reanchor_recovery.py` and `test_finality_integration.py` now load the capture module from `CAPTURE_MODULE`. The job sets this to the stage copy's `capture/a1_capture.py`, which is the exact bytes under test.
4. **r3 `FirstBootstrapStateFrontier` (my r9 expectation was wrong; reviewed, not weakened):**
   - **Why r9 failed:** A2 only authenticates header N, so it correctly passes. `step_plan`, which A3 runs first, is where the first-bootstrap harness refuses `state_below_anchor` (lines 694/723).
   - **What the test asserts now:** launching still **must raise**, a new `run-a3-*.json` must exist with `refused` starting with `state_below_anchor`, and **no unwind command** appears in its commands. That is a stricter check than r9's.
   - No product code changed for this.
5. **Installer qualification strings** (`install-install_verified-r10`, `tests-test_ops_installer-r10`):
   - `install_verified.py` previously accepted only `## finality-r9 rc=0` / `## r9 SHA256SUMS`, so r10 could never install.
   - It now requires `## finality-r10 rc=0` and `## r10 SHA256SUMS <this sha>`.
   - The existing test also asserts that an r9 run is refused (still 13 tests).
6. **Runtime-pin integrated:**
   - tool `finality_state.py` = runtime-pin's (libnode identity, core self-report, `libnode_unchanged`, `runtime-verify` CLI) + `HARNESS_SHA256` re-pin;
   - its tests (`test_finality_state.py`, `test_runtime_pin.py`) are byte copies of runtime-pin's.

**New regressions** (`tests/test_capture_r10.py`, 3 tests, using the real capture module through the real integration fixture):
- **guest custom port** `http://127.0.0.1:18999`: it is in `elUrl` of **both** captures' `a1-config`, then `verify` initial, then `recheck-capture` from the initial output, then `verify` of the recheck against the expected sha; the python record is the validated one;
- **refusals:** non-loopback `10.0.0.5`, `https`, and `localhost`;
- **runtime validation stays mandatory in `verify`:**
  - pins with an empty `python_accepted` → `python_identity`;
  - pins with an empty `node_accepted` → `node_identity`.

## Source pins (all checked by the job and locally)

| File | sha256 (prefix) | Pins |
|---|---|---|
| `capture/a1_capture.py` | `47c49b114e6d596a` | – |
| `harness/a2a4.py` (recovery) | `6c1d0b1bf767aceb` | `A1_CAPTURE_SHA256` = `47c49b11…` |
| `harness-first/a2a4.py` | `dbd4cbe37f9f3e43` | unchanged from r9 |
| `src/finality_state.py` | `218bbfe56caec03e` | `HARNESS_SHA256` = `6c1d0b1b…`; wrapper `4fc3b970…` |
| `producer/base_launch.py` | `2f9450cd5c73de3c` | `RECOVERY_A2A4_SHA256` = `6c1d0b1b`, `A2A4_SOURCE_SHA256` = `dbd4cbe3`, `FINALITY_STATE_SHA256` = `218bbfe5` |
| `src/reproof.py` | `360f7234945c597d` | tool `218bbfe5`, producer `2f9450cd` |
| `recovery/forward_sync.py` | `0aeaaaeb38f5bac9` | `HARNESS` = `6c1d0b1b`, wrapper `4fc3b970` |
| `wrapper/chain_service.py` | `4fc3b970e4ec062e` | unchanged |
| `install/install_verified.py` | `71413543fb310d2b` | r10 qualification strings |
| `install/MANIFEST.json` | `6eb25a486ff23e0b` | 55 files + 14 trees, all stage-relative, unique destinations |
| `jobs/root-finality-r10-tests.sh` | `6a0d0303b6782911` | – |

**Manifest:**
- all non-bundle file shas equal the stage bytes;
- the 9 key destinations (both harnesses, tool, producer, wrapper, capture, reproof, forward_sync, checkpoint) are checked by sha;
- the bundle entries equal `bundle-origin.json`.

**L1 checkpoint, provenance corrected:** an earlier note (`claude-finality-runtime-closure.md`) said "from own Lighthouse". That is wrong.
- **File:** `outputs/rpc-production-final-20261025/l1-authority-live-1941/checkpoint.json`, sha `2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33`, `enclave-l1-checkpoint/v1`, slot 15511008, recorded 2026-10-25T19:38:24Z.
- **Sources:** it was agreed by **5 HTTP-200 distinct sources**, our own Lighthouse CL plus 4 independent providers (sigp, beaconcha.in, ethstaker, chainsafe).
- **Handling:** preserved unchanged, as a bundle config entry → `/etc/enclave-rpc/l1-checkpoint.json` (0644, `config: true`).
- **Expiry:** usable until about **2026-11-01T19:38Z** (`maxCheckpointAgeSec` 604800). After that, a new reviewed checkpoint record is needed.

## Root job (UNRUN; runnable now)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r10-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r10-tests.sh > $ST/logs/root-finality-r10-tests.out 2>&1; echo $? > $ST/logs/root-finality-r10-tests.rc
```

**Setup:**
- loopback brought up and verified, and no network route;
- `tar` copies excluding `logs`, `bundle` and `__pycache__` (no self-copy);
- r10 `SHA256SUMS` checked;
- r9, runtime-pin, closure and recovery-r7 manifests pinned and verified, plus the a2-v2 `a2a4.py`, the live help and the pinned fake `73ad09a7`;
- every `COMPOSITION.tsv` copy and edit checked, then pins, flags and the manifest closure.

**Pass rule:** an exact `Ran N tests in`, a bare final `OK`, rc 0, and no skip or expected failure. Anything else is `FAIL` with its log.

**Runs** (every suite that failed in r9 or whose code or test bytes changed):

| Suite | Count |
|---|---|
| capture-r10 | 3 |
| capture-closure | 14 (the closure stage copy with **only** `a1_capture.py` swapped to r10 and its manifest sha re-pinned) |
| runtime-pin | 10 |
| tool | 34 |
| integration | 17 |
| reproof | 9 |
| ops-installer | 13 |
| parser-recovery | 8 |
| parser-first | 8 |
| forward-sync-r2 | 6 |
| reanchor-recovery | 25 |
| r3-regression | 28 |
| r62-isolated | 2 |
| forward-sync | 8 |

**Reused receipts** (receipt file sha pinned, and the job `cmp`s the code and tests as identical to r9):

| Receipt | Count |
|---|---|
| ops-readiness (r9 0648) | 27 |
| sampler (r7) | 93 |
| recovery-existing (r6) | 34 |
| JS core (r2) | 20 |

**End lines:** `## r10 SHA256SUMS <sha>` and `## finality-r10 rc=<rc>`, which are exactly what the installer requires.

**Count caveat:** the counts are r9's actual `Ran` counts, plus the 3 new tests and runtime-pin's 10. Only static counting backs runtime-pin's 10 and capture-r10's 3. **Correction (2026-10-26):** runtime-pin's tests have never run (UNRUN); they are not known to fail. The only known failures are r9's actual results above (the capture `py` NameError, `WORK`, and the r3 expectation), all fixed in r10.

## Guest canary r3 (for 6d24): `r10/CANARY-R3-RECIPE.md`

- **Bytes:** use exactly r10's `capture/a1_capture.py` `47c49b11…` and r10's bundle/manifest entries (no independent source fix).
- **Sources:** take them from `Sources.from_settings` or `reproof`; the CLI `Sources()` defaults are workstation paths.
- **Expect:**
  - `elUrl` `http://127.0.0.1:18645` in **both** captures;
  - `verify` and `recheck-capture` pass;
  - libnode `ce7cb9cd…`;
  - `finality_state.py runtime-verify /usr/bin/node` passes.

## Deployment blockers from `claude-scanner-hook-and-r9-review.md` C/D (checked against r10)

| Item | r10 status |
|---|---|
| C1 `py` NameError | **fixed** |
| C2 initial `elUrl` | **fixed** (+ loopback-only) |
| C4 `WORK` | **fixed** |
| C5 libnode unchecked for the finality core | **fixed** (runtime-pin) |
| **C3 runtime dirs** (follow-up prepared in `r10-ops-followup`, see `logs/claude-r10-ops-followup.md`): `/var/lib/enclave-rpc/finality-captures`, `finality-work`, and the l1-authority `dataDir`/`homeDir` must exist as root 0700 | **NOT incorporated.** No installer step, unit `StateDirectory=` or `MISSING.md` row. reproof refuses `captures_root` (exit 1). **Follow-up needed:** the installer creates the 4 directories root:root 0700 (idempotent, refusing symlinks or wrong owner), and the guest check verifies them after reboot. |
| C5 failed-capture prune | **NOT incorporated.** `reproof.py:98` prunes only on success. A failed or `not_newer` attempt leaves about 38 MB / 11.9k files (up to about 11 GB/day). **Follow-up needed:** review D3 (remove this attempt's directory in `finally`, then `_prune`) + a reproof test. |
| C5 config overwrite | **NOT incorporated.** `--replace --include-configs` can still replace a root-filled config (the r9 comment at `:140` covers only the not-included case). **Follow-up needed:** review D4 (skip existing config destinations even with `--replace`) + an installer test. Until then root must **not** combine `--replace` with `--include-configs`. |

Each follow-up changes `reproof.py` or `install_verified.py`. That means a re-pin (reproof is pinned by no other module; the installer is pinned by nothing), a manifest refresh, re-freezing and re-running reproof 9 or ops-installer 13. I deliberately left these out of r10 because of the turn limit.

## Activation order (ROOT-REVIEW item 1) - corrected 2026-10-26

**My earlier claim of an activation gap was wrong** (no flag-line flip, re-pin or new mechanism is needed). The actual code:
- `install_verified.py activate` (r10 `install/install_verified.py:318-347`) is the existing deliberate activation step.
- **It requires:**
  - root;
  - a passing r10 qualification (`## finality-r10 rc=0`, `## r10 SHA256SUMS <sha>`, rc 0);
  - `--confirm` equal to the sha256 of that qualification output;
  - no open install journal;
  - `installed_exactly` (every non-unit, non-config manifest file and tree byte-exact and root-owned).
- **It writes** the root-owned artifact `/etc/enclave-rpc/finality-activation.json`, mapping each named flag to the sha of the INSTALLED module that reads it (`FLAG_MODULE`), through the same journaled commit.
- **How modules read it:** each module's `reviewed()` accepts only an artifact naming its own bytes.
- **Source flags stay False**, so every byte pin and the installer's `flagsFalse` check stay valid. Undo means removing the artifact.

**Order:**
1. r10 root qualification rc 0.
2. Guest canary r3 on these bytes.
3. Byte-exact install.
4. The runtime directories (`r10-ops-followup`).
5. `activate` (the artifact, tied to the reviewed qualification) **before first bootstrap**.
6. First bootstrap / reproof.
7. **Later and separate:** authenticated live safe/finalized chain readiness and consumer admission. Activation does not establish chain readiness and admits no consumer.

## Remaining (actual)

1. **Nothing in r10 has run.** Root's r10 job is the next step; its results decide everything below.
2. **runtime-pin tests are UNRUN** (first run is in root's r10 job).
3. **Guest canary r3** (6d24) on `47c49b11` is still the only proof that node 18 + libnode actually run A1, viem and the finality core.
4. **C3 runtime dirs, C5 prune and config overwrite** need follow-up patches (above).
5. **Activation** uses the existing `install_verified.py activate` artifact (above), after qualification and before first bootstrap.
6. **Still missing (`install/MISSING.md`):**
   - coverage evidence;
   - the bound first-bootstrap harness config;
   - the consumer unit list;
   - the forward-sync per-recovery values;
   - activation.
7. **Inherited runtime-identity limits:**
   - the Python stdlib and node's other shared libraries are not hashed;
   - the runtime pins are operator-observed;
   - the `Sources()` CLI defaults remain workstation paths (production uses `Sources.from_settings`; on the guest the defaults fail closed).
8. **Checkpoint format is from source only:** the pinned reth StageId format comes from reth `7134be3` source, not yet a real DB.
9. **Checkpoint expiry:** the L1 checkpoint expires about 2026-11-01T19:38Z.
