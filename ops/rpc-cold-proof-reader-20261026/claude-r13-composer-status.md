# r13 composition: composer READY, inputs NOT READY (nothing composed; nothing run; no pin invented)

**Status:** `base-finality-proof-stage/r13` does **not** exist. **Nothing was composed from cold-proof r2**: root rejected it (the spawnSync mock-server deadlock, and a fractional `performance.now()` remainder passed to `AbortSignal.timeout`, which needs an integer).

## Inputs (checked at report time; bounded waits under 60 s)

| Input | State | Needed before composing |
|---|---|---|
| r12-final | `9de0d8d7…`, root ACTUAL PASS (`logs/root-finality-r12-final-0738.out`, rc 0), committed `cc30bb890` | the base |
| cold-proof r2 | frozen `7ec3b803…`, **NOT approved** (root review) | not used |
| cold-proof r3 | **present but in progress**: writable files, README still r2's, no root PASS RESULT | frozen + root ACTUAL PASS of its own job (ROOT-READY) |
| `production-bootstrap-wiring-stage` (da0) | **absent** | frozen + its composition record + root PASS |

## The composer: `base-finality-proof-stage/r13-compose/compose_r13.py` `dbba79a0acdb1d16b57dafbe7f2e0f768ed10eb83681f559a0dfdafa430ca29b` (dir read-only; `SHA256SUMS` `45fa92abe16d4928c1b150c7f09124a908d43c04b7ed02cd6b74b1f659a059b4`)

**r3 at 00:58:** root cold-proof runs `cold-proof-tests-20261026T075753Z` and `…075851Z` exist in r3's logs, with `SHA256SUMS.attempt-1`/`-2`, and `INTEGRATION.md` is still changing. No final r3 freeze or ROOT-READY yet. The composer's PASS gate decides; nothing was assumed.

```
python3 -I -B base-finality-proof-stage/r13-compose/compose_r13.py cold-proof-timeout-stage/r3 --cold-only      # or --wiring <frozen wiring stage>
```

**Input gates.** It refuses unless:
- **r12-final:** it verifies, equals `9de0d8d7…`, and its 0738 PASS receipt exists;
- **cold stage frozen:** its `SHA256SUMS` verifies and lists the three readers, and the two `a1-read.mjs` copies are identical;
- **cold stage passed:** the cold stage has root's **actual PASS** (`logs/**/RESULT` reading `PASS cold-proof-tests … stage-sums <its exact sums>`);
- **cold job matches:** the cold job names that exact stage and carries its PASS and rc lines.

**Wiring:**
- `--wiring` is refused until da0's stage is frozen and declares its composition format. It is never guessed.
- `--cold-only` must be stated explicitly. Root prefers **one** final composition that includes the wiring.

**Atomic:** it builds in a temporary directory and renames on success; a refusal leaves nothing behind.

**Cascade:** each edit asserts the exact pin count.

| Order | Target | Change |
|---|---|---|
| 1 | readers | origins = the frozen cold stage; shas from its bytes |
| 2 | `capture/a1_capture.py` | `_RECHECK` + `MODULES` |
| 3 | `harness/a2a4.py` | `RECHECK_INPUT_PINS`, `A1_CAPTURE_SHA256` |
| 4 | `harness-first/a2a4.py` | reader pins |
| 5 | `src/finality_state.py` | `HARNESS_SHA256` |
| 6 | producer | `RECOVERY_A2A4` / `A2A4_SOURCE` / `FINALITY_STATE` |
| 7 | `recovery/forward_sync.py` | `HARNESS` |
| 8 | `src/reproof.py` | `FINALITY_STATE` / `PRODUCER` |
| 9 | `install/MANIFEST.json` + `bundle-origin.json` | the matching shas |
| 10 | installer | qualification strings `## finality-r13 rc=0` / `## r13 SHA256SUMS`; its test refuses r12-final |

**Afterwards, it checks:**
- **no old pin remains** anywhere except historical `integration*/` records and the r10 canary-r3 recipe (marked HISTORICAL);
- every non-bundle manifest sha equals its file;
- the review flags and `RETH_ENV_PASS = ()` are exact source lines.

**Unchanged:** A1/proof/finality policy, own EL `127.0.0.1:18645`, runtime dirs, reproof crash retention and activation.

