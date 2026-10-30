# Base restart after crash or reboot: executable design review (PREPARED; design only; nothing run; NOT integrated)

**Scope.** This document reads the actual sources and specifies the restart path the current code permits. It names exactly
what is missing. Nothing below is enabled.
- Launcher r3: `base-launch-producer-stage/r3/wrapper/chain_service.py` `07276ec8…` and `producer/base_launch.py` `7e8d295d…`,
  both byte-identical to r2.
- M10: `finality-stage/m10-bootstrap/README.md` and the patch `d97c31b5…`, as bundled in `m7-m10-combined-release`.
- Harness: `a2-v2-release-bound-prepared/stage/a2a4.py` `abe223d6…`.
- The frozen prototype: `base-finality-proof-stage` (`SHA256SUMS` `e21761c2…`).

**HOLD flags** stay False: `FINALITY_PROOF_REVIEWED`, `LAUNCH_PRODUCER_REVIEWED` and `FINALITY_PROTOTYPE_REVIEWED`.
**Integrated restart qualification does NOT exist.**

## 1. What happens today after a crash or reboot (traced)

| Step | Source | Effect |
|---|---|---|
| Unit restarts | live unit `Restart=on-failure`, `RestartSec=300` (r3 drop-in header, root capture `612fee0b…`) | The wrapper runs again every 300 s. |
| Journal state | `chain_service.py:480-482` `JOURNAL_NEXT`, `PENDING={'armed','rearmed'}`; `launch_handshake` `:647` | `consumed` → **AssertionError**: "bootstrap anchor already consumed". No exec. |
| Root `rearm` | `base_launch.py:307-323` → `stopped_db_unchanged_at_n` `:253-280` | Requires every stage checkpoint == N and **no header above N**. After the node ran past N this **refuses** (`head_advanced`), by design. |
| Even if the journal allowed it | `launch_handshake` `:663` always returns `['--bootstrap.anchor', 'N:0x…']` | M10 `BootstrapAnchor::verify_execution_head` (m10 README §1) requires EL `latest` **exactly N** with the recomputed hash, and persisted labels ≤ N. A DB that ran past N **fails closed**. |
| Unanchored start | M10 default path (no flag) | Trusts the persisted EL labels and the consensus SafeDB from the previous run. The wrapper has **no** such release-mode path, which is correct today. |

**Result: fail closed.** Base stays down after any crash or reboot. There is **no** replay of the consumed anchor, because the
journal refuses and M10's precondition refuses. There is also **no** recovery path short of a new launch, and the producer
cannot produce one for a newer anchor (§3).

The prototype's `status()` cannot change any of this:
- it qualifies only the **same running process**, and no process exists before exec;
- the optional `record_bootstrapped` patch adds **no** journal transition, so the wrapper still refuses `consumed`.

Root's review is correct: this is an integration gap, not rebase work.

## 2. Candidate restart designs

### R-A: re-anchor restart (RECOMMENDED; the only design whose every safety step already exists as reviewed code)

The restart is a **new launch** at a fresh, newer A1 anchor N'' on the same DB. It goes through the existing reviewed
A2–A4 + produce + arm + handshake pipeline. The old launch is terminated.

| # | Step (root, Base unit stopped) | Existing code | Guarantees |
|---|---|---|---|
| A0 | `rollback <old-dir> <reason>` | `base_launch.py:333-346` (`consumed` → `rolled-back`, terminal) | The old anchor can never be consumed again (no anchored replay). |
| A1 | Fresh A1 receipt for the newest anchor N'' | reviewed runner `live-1958/run.py`, **with the capture binding of §4** | The authenticated N'' and its output root. |
| A2 | Header N'' reproduces the root | harness `step_a2` / `authenticate()` (`a2a4.py:557-575`) | The anchor header is authenticated. Nothing above N'' is used. |
| A3 | Offline unwind from the DB head to exactly N'' | harness `step_plan`/`step_a3` (`a2a4.py:610-660`; `stage unwind … to-block`) | Every block above N'' is discarded: **no unsafe-head trust**. Persisted labels are lowered (m10 README caveat). |
| A4 | Full merkle rebuild at N'', validated against header N'' | harness `step_a4` (`stage drop merkle` + `stage run merkle --from 0 --to N''`) | The whole state at N'' equals the authenticated root. This is the **only real full-DB state proof** in the source. |
| A5 | Bytecode scan, release run | harness `step_bytecodes`, `step_release`, `bind_a1` | Code content is bound to this A4 and DB identity. |
| A6 | `produce` a NEW launch directory, root pins its `launchSha256` in chain.json | `base_launch.py:119-198`, wrapper `launch_record` `:561-588` | One immutable record per launch; the pin is replaced only by root. |
| A7 | `arm`: stopped DB unchanged at N'' | `base_launch.py:283-305`, `stopped_db_unchanged_at_n` | **Post-proof DB tamper** between A4 and start is caught: mdbx dev/ino/size/mtime, checkpoints == N'', no header above N'', header N'' authenticated, checked before and after. |
| A8 | Unit start: the handshake consumes and execs `--bootstrap.anchor N'':hash` | wrapper `launch_handshake` | M10 precondition (head == N'', labels ≤ N'') and the SafeDB wipe: no persisted unsafe or safe head survives. |

