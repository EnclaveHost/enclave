# base-finality-proof-stage/r7 composition: FROZEN, PREPARED, UNRUN (productionActivated=false)

**Stage:** `SHA256SUMS` sha256 `e1af48ad3fd972e281e0136a1438da36850e8089066ae4695dcba8241de1fa3c`, 57 files.
- **What Claude did:** static checks only: every Python file parses, the job passes `bash -n`, pins are consistent, and manifest shas equal the stage bytes.
- **Not done:** no tests, builds, queue jobs, installs or commits.
- **Untouched:** every source stage (r6, r6-ops-fixes-r2, r6-followup-fixes, r6-test-fixes) and base-forward-sync-stage/r2. I read nothing in base-forward-sync-stage/r2 (6d24 owns it).
- **Flags:** all four review flags are False, and `RETH_ENV_PASS = ()`.

## Composition (`COMPOSITION.tsv`: every file's origin, sha and kind; the job re-verifies all of them)

| Origin | Files |
|---|---|
| r6-ops-fixes-r2/tree (base) | installer, wrapper (= r6, `4fc3b970`), units, readiness helpers, core, vendor, a1gate, ops tests |
| r6-followup-fixes (r6.2), byte copies | harness `854c5d38` (clean reth env), tool `b2ed0aaa` (node-acceptance normalization), `test_r62_followups.py` |
| r6-test-fixes | `tests/test_finality_state.py` (root's 4 tool fixes), then the r7 edit below |

**Overlap:** none at file level. ops-r2 changed only install, readiness and units; r6.2 changed only harness, tool, producer and tests.

**r7 edits, one patch each** (`integration/*.patch`, each checked as base + patch):
1. **`producer-binary-pin-conjunction`** (from the r6.2 producer): `bound_config` requires the config's binary, the launch binding **and** `HARNESS_BINARY_SHA256` to all be equal, as review 0602 asked.
   - Fixtures override the constant only for their own duration (`r7-r3-fixture-pin-override`, ported `test_r3_launcher.setUp`).
   - The new negative test `test_unpatched_code_pin_refuses_the_fake_binary` runs with the production pin and refuses `binary_pin`.
   - Producer sha is now `06b93401…`.
2. **`sampler-requires-recorded-acceptance` and `consumer-gate-requires-recorded-acceptance`:** closes the gap you identified.
   - `FS.status` is unchanged (`qualified` with `recordedAs=None` is still what the producer needs).
   - The **sampler** now refuses `finality-not-recorded` unless `recordedAs` is the 64-hex sha of the launch journal's `bootstrapped` event naming this proof, and binds `recordedAs` into the report.
   - The **consumer gate** (`require_ready`) requires a valid `recordedAs` in the READY report **and** an identical one in root's current status. Missing, unrecorded or changed acceptance is not admitted.
   - No new journal states.
3. **Canary tests:**

   | Case | Where |
   |---|---|
   | proven but unrecorded → refused, recorded → admitted with `recordedAs` bound | tool `test_published_status…` |
   | the same, end to end, after a restart with a new proof | integration |
   | unrecorded, changed and withdrawn acceptance | ops gate (+2) |
   | unrecorded | sampler (+1) |

## Live re-proof path: it was missing; now implemented and callable

- **What was missing:** the r6/ops units published status, sampled readiness and issued restart permits, but **nothing ran the capture, qualify and record steps**. After any start or restart the gates would refuse forever.
- **`src/reproof.py`** (root-only, flock-serialized; pins tool `b2ed0aaa` and producer `06b93401`; `reproof.py` `917a6fe0`) runs, in order:
  1. status, which is a no-op if already qualified **and** recorded;
  2. the **pinned capture module** through the harness's `load_capture` (HOLD-gated), with its own reviewed `Sources` and pins: `initial`, then `recheck-capture` of it;
  3. `finality_state.qualify(write=True)` (harness `gate_a1`, shared ledger, core, process binding);
  4. producer `record_finality`;
  5. `status-publish`;
  6. pruning, keeping 4 capture pairs.
- **Exit codes:** 0, 75 (retry later: e.g. `not_newer` while no newer anchor game exists, or a capture failure), 78 (HOLD) and 1.
- **No fabricated receipts.**
- **Units:** `enclave-base-finality-reproof.{service,timer}` (`Requisite=` holder, every 10 min).
- **Tests:** `tests/test_reproof.py` (5, real tools over our own L1 fixture inputs):
  - the first start qualifies, records and publishes;
  - a restart, then re-proof, makes the sampler admit again, and a second run does nothing;
  - no newer game gives `not_newer` and records nothing;
  - a capture failure admits and records nothing;
  - capture HOLD and tool HOLD fail closed.

## Install closure and config

- **`install/MANIFEST.json`:** 28 entries, shas equal to the stage bytes, plus `reproof.py` and its units.
- **`install/config-templates/`:** `base-finality-reproof.json` and `readiness-settings.json`, with known facts only. Every unknown is `null` and refused by its loader.
- **`install/MISSING.md`:** the real missing artifacts:
  - the reviewed node path;
  - the coverage receipt, verdict and origin, plus the expected manifest and chain-config shas;
  - the bound harness config;
  - the consumer unit list;
  - **production capture `Sources`** (the capture module's defaults name workstation stage paths, so a guest needs reviewed installed inputs);
  - the activation artifact;
  - the forward-sync route.

## Root qualification job (UNRUN)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r7
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r7-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r7-tests.sh > $ST/logs/root-finality-r7-tests.out 2>&1; echo $? > $ST/logs/root-finality-r7-tests.rc
```

**Planned suites** (not executed; each needs its exact count, OK and no skip, else it prints `FAIL` with its log):

| Where | Suites |
|---|---|
| stage copy | tool 34, integration 17, reproof 5, ops-readiness 27, ops-installer 13, sampler 93 |
| recovery-r7 copy | reanchor-recovery 25, r3-regression 27, r62-isolated 2 |

**Not planned:** recovery-existing 34 (the wrapper is byte-identical to r6, which passed it in run 0549) and JS core 20 (unchanged since r2).

**Gates:**
- all origin manifests pinned, plus every `COMPOSITION.tsv` copy and edit;
- the pin chain harness → tool → producer → reproof (wrapper `4fc3b970` in tool and producer);
- flags False, `RETH_ENV_PASS = ()`, and production `HARNESS_BINARY_SHA256`;
- manifest shas.

## Remaining (exact)

1. **Everything is UNRUN.**
   - Risk: the ported `test_r3_launcher` setUp pin override assumes `self.cfg` exists at `setUp` (it is used there by the fixture's own helpers; if not, it fails loudly).
   - The ops-installer tests ran against the ops-r2 manifest and may see the refreshed manifest.
2. **Forward-sync not composed:** pending 6d24's `base-forward-sync-stage/r2` report. Its pins must then name harness `854c5d38`, producer `06b93401` and wrapper `4fc3b970`.
3. **Real artifacts missing** (`install/MISSING.md`), notably production capture `Sources`. Until then the live re-proof capture refuses.
4. **Post-restart readiness needs a strictly newer anchor game** (`not_newer`). Consumers stay out until the next game is captured, proven and recorded. This fails closed, with latency of up to one game interval.
5. **Stale ops-r2 artifact:** `jobs/root-finality-r6-tests.sh` (an ops-r2 copy) is stale and is not the r7 job.
6. **Not yet:** activation, install, live verification and the r6.1/r7 producer-binding review outcome.