**Output:**
- `COMPOSITION.tsv` (r12-final copy, edit + `integration-r13/*.patch`, or new);
- README;
- the job;
- `SHA256SUMS`;
- `logs/claude-r13-canary-handoff.json`: stage and sums, manifest, bundle origin, capture, finality state, finality core, `a1Read`/`a1RecheckRead`, cold stage and its sums, harnesses, producer, forward_sync, reproof and the cold PASS receipt. It is valid only after root's r13 job prints `## finality-r13 rc=0`.

**The generated job** (`jobs/root-finality-r13-tests.sh`, queue 768):
- **Setup:** pins and verifies r12-final, the cold stage and every earlier origin.
- **Checks:**
  - **compositions:** all of them (r11, r12, r12-final, r13);
  - **identity:** r13 vs r12-final; readiness, wrapper and finality core vs r10;
  - **pins:** reader-pin consistency (capture, both harnesses, MANIFEST, bundle origin), with the own-EL 18645 template kept;
  - **closure:** pins + manifest closure, bundle assembly + full bundle closure.
- **Reruns** everything whose bytes change:

| Suite | Count |
|---|---|
| capture-r10 | 3 |
| runtime-pin | 10 |
| tool | 34 |
| integration | 17 |
| reproof | 17 |
| ops-installer | 18 |
| parser-recovery | 8 |
| parser-first | 8 |
| capture-closure | 14 (closure copy with the r13 module and cold readers re-pinned, manifest and origins) |
| forward-sync-r2 | 6 |
| reanchor-recovery | 25 |
| r3-regression | 28 |
| r62-isolated | 2 |
| forward-sync | 8 |
| the cold stage's **own frozen job**, verbatim | its PASS line must name its exact sums, and r13's bundle readers must equal the cold stage's bytes |

- **Reuses only** ops-readiness 27, sampler 93, recovery-existing 34 and JS 20 (bytes proven identical). r12-final's PASS and all earlier failures are pinned as HISTORY.

**Static self-validation:** a `--dry-run-unapproved` run against r2, written only to `/tmp`, then **deleted**. It passed:
- `bash -n` and `SHA256SUMS`;
- the composition (74 copies, 13 edits, 15 new) and identity;
- reader pins `991f1ae0`/`6ead7f0d` consistent;
- pins + manifest closure (55 files, 14 trees);
- all receipt shas.

It caught and fixed one bug (the missing `jobs/` directory). **r2's hashes are not used anywhere.**

## Wiring compatibility (`production-activation-plan-stage/r2` RESOLUTIONS/PLAN, read only)

The wiring stage changes the same core files the cold cascade re-pins:
- the producer (`produce` creates `finality/` 0700);
- the reproof unit (`RuntimeDirectory=enclave-rpc`);
- the release-mode holder drop-in (root handshake env, minimal write paths);
- a guest-portable first-harness A1 recheck producer/adapter;
- packaging of release `4a7c013a`, harness `9c44836d`, checker `b55e6b78` and receipt `b9a90847`, plus a journaled `manifest.json` `baseRelease`/`binaries.base` update;
- `permit_restart_auto` and armed→start→proof tests.

**Required ordering for ONE final composition:**
1. **Base:** r12-final.
2. **Then:** da0's wiring delta, verified against its frozen record.
3. **Then:** the cold readers, re-pinned **last**. The cascade recomputes `old` shas from the working tree, so wiring's producer/reproof/harness-first pins are followed, not overwritten.

Wiring's new manifest entries carry over. The installer strings stay single-sourced in r13. The composer is extended to the wiring stage's declared format only once it is frozen. **The cold-only r13 is not production-complete**: it lacks every P1 item above.

## Remaining (actual)

1. **Inputs:**
   - cold-proof r3 must be frozen with a ROOT-READY actual PASS;
   - the wiring stage must be frozen and root-tested;
   - then compose (wiring + cold), and run root's one r13 job.
2. **Then:**
   1. the new cold canary on r13 bytes (the handoff file);
   2. activation per PLAN P2–P5;
   3. live readiness (P6/P7).
3. **Still open (PLAN):** data P0.3/P0.4, coverage AUTH, and the checkpoint deadline 2026-11-01T19:22Z.
