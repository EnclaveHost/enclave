# production-bootstrap-wiring-stage: composition input contract for 50cf (PREPARED; NOTHING run or qualified by Claude)

**Base:** r12-final (`SHA256SUMS` 9de0d8d7…). Each edited file is `overlay/<path>` = r12-final `<path>` + `patches/<path with / → _>.patch`; the job checks this.
- **r13 is not edited here.** 50cf applies the same hunks on r13, then re-runs its fixed-point pin cascade (`cold-proof-timeout-stage/r3/tools/cascade_plan.py`).
- **The harness-first hunks avoid r13's `RECHECK_INPUT_PINS` lines (73/75).**
- **If r13 re-pins `A1_CAPTURE_SHA256`** (cold reader), the composed harness-first must carry that value: its capture block is a verbatim copy of `harness/a2a4.py:120-152`.

## Edited files (overlay sha in SHA256SUMS)
| Path | Change |
|---|---|
| `harness-first/a2a4.py` | **New a1Mode `capture-original-recheck`**, the only production first-bootstrap A1. It runs the capture module's `recheck` of the SOURCE-pinned initial b9a90847, with these properties:<br>• `verify()` runs inside the harness (`first_capture`), with `inputs/initial-a1-evidence.json` == `A1_INITIAL_SHA256`;<br>• freshness: the capture `finishedAt` and the receipt `at` are within `a1MaxAgeSec`, plus the unchanged `A1_RUN_WINDOW_SEC` check;<br>• the same pinned JS gate; N/root/game/ASR/code-hash checks are unchanged;<br>• admission: `plan` = `check_admissible`, while `a2` and `release` each `admit_captures` a NEW capture (the shared ledger, verbatim from the recovery harness).<br>`a2-authenticated.json` and `m10-launch.json` record `recheckCapture`.<br>**Legacy `fresh-initial` and `original-game-recheck` are refused** (`a1_legacy`) unless `A1_LEGACY_TEST_ONLY` (test seam).<br>The new flag `A1_FIRST_CAPTURE_REVIEWED` gates `load_capture`. |
| `producer/base_launch.py` | **First bootstrap:** `_initial_ok` re-verifies the A2 capture (`_first_capture_ok` → harness `first_capture`, `fresh=False`). `produce` re-verifies the release capture from `m10-launch.json` and requires it to be NEW with the same initial/N/root/game/ASR. Legacy launches are refused unless `A1_LEGACY_TEST_ONLY`.<br>**`produce`** creates `finality/` root 0700 inside the atomic rename, so first and re-anchor launches (forward recovery) are covered.<br>**Pin:** `A2A4_SOURCE_SHA256` → the harness-first above. |
| `src/reproof.py` | `PRODUCER` pin only |
| `units/enclave-base-finality-reproof.service` | `RuntimeDirectory=enclave-rpc`, `RuntimeDirectoryMode=0755`, `RuntimeDirectoryPreserve=yes` (identical to the status unit) |
| `install/install_verified.py` | `FLAG_MODULE['A1_FIRST_CAPTURE_REVIEWED'] = /opt/enclave-rpc/a2a4/a2a4.py`. The qualification header strings are 50cf's to set for the composed stage |
| `tests/r7-ported/test_r3_launcher.py` | **TEST seam only:** `Pipeline.setUp` sets `A.A1_LEGACY_TEST_ONLY` and patches `P.A1_LEGACY_TEST_ONLY` (its fixture launches are legacy) |

**Cascade, in order:** harness-first sha → `producer A2A4_SOURCE_SHA256` + `bootstrap/a1_capture_original.py FIRST`; producer sha → `reproof PRODUCER`. Then the MANIFEST entries of all of these. Nothing else pins them (checked: `2f9450cd` occurs only in `reproof.py`, `MANIFEST.json` and `COMPOSITION.tsv`).

## New files → MANIFEST entries (add)
| dest | src | mode | sha |
|---|---|---|---|
| `/etc/systemd/system/enclave-base-holder.service.d/60-release-mode.conf` (unit) | `units/enclave-base-holder.service.d/60-release-mode.conf` | 0644 | SHA256SUMS |
| `/opt/enclave-rpc/bootstrap/holder_gate.py` | `bootstrap/holder_gate.py` | 0755 | SHA256SUMS |
| `/opt/enclave-rpc/bootstrap/release_install.py` | `bootstrap/release_install.py` | 0755 | SHA256SUMS |
| `/opt/enclave-rpc/bootstrap/a1_capture_original.py` | `bootstrap/a1_capture_original.py` | 0755 | SHA256SUMS |
| `/opt/enclave-rpc/bootstrap/a1-initial-evidence.json` | `bundle/bootstrap/a1-initial-evidence.json` (origin `outputs/rpc-production-final-20261025/l1-a1-live-1958/a1-evidence.json`) | 0644 | `b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c` |
| `/opt/enclave-rpc/bootstrap/base-bytecode-check` | `bundle/bootstrap/base-bytecode-check` (origin `work/rpc-production-final-20261025/finality-stage/bytecode-v2-recovery/build/target/release/base-bytecode-check`) | 0755 | `b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7` |

**Replaced entries:** `/opt/enclave-rpc/a2a4/a2a4.py`, `/opt/enclave-rpc/base-launch/base_launch.py`, `/opt/enclave-rpc/finality/src/reproof.py`, `/etc/systemd/system/enclave-base-finality-reproof.service`.

**Not in any manifest:**
- **Release binary `4a7c013a…`:** guest-only artifact at `/srv/m10-guest-validation/release/run-1/out/base`. It is placed by `release_install.py release --from … --commit` (never rebuilt).
- **`/opt/enclave-rpc/bin/base` 9c44836d:** it runs the download, so it is hashed and never written.

## Operational inputs this changes (activation plan r2)
- **Activation flags:** `activate --flags` adds `A1_FIRST_CAPTURE_REVIEWED`.
- **Before each of `a2` and `release`**, root runs `a1_capture_original.py run <new dir>` and sets `a1Mode`/`a1CaptureOut`/`a1Evidence`. The legacy keys `a1InitialEvidence`/`a1InitialSha256`/`a1RecheckSha256`/`a1RunResult` are absent.
- **Release mode:** `release_install.py release --from /srv/m10-guest-validation/release/run-1/out/base --commit`, then `manifest --commit`, with the holder stopped and the download finished.
- **Readiness:** `readiness-settings.json` `expect-base-sha256` = `4a7c013a…`, because the sampler defaults to 9c44836d (`readiness_sampler.py:83,1000`).
- **Root's live canary must run the capture module's `recheck` of the ORIGINAL pinned game** on the composed bytes (review D).

## Root job
`jobs/root-bootstrap-wiring.sh`: 16 + 28 + 25 + 2 + 8 + 18 + 6 + 17 + 17 tests. It ends with `## bootstrap-wiring rc=0` and `## bootstrap-wiring SHA256SUMS <sha>`.
