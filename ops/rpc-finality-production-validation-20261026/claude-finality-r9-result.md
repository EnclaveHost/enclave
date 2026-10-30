# base-finality-proof-stage/r9: final deployable composition (FROZEN, PREPARED, UNRUN; productionActivated=false)

**Stage:** `SHA256SUMS` sha256 `ba41aefa62740550b423adaa4f717d45994b9557088a4de7a3206f5db45c5b44`, 75 files (`logs/` and `bundle/` excluded).
- **What Claude did:** static checks only.
  - every Python file parses, and the job passes `bash -n`;
  - **the job's own pin and manifest-closure check was run locally:** `pins + manifest closure OK: 54 files 14 trees`;
  - every `COMPOSITION.tsv` hash matches.
- **Not done:** no tests, builds, queue jobs, installs, live operations or commits.
- **Untouched:** r8, pinned-checkpoint-parser, production-capture-closure-stage, forward-sync r2, r6, recovery r7 and the a2-v2 source. guest-capture-canary-stage (6d24) was not read.
- **Flags:** all four review flags are False, `RETH_ENV_PASS = ()`, and `HARNESS_BINARY_SHA256` = `9c44836d…`.

## Composition (`COMPOSITION.tsv`: 13 edits each with `integration/*.patch`, 44 byte copies, 5 new)

| Module | sha | Change |
|---|---|---|
| recovery harness `harness/a2a4.py` | `2efc6d66` | r8 (pinned parser) + the closure's `harness-a1-capture-pin` (`A1_CAPTURE_SHA256` = `fc16b26c`) |
| **first-bootstrap harness** `harness-first/a2a4.py` | `dbd4cbe3` | the a2-v2 `a2a4.py` (`abe223d6`) + the **same pinned StageId/Finish parser**: `parse_checkpoints`/`head_state`, A3 `unwind_incomplete`, A4 `not_unwound`, and the `step_plan` `state_below_anchor` hunk ported by hand. The parser body is byte-identical to the recovery harness's (diffed). `selection.py` `e6c312f4` is unchanged. |
| capture module `capture/a1_capture.py` | `fc16b26c` | the closure's module, byte copy (guest Python 3.12 static + node 18/libnode runtime entries; `Sources.from_settings`) |
| tool `src/finality_state.py` | `2fb4b6a8` | `HARNESS_SHA256` = `2efc6d66` |
| producer | `d7289489` | `RECOVERY_A2A4_SHA256` = `2efc6d66`, **`A2A4_SOURCE_SHA256` = `dbd4cbe3`**, `FINALITY_STATE_SHA256` = `2fb4b6a8`; keeps the conjunction, `adopt_pending`, and permit-auto adoption |
| `src/reproof.py` | `536f5a68` | r8 ordering (adopt, then record, then a new proof) + the closure's `captureSources` (`C.Sources.from_settings`); pins the tool and producer |
| `recovery/forward_sync.py` | `e0a8592b` | `HARNESS` = `2efc6d66`; wrapper `4fc3b970` and selection unchanged |
| wrapper, readiness, units | – | byte copies of r8 |

**Pins checked by the job and run locally:** harness → tool, producer, forward_sync; first harness → producer; tool → producer, reproof; producer → reproof; wrapper in all three; capture module → harness `A1_CAPTURE_SHA256`; both `SELECTION_SHA256`; the A1 gate pins against the manifest.

## Deployable install closure (no workstation path, no host-only runtime in the guest path)

- **`install/MANIFEST.json`:** 54 files + 14 trees, **all sources stage-relative**, with unique destinations. It adds:
  - `/opt/enclave-rpc/a2a4/{a2a4.py,selection.py}` (the first-bootstrap harness);
  - **`/opt/enclave-rpc/a1gate/*.mjs`** (closes the closure's blocker; shas equal the harness's `A1_GATE_PINS`);
  - the whole closure (Helios, l1_authority, initial/recheck modules, portal result, the lock file, 13 dependency trees);
  - the noble tree.
- **`bundle/`:** large and external bytes live here, assembled by **`tools/assemble_bundle.py`** from **`bundle-origin.json`**. It verifies every file sha and tree digest before and after copying, and refuses mismatches. `bundle/` is excluded from `SHA256SUMS`, as in the closure stage.
- **Installer** (`install/install_verified.py`, ops-r2 based):
  - stage-relative trees;
  - config templates installed only with `--include-configs` and never replacing an existing config;
  - configs excluded from `installed_exactly`, because root fills their unknowns;
  - qualification strings `## finality-r9 rc=0` and `## r9 SHA256SUMS`.
