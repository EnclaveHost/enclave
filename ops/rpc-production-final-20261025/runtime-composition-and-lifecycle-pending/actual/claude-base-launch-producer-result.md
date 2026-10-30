# Base bootstrap launch-evidence producer + lifecycle: PREPARED (source-only; tests NOT run; flag NOT flipped)

**Stage:** `base-launch-producer-stage/`. `MANIFEST.sha256` =
`2263b031820b38333f184fa2d3f9760ffbb40c3db16ebb798d40772fec31c99b`.
- **Not done:** no tests, build, queue, SSH, network, live change or commit.
- **Originals untouched:** the A2–A4 stage, the wrapper stage and the wrapper's `LAUNCH_PRODUCER_REVIEWED = False`.

**Consumed inputs, pinned** in `inputs/consumed-inputs.sha256`:
- `a2-v2-release-bound` `a2a4.py` `abe223d6…` and its `test/test_a2a4.py` `9c511ec5…`;
- the wrapper candidate `chain_service.py` `fc5b0b05…`;
- the wrapper stage manifest `80d96568…`.

## What `producer/base_launch.py` (`0b80aa1e…`) does
- **`produce`** (offline, euid 0) loads the reviewed harness from its exact pinned bytes and re-validates the
  completed workdir with the harness's OWN functions. It uses the ACTUAL record schemas:
  - `a2-authenticated` {at, anchor, header, a1Gate};
  - `a3-unwound` {steps, checkpoints};
  - `a4-rebuilt` {verifiedStateAt, stateRoot, blockHash};
  - `bytecodes-verified` {identity, a4Sha256, checkerSha256, receiptVersion, receiptSha256, receiptFile, journal,
    downloadReceiptSha256, manifestSha256, result};
  - `m10-launch` {bootstrapAnchor, at, bytecodes};
  - `run-release-*.json`.
- **Bindings it requires:**
  - the newest run is a successful `release` and is fresh (≤ `a1MaxAgeSec`);
  - A2 = A4 at N;
  - A3 checkpoints are at N;
  - the A1 gate equals the pinned initial receipt and the planned N, root, game and ASR;
  - the bytecode receipt is bound to this A4, journal, root-owned download receipt and snapshot manifest, with the
    stored receipt matching;
  - `OPEN_GAPS` closes by `bytecode_gap_closed` (v2, source pin `b55e6b78…`);
  - the DB file identity is unchanged since the scan;
  - the `m10-launch` anchor and bytecode summary are consistent;
  - the release binary `4a7c013a…` is at its fixed root-owned, symlink-free path;
  - the wrapper's offline coverage binding exists and names the same snapshot manifest.

  It also binds the harness binary pin `9c44836d…`, the config sha, the datadir and the harness source sha.
- **Publishing:** a NEW directory is published by atomic rename, never overwritten. `launch.json` carries exactly the
  wrapper's `qualification` fields plus `bindings` and `notAfter`, with byte-exact `qualification/` copies. Nothing is
  fabricated; every failure refuses with a code.
- **Lifecycle:** hash-chained immutable history plus an atomically replaced `lifecycle.json`. Re-pinning in
  `chain.json` is a manual reviewed step.
  - `init` → `anchor-pending`, only while fresh.
  - `mark-started` → `anchor-started`: **the wrapper then refuses**, so the anchor is never replayed after a start.
  - `rearm` → `anchor-pending`, only through the harness's `gate_static` with the stopped DB still exactly at N (every
    checkpoint == N, no header above N, header N authenticating to the anchor). If the head advanced or anything is
    ambiguous, it refuses.
  - `record-bootstrapped` → **HOLD** (`FINALITY_PROOF_REVIEWED = False`): an own-node head is never finality.
  - `rollback` → terminal `rolled-back`; every later transition refuses.

## Tests: `tests/test_base_launch.py` (`50b7ad09…`), 13 tests, NOT run
- **Pipeline:** workdirs come from the REAL harness (`a2a4.main` steps `a2`, `a3`, `a4`, `bytecodes`, `release` over
  that stage's own fake-base fixture, exactly as its passing `BytecodeGate` test does).
- **Cross-check:** the produced directory is accepted by the REAL wrapper candidate's `bootstrap_anchor_args`. The test
  patches only that module's `LAUNCH_PRODUCER_REVIEWED`, top and uid.
- **Negative cases:**
  - no or superseded release;
  - a tampered `m10-launch`;
  - the real source pin, which keeps `open_gaps`;
  - a DB or journal change after the scan;
  - a stale release;
  - wrong release sha, a symlinked release parent, and coverage mismatch or absence;
  - overwrite;
  - the harness source pin;
  - after start the wrapper refuses and init cannot repeat;
  - rearm is refused when the head advanced, when a header exists above N, or when a unit is active;
  - bootstrapped HOLD;
  - rollback terminal;
  - lifecycle tamper and expiry.

## Root command (prepared)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-producer-tests.guard -- unshare -rn bash $S/jobs/root-producer-tests.sh
```
It checks the stage and consumed-input pins and sets `ANCHOR_DEPS_ROOT` like the A2–A4 suite. Pass needs rc 0 and a
bare `OK` with no skips.

## Remaining fail-closed gaps (exact)
- **H-F1:** no reviewed finality-past-N proof. Proposed design: a fresh A1-authenticated receipt N′ > N, plus header N′
  authenticated by the harness, descending from the anchor. Until then there is no `bootstrapped` state.
- **H-F2:** the reviewed harness at `/opt/enclave-rpc/a2a4/a2a4.py` and the installed candidate wrapper (needed by the
  `produce` CLI's coverage call) are not installed.
- **H-F3 (wrapper follow-up, not done here):** the wrapper candidate must also refuse an `anchor-pending` start after
  `launch.notAfter`. Today only `init` enforces it.
- **H-F4:** no real download, A1, A2–A4, bytecode scan, coverage requalification, blobs or readiness exist.

Only after this stage's tests pass, a review, and a wrapper change that consumes this producer (including H-F3) may
`LAUNCH_PRODUCER_REVIEWED` be changed, by a reviewed source change. There is no activation before real A1–A4, blobs and
readiness.
