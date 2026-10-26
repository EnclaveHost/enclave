# Review of da0's `production-bootstrap-wiring-stage/overlay/bootstrap/a1_first_recheck.py` (PROVISIONAL; file dated 01:13:55; read only)

**Status:** this file predates root's decision ("direct capture verification, no legacy adapter accepted"). It is a capture-to-legacy-pair translator: it writes `recheck.json` plus a synthesized `run-result.json` for harness-first's `gate_recheck_run`. **Do not accept it as the production path.**

## What is right (keep these in the direct-verification consumer)

- It uses the capture module's `recheck` mode with production `from_settings` Sources.
- It runs `verify()`, and checks the mode, the bound initial sha, the original game/N/root, and the executed module shas.
- It admits **once** into the shared ledger (`admit_captures`).
- It refuses an existing output directory.

## Concrete issues

1. **Legacy laundering (blocking).** After the capture is verified, the consumer (harness-first `gate_a1`) still accepts **any** root-owned `recheck.json` + `run-result.json` pair. The run-result is written by this tool, but nothing in the consumer can tell it apart from a hand-written one. The capture binding exists only in the producer, so finding A1 of `REVIEW.md` stays open.
   - **Fix:** harness-first (and `base_launch._initial_ok` for first bootstrap) must itself call `C.verify(<capture dir>)`, check mode `recheck`, the bound initial b9a90847 and the original game/N/root, admit into the ledger, and record `initialCapture`/`recheckCapture` in A2 for release/`base_launch` re-verification.
2. **Production source gap (blocking, also found independently).** `a1_capture.Sources.from_settings` hard-codes `initial_receipt=None`, and `SOURCES_KEYS` has no `initialReceipt` (r12-final `capture/a1_capture.py` lines 116, 162). The pinned receipt is also not in the r12-final install `MANIFEST`. So mode `recheck` cannot run from production settings.
   - The adapter works around this with `dataclasses.replace(src, initial_receipt=--initial path)`. That puts a CLI-chosen path on the production path; the sha pin still guards the content.
   - **Decide once and record it in `guest-original-game-canary-stage/CONSUMER-CONTRACT.json`:** either add an `initialReceipt` Sources key (a capture-module change, so cascade it), or keep `replace-after-from_settings` with a **fixed** install path (no CLI override). In both cases, install b9a90847 through the MANIFEST at a fixed destination.
3. **Stale pins.** `RECOVERY`/`FIRST` harness pins are 6c1d0b1b/dbd4cbe3, the r12-final values. r13 changes both through the cold-reader cascade, and `RECHECK_INPUT_PINS` changes with them.
4. **Freshness note.** The pair is checked against `a1MaxAgeSec` at A2 **and** release. Because the ledger admits each capture once, the same capture cannot serve both A2 and release unless the direct consumer defines that one admitted capture covers both, with release's L1 block ≥ A2's (`bind_a1`). Specify this in the direct consumer.
5. **Minor.** The broad `except Exception` exit 1 hides `TypeError`-class bugs. For example, mode `recheck` with `initial_receipt=None` fails in `read_once(None)`, not as a `Refused`. Prefer explicit pre-checks so failures carry a clear code.

## Tests to add in the composed stage (reuse existing fixtures)

- `from_settings` → `capture('recheck')` must succeed with production settings. **This fails today** (`initial_receipt=None`).
- First-bootstrap consumer given a hand-made `recheck.json`/`run-result.json` pair: must refuse.
- The same capture admitted twice: ledger refusal.
- `recheck` capture of a non-pinned initial receipt: refused (`initial_pin`).