**Restart rules R-A must add.** These are new checks; the rationale for each is given in the table.

| Rule | Check | Why |
|---|---|---|
| RA-1 monotonic anchor | N'' > the previous launch's N, **and** N'' > every height already served (if recorded), **and** game'' ≠ the previous game | Prevents re-anchoring to an older anchor (anchored replay of history). |
| RA-2 predecessor binding | The new `launch.json` names `previousLaunchSha256` and the sha of the predecessor's `rolled-back` journal entry | A verifiable launch chain: one active launch at a time, and no silent fork of launch history. |
| RA-3 crash ≠ DB proof | R-A never uses the old launch's finality journal, `status()`, or node labels as authority. They are recorded as tripwire observations only. | They describe a process that no longer exists, so they are not evidence about the on-disk DB. |
| RA-4 changeset floor | N'' ≥ the held changeset floor (`STATE_FLOOR` 52,500,000; `[prune.segments] before <= floor`, `a2a4.py:518`) and N'' ≤ the stopped DB's execution checkpoint | The unwind is possible, which is planBootstrap's `unwind_to_anchor` case. |

**What R-A is missing in source.** R-A is not executable until these are reviewed:
1. **Harness N bound.** `load_config` refuses N outside `[STATE_FLOOR, SNAPSHOT_HEAD)` = [52,500,000, 53,048,526) (`a2a4.py:116-117`).
   - Any N'' ≥ 53,048,526 needs a reviewed bound change. The only captured newer observation (§5) is 52,869,960, which is inside the bound.
   - `gate_download` binds the receipt to the snapshot head 53,048,526 and to this datadir (`a2a4.py:427-476`). That still describes the original download; whether it may qualify a DB that has since run is a root decision.
2. **Producer A1 pin.** `produce` refuses unless `a2.a1Gate.initialSha256 == A.A1_INITIAL_SHA256` (`base_launch.py:145`). That is the ONE pinned receipt for N 52,866,960 (`b9a90847…`).
   - A re-anchor needs either a per-launch, root-reviewed pin, or `fresh-initial` support with the capture binding of §4.
   - It is a source change (the harness: "a source change, never config").
3. **Launch-record fields** for RA-1 and RA-2: `previousLaunchSha256` and the predecessor `rolled-back` entry sha. The wrapper's `launch_record` must then verify the predecessor is terminal. This is a launcher r3+ change, owned by the launcher owner.
4. **Cost:** an unwind of (DB head − N'') blocks plus a full merkle rebuild from 0 per restart. Neither has been measured: no A3 or A4 run exists yet.
5. **History below N''** stays as unauthenticated as at the first launch. The harness has no `authenticateAncestors` step (grep: none in `a2a4.py`); receipts below N'' are unauthenticated.

### R-B: fast resume of the same DB (REJECTED as specified; HOLD)

R-B restarts without unwind or rebuild, using the prototype's finality journal plus checks on the stopped DB. It would need
three things the source does not provide:
- **(i) A real, cheap proof of the stopped DB's full state.**
  - mdbx dev/ino/size/mtime do not detect content changes made with mtime restored.
  - The finality journal qualifies a *running process*, not the bytes left on disk.
  - The only full-state proof in source is A4's rebuild at an authenticated height. That needs the DB unwound to that height, which is R-A.
- **(ii) A clean-shutdown seal.** A root-computed full-content digest of every DB file at stop (mdbx, static files, consensus SafeDB), re-verified before start.
  - This exists nowhere in source.
  - It is impossible after a **crash**, because no seal is written.
  - It would prove only "equal to what our process left". That is our own execution, including an **unsafe head** above the last authenticated N', which must not be trusted.
- **(iii) An unanchored release start.** M10 without `--bootstrap.anchor` trusts the persisted labels and SafeDB of the previous run. The wrapper has no such mode, and adding one would trust our own unsafe and finalized labels.

**R-B is therefore rejected** under the stated rules (no unsafe-head trust, no own labels). A variant that unwinds to the last
**authenticated** N' and re-verifies state there **is R-A**.

## 3. Proposed journal and state machine (for the launcher owner; design only)

