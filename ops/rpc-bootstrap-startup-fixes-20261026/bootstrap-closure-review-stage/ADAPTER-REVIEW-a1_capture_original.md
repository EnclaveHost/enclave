# Review of da0's `overlay/bootstrap/a1_capture_original.py` (PROVISIONAL: file dated 01:23:08, sha recorded in the report; read only)

**Context:** the legacy translator `a1_first_recheck.py` is **gone** from the overlay; it was superseded, as root required. The new direct path:
- adds a harness-first `a1Mode capture-original-recheck`;
- runs this launcher before A2 and again before release;
- has the harness re-verify and admit the capture;
- has `base_launch` re-verify the A2 and release captures (overlay lines 49, 208–230, 296–300).

The harness-first changes themselves are **not in the overlay yet**: no `harness-first` file, and `patches/` is empty. Review them when they appear (list below).

## Good

- Capture module loaded only through the pinned first harness's `load_capture()` (`A1_FIRST_CAPTURE_REVIEWED` HOLD).
- Mode `recheck` only, so original-game constants and the b9a90847 pin come from the module.
- Sources from root's `/etc/enclave-rpc/a1-capture-sources.json`.
- A **fixed** initial path (`/opt/enclave-rpc/bootstrap/a1-initial-evidence.json`); no CLI override.
- `verify()` as a pre-flight.
- It writes no receipt of its own.
- A new output directory every time.

## Issues

1. **Source gap acknowledged, not fixed.** `dataclasses.replace(from_settings(...), initial_receipt=INITIAL)` works around `from_settings` hard-coding `initial_receipt=None`.
   - This is acceptable **only** if both of these hold:
     - the composed MANIFEST installs b9a90847 at exactly that destination;
     - the harness-first consumer checks the bound initial sha, not just the launcher.
   - The original-game canary encodes this as contract `initialReceiptSupply: replace-after-from_settings`.
   - A cleaner fix is an `initialReceipt` Sources key, but that is a capture-module change and goes through the cascade.
2. **Outer deadlines.** `capture_kw` is `None`, so the defaults apply: `helios_timeout=90`, `a1_timeout=240`.
   - The production Helios uses its persistent datadir (about 3 s ready when warm, measured).
   - A first-ever start from the pinned checkpoint took about 120 s on the guest (canaries r2/r3), so the **first** run may return 75 (TEMPFAIL) and need a retry.
   - Either document "retry once" or pass a reviewed `helios_timeout` for this one-off root step.
   - `a1_timeout` 240 stays above the r3 reader's 200 s budget.
3. **Port 18550 contention.** The production `l1-authority.json` listen port is shared with reproof captures. Run this only while `enclave-base-finality-reproof.timer` is not enabled (the runbook orders first bootstrap before timers); otherwise the capture fails on the listener.
4. **Pre-flight is partial.** It checks mode and the bound initial sha, but not the game/N/root against `RECHECK_ORIGINAL`, and not the a1-config elUrl binding. That is acceptable only because the harness re-verifies. Make sure the harness checks all of these (list below).
5. **Hygiene.**
   - `read_root` has no size cap. Use the module's caps.
   - The broad `except Exception` maps `TypeError`-class bugs to exit 1 without a code.
   - `verify(workdir=parent of out)` writes temp files beside the capture directories; prefer a private subdirectory, as `a1_first_recheck.py` did.
6. **The `FIRST` pin is a placeholder** (`FIRST_HARNESS_SHA256_CASCADE`). The composition must fill it through the cascade. As written, the launcher refuses at the pin check, which fails closed.

## Must be reviewed when the harness-first diff appears (`capture-original-recheck` consumer)

1. It calls `C.verify(a1CaptureOut)` itself, and requires `a1Evidence == <out>/capture/evidence.json`. Any `recheck.json`/`run-result.json` must refuse.
2. Mode `recheck`; bound initial == `A1_INITIAL_SHA256` == b9a90847; gate game/N/root == plan == `RECHECK_ORIGINAL`.
3. Freshness: capture `at` within `a1MaxAgeSec`; L1 age ≤ 1800; the `A1_RUN_WINDOW_SEC` 300 window holds against the r3 reader's 200 s budget.
4. Admission ledger: exactly once per capture, durable, shared with re-anchor and reproof.
5. A2 and release each use their **own** new capture. Release L1 block ≥ A2's (`bind_a1`), with the same initial/N/root/game/ASR.
6. `base_launch` re-verification (lines 208–230, 296–300) re-runs `verify` against the installed module pin, not a record copy.
7. Legacy modes are disabled in production config (`original-game-recheck`, `fresh-initial`), or explicitly refused for first bootstrap.