- **Config templates:**
  - the closure's `a1-capture-sources.json`, `l1-authority.json` (guest 15052/18645, Helios pin, `checkpointFile` path only) and `base-finality-reproof.json` (`node` `/usr/bin/node`, `captureSources`);
  - r8's `readiness-settings.json` and `base-forward-sync.json`.
  - Unknown values stay `null` or absent.

## Orchestration review

- **Restart permits:** `permit-restart-auto` adopts an interrupted record (HOLD-gated) and then proves the stopped DB, with the **real pinned parser** state frontier via `head_state`, before `restart-permitted`.
- **Re-proof:** adopt, then record a current proof, then a new proof (`r8_*` regressions).
- **Captures:** use only root-reviewed `Sources.from_settings`.
- **Forward sync:** `stage_frontier` has the same semantics as `head_state`.
- **No detached TODO in the wiring.**

## Final job (UNRUN): `jobs/root-finality-r9-tests.sh` (sha `dbc0bd59…`)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r9
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r9-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r9-tests.sh > $ST/logs/root-finality-r9-tests.out 2>&1; echo $? > $ST/logs/root-finality-r9-tests.rc
```

**Setup:**
- loopback brought up and verified;
- `tar` copies only, excluding `logs` and `bundle` (no self-copy);
- every origin manifest pinned;
- composition, pin and manifest closure checked directly;
- **private `WORK`:** a copy of the a2-v2 fixture stage whose `a2a4.py` is the **r9 first-bootstrap harness** and whose `test/fake_base.py` is the **pinned-format emitter** (`73ad09a7`), so first-bootstrap code runs on the real format. The source tree is untouched.
- **Pass rule:** `Ran N tests in` plus a bare final `OK`, with no skip; anything else is FAIL.

**Planned suites** (only changed code or tests):

| Suite | Count |
|---|---|
| tool | 34 |
| integration | 17 |
| reproof | 9 (r8 ordering, never run) |
| ops-readiness | 27 (r8 skip fix, never run) |
| ops-installer | 13 (the installer bytes changed) |
| parser-recovery | 8 |
| **parser-first** | 8 (the same pinned-format tests against the first-bootstrap harness) |
| reanchor-recovery | 25 |
| **r3-regression** | 28, including the new `FirstBootstrapStateFrontier`: Finish `partial_state_trie` below N with labels ahead refuses `state_below_anchor` in the real first-bootstrap harness |
| r62-isolated | 2 |
| forward-sync | 8 |
| forward-sync-r2 | 6 |

**Pinned receipts, not rerun:**

| Receipt | Why it still holds |
|---|---|
| capture-closure 14 (`logs/root-capture-closure-0631`) | module bytes identical |
| sampler 93 (r7 0624) | readiness bytes identical |
| recovery-existing 34 (r6 0549) | wrapper unchanged |
| JS core 20 (r2) | core unchanged |

## Remaining (actual)

1. **Nothing in r8 or r9 has run.**
2. **Awaiting the real artifacts or the canary** (`install/MISSING.md`):
   - `/etc/enclave-rpc/l1-checkpoint.json`;
   - the **6d24 guest canary** (Python 3.12, node 18 + libnode and Helios actually running the A1 modules, viem and the finality core);
   - coverage evidence;
   - the bound first-bootstrap harness config;
   - the consumer unit list;
   - the forward-sync per-recovery values;
   - activation.
3. **Runtime-identity limits,** inherited from the closure:
   - **operator-observed runtime pins:** not upstream-verified;
   - **stdlib and libraries unhashed:** the Python stdlib/`lib-dynload` and node's other shared libraries are not hashed;
   - **libnode TOCTOU:** libnode is checked by a probe process, not the A1 run itself;
   - **finality core node:** `finality_state.node_fd` pins only the launcher sha (`ACCEPTED_NODE`), not libnode. The guest finality-core run loads libnode **unchecked by the finality tool**. A follow-up should apply the capture module's `node_lib_identity` there too.
4. **Workstation fallback defaults:** `capture/a1_capture.py` keeps workstation default `Sources` values (closure-noted). Production paths always pass `Sources.from_settings`, and on the guest the defaults do not exist (fail closed).
5. **Checkpoint format from source only:** the pinned format is established from reth `7134be3` source, not yet on a real DB.