```
launch L_k:  armed -> consumed -> (crash/reboot: wrapper refuses, Base down) -> rolled-back   [root, A0]
launch L_k+1 (new dir, previousLaunchSha256 = L_k, predecessor entry = L_k's rolled-back sha):
             produced (A1-A5 at N'' > N_k) -> pinned -> armed (A7) -> consumed (A8, anchored at N'')
```

- **No new transition out of `consumed` is introduced.** `consumed → rearmed` stays as it is: only for a stopped DB still unchanged at N, i.e. a start that never touched it.
- **The finality-proof journal** (prototype) remains a separate, per-process tripwire:
  - an `L_k` contradiction must block producing `L_k+1` from the same DB until root decides, because the DB may be the contradicting chain;
  - a qualification is never an input to A0–A8.

## 4. A1 producer provenance gaps (current; must be bound AT CAPTURE)

Root-owned files in the output directory are **not evidence** that those exact bytes ran. A root (or a later copy) can
replace them after the run. `live-1958/run.py` (`b3044bbf…`) records in `run-result.json` only:
- `inputPins` (`a1-anchor.mjs`, `a1-read.mjs`, `vendor/anchor-bootstrap.mjs`);
- `heliosStatus` (including `binarySha256`);
- start and finish times, `a1Exit`, `processStopped`, `productionActivated`.

| Gap | Detail |
|---|---|
| G1: runner's own sha | It is not recorded. The prototype's check of `run.py` in the same directory is **not** a capture-time binding. |
| G2: config bytes | `a1-config.json` (written by `run.py` itself), the l1-authority config (`outputs/…/l1-authority-live-1941/config.json`) and the `portal-result.json` that supplied the ASR are not hashed in the record. |
| G3: code that ran | The sha of `l1_authority.py` and the `node` binary and version are not recorded. |
| G4: dependencies | `ANCHOR_DEPS_ROOT=P/source` (`@noble/hashes`, `viem`) is not pinned in the record. |
| G5: modules read by path | `inputPins` are computed from `finality-stage/l1-anchor-a1/*` paths **before** the run, but the run executes those same paths again; a swap between hash and exec is not excluded. |
| G6: record writes | `run-result.json` is written with `write_text` (not exclusive create); `a1-evidence.json` and `a1.stderr` use exclusive `x`. |
| G7: L1 inputs | The L1 EL endpoint identity and the Helios checkpoint provenance are only what `heliosStatus` reports. |

**Required capture binding.** This would be a new reviewed runner revision; it is **not** written here:
1. copy every executed file (runner, modules, configs, the dependency files actually imported) into a private root-only
   directory;
2. hash the copies;
3. execute only the copies;
4. record every hash, plus the node and Helios binaries and the exact argv, in a record created with `O_EXCL` before the A1
   process starts, and completed (also exclusive) after it.

Until then, a fresh A1 receipt is a **trusted root-produced record with an unbound runner/config identity**, exactly as the
harness itself states (`a2a4.py:14-17`).

## 5. Correction of an earlier statement

**Corrected wording:** "no fresh newer **A1 receipt** has been captured here".

My earlier wording ("no newer finalized game exists yet") is **not** supported. In fact, root's recheck run
`a1-original-game-prepared/live/l1-a1-recheck-retry-2152/recheck.json` records a **latest-anchor observation**, at 2026-10-25T21:53:07Z:
- game `0x27d5e3b9343fd081666d96e2b8044c29e176b7bf`;
- N **52,869,960** (3,000 above the launch N 52,866,960);
- `advanced: true`, `accepted: false`.

**What the observation is not:**
- It is **not** an A1-authenticated receipt for that game.
- The recheck verdict authenticates the ORIGINAL game, and the latest anchor is recorded "observation only".
- It is subject to the §4 gaps.

No network was used for this review, so nothing newer is known.

## 6. Code and tests in this revision: none, deliberately

- **R-A** consists of the existing reviewed steps plus four source changes to files owned by others: the harness bound and
  `gate_download` decision, the producer A1 pin, the launch-record predecessor fields, and the runner capture binding.
- **Writing them here** would fork the launcher or harness outside its owner and the in-flight r3/r4 work.
- **R-B** is rejected.
- **No code here can supply the missing real DB proof.** The only real proof is A4's full rebuild at an authenticated height.

**Recorded for the next prototype revision (the stage is frozen; not fixed here).** Root's run `root-finality-prototype-0211`:
- JS 20/20 passed; Python 26/27.
- `test_replayed_or_not_newer_receipt_refuses` hit `replayed` before `not_newer`.
- **Cause:** `make_a1` writes a byte-identical `run-result.json` (same default times and fields) for the `older` fixture, so
  `runResultSha256` equals the first run's. The tool's replay check is correct.
- **Fix in a NEW revision:** give each fixture run a distinct, valid run identity (e.g. distinct `startedAt`, inside the window),
  so the `not_newer` branch is reached. Replay detection stays unweakened.
