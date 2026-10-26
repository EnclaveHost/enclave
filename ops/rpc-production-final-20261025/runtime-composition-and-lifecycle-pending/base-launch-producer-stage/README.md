# Base bootstrap launch-evidence producer + lifecycle (PREPARED; NOT run; source-only)

`producer/base_launch.py` is offline and root-only (refuses unless euid 0). The wrapper candidate's
`LAUNCH_PRODUCER_REVIEWED` stays **False**; it is not flipped here.

## `produce <a2a4-config> <new-dir>`
It re-validates the COMPLETED workdir of the reviewed harness. The harness is pinned: `a2a4.py` sha256 `abe223d6…`,
loaded from those exact bytes. It uses the harness's OWN functions: `load_config`, `A1_INITIAL_SHA256`, `MAINNET`,
`journal_digest`, `_trusted_sha`, `MANIFEST_SHA`, `check_bytecode_receipt`, `bytecode_gap_closed` and `OPEN_GAPS`.
- **Release run:** the NEWEST run record must be a successful `release`, finished at most `a1MaxAgeSec` ago.
- **A2/A3/A4:** A2 `anchor` = A4 at N, with matching state root and lower-case hash; all A3 checkpoints are at N
  (merkle-execute ≤ N).
- **A1:** the A1 gate recorded in A2 equals the pinned initial receipt and the config's N, output root, game and ASR.
- **Bytecode receipt:** bound to this A4, this journal, the root-owned download receipt and the snapshot manifest. The
  stored checker receipt must match. `OPEN_GAPS` must close by the harness's own rule (v2 receipt from the
  source-pinned `b55e6b78…`).
- **Database:** the `mdbx.dat` dev/ino/size/mtime are unchanged since the scan, and `headerN` = the A4 hash.
- **`m10-launch.json`:** its anchor equals `N:<A4 hash>`, and its bytecode summary equals the receipt's.
- **Release binary:** `4a7c013a…` at the fixed path. No symlink in any component, every component root-owned and not
  group/other writable.
- **Coverage:** the wrapper's own offline `coverage_activation` for that binary. Its snapshot manifest must be the A2–A4
  pinned one.
- **Output:** a NEW directory, published by an atomic rename of a fully written sibling, never overwritten:
  - `launch.json` holds `qualification` (the wrapper's exact fields) plus `bindings` (harness source, harness binary,
    config sha, A3, the release run, datadir and DB identity, A1, bytecodes, journal, download receipt, snapshot
    manifest, coverage) and `notAfter`;
  - `qualification/*` holds byte-exact copies.

## Lifecycle (hash-chained history `lifecycle-history/NNNN-<state>.json` plus atomic `lifecycle.json`)
| command | transition | condition |
|---|---|---|
| `init` | — → `anchor-pending` | the launch record is still fresh (`now ≤ notAfter`) |
| `mark-started` | `anchor-pending` → `anchor-started` | root records that the first anchored start was issued; **the wrapper then refuses to start** (no blind replay) |
| `rearm` | `anchor-started` → `anchor-pending` | only via the harness's `gate_static` (units stopped, pins, receipt, layout), with every stage checkpoint == N, no header above N, and header N authenticating to the anchor hash |
| `record-bootstrapped` | `anchor-started` → `bootstrapped` | **HOLD** (`FINALITY_PROOF_REVIEWED = False`): an own-node head or label is never finality |
| `rollback` | any non-terminal → `rolled-back` | terminal; every later transition refuses (recovery = re-download) |

After each transition, root re-pins `chain.json` `baseBootstrap.anchorLaunch` (a reviewed manual step).

## Fail-closed gaps (exact missing facts)
- **H-F1 finality proof:** a reviewed validator showing finality passed N, for example a fresh A1-authenticated receipt
  naming N′ > N with our node's header N′ authenticated against it (the harness's `authenticate`), with N′ descending
  from the anchor. Until then there is no `bootstrapped` state, so a successfully advanced node can only be rolled back
  or kept stopped.
- **H-F2 install paths:** `A2A4_SOURCE` = `/opt/enclave-rpc/a2a4/a2a4.py` and the installed candidate wrapper (needed
  for `produce`'s coverage call) are not installed.
- **H-F3 freshness at the anchored start:** `init` enforces `notAfter`, but the wrapper candidate does not yet check
  `notAfter` when it starts in `anchor-pending`. **This is a required follow-up in the wrapper stage, not done here.**
- **H-F4 live inputs:** the real download, A1, A2–A4, the bytecode scan, coverage requalification and readiness
  (blobs, L1) — none exists.

## Tests (written; NOT run): `tests/test_base_launch.py`, 13 tests
- **Inputs:** workdirs come from the REAL harness pipeline (`a2a4.main` steps `a2`…`release` over the A2–A4 stage's own
  fake-base fixture).
- **Cross-check:** the produced directory is checked by the REAL wrapper candidate's `bootstrap_anchor_args`.
- **Cases:**
  - positive produce, plus the wrapper accepting it;
  - no or superseded release;
  - a tampered `m10-launch`;
  - the real source pin keeping the gap open;
  - a DB or journal change after the scan;
  - a stale release;
  - release binary, symlink and coverage refusals;
  - never overwriting;
  - the harness source pin;
  - started → the wrapper refuses;
  - rearm only with a stopped DB at N (refused when advanced, when a header exists above N, when a unit is active);
  - the bootstrapped HOLD;
  - rollback is terminal;
  - lifecycle tamper and expiry.

## Root command
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-producer-tests.guard -- unshare -rn bash $S/jobs/root-producer-tests.sh
```
