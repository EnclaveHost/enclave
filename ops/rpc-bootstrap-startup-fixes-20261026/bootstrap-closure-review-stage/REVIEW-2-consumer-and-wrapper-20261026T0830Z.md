# Review 2 (2026-10-26 ~08:30Z; PROVISIONAL, pending freeze): first-bootstrap consumer/producer + wrapper pruned-identity patch

Read only: no tests, no live actions, no edits outside this stage. The earlier files (REVIEW.md, ADAPTER-REVIEW-*.md) are kept unchanged as time-stamped provisional evidence. Where they conflict, this file supersedes them.

**Bytes reviewed (unfrozen):**
- production-bootstrap-wiring-stage/overlay/harness-first/a2a4.py, sha 1b860325f8ed65de…
- bootstrap/a1_capture_original.py, sha 1d2c0357d120c3e0…
- wrapper-pruned-identity-stage/overlay/wrapper/chain_service.py, sha 6a4d7aa5da385bf1…, with test_l1_pruned_identity.py 045fcceb93e4a048…

## 0. Root decision applied: correction of my earlier "blocking source gap"

A fixed, source-pinned b9a90847 receipt supplied by `dataclasses.replace(...)` in the first-bootstrap launcher is an **acceptable explicit composition**. It is **not** a defect by design, and no generic `initialReceipt` Sources key is wanted. What remains is **packaging**:
- the composed install MANIFEST must install the exact b9a90847 bytes at the launcher's fixed path `/opt/enclave-rpc/bootstrap/a1-initial-evidence.json` (a versioned, pinned manifest entry);
- tests must cover `from_settings` + replace + `capture('recheck')` with that path.

Until that entry exists, the launcher fails closed: `read_root` fails, then `initial_pin`.

## 1. Consumer (harness-first `capture-original-recheck`): no blocking logic defect found

Checked against the 7-point list in ADAPTER-REVIEW-a1_capture_original.md:

| # | Point | Result |
|---|---|---|
| 1 | Own verify, no legacy files | OK. `first_capture` runs `C.verify(a1CaptureOut)` itself. `a1Evidence` must equal `<out>/capture/evidence.json`. Legacy `fresh-initial`/`original-game-recheck` are refused in production (`A1_LEGACY_TEST_ONLY = False` → `a1_legacy`). |
| 2 | Bindings | OK. Mode `recheck`; bound initial == `A1_INITIAL_SHA256`. The initial and evidence bytes are re-read and re-hashed after verify. The same pinned JS gate (`original-game-recheck` mode) runs over them, then the common N/root/game/ASR/codeHash/plan checks. |
| 3 | Freshness | OK. Capture `finishedAt` must be within `a1MaxAgeSec`, plus the existing receipt-`at` age, the L1 age ≤ 1800 and the 300 s window. The r3 reader's 200 s budget fits. |
| 4 | Ledger | OK. Shared source-constant path (`_ledger_c` → `A1_ADMISSION_LEDGER`): locked, hash-chained, fsynced, re-verified. Admission happens only after every check. `plan` only checks. |
| 5 | A2/release | OK in the harness: each `gate_a1` admits its own capture; `m10-launch` records `a1Gate` for the producer. |
| 6 | Producer re-verify | Present in the overlay `base_launch`. Not re-read in detail this round. |
| 7 | Legacy refused | OK. |

**Integration items** (fail-closed if missed, so not logic defects; they must be done before freeze):
- **C1. Stale capture pin.** Harness-first `A1_CAPTURE_SHA256` is still the r10 47c49b11. The cold-reader composition changes the capture module, so re-pin through the cascade. This file is now one more cascade node: the harness-first sha flows into `base_launch` `A2A4_SOURCE_SHA256` and into the launcher's `FIRST` placeholder.
- **C2. Activation flag mapping.** `A1_FIRST_CAPTURE_REVIEWED` must be added to the installer `FLAG_MODULE` → `/opt/enclave-rpc/a2a4/a2a4.py`. r12-final `FLAG_MODULE` has only `A1_CAPTURE_REVIEWED` → recovery harness. The wiring overlay now has an `install/install_verified.py` (not re-read here); confirm the mapping and a test. Without it, first bootstrap stays HOLD.
- **C3.** The packaging item from section 0.

## 2. Producer launcher (`a1_capture_original.py`)

The earlier ADAPTER-REVIEW notes stand, apart from "source gap" (now packaging, section 0). The partial pre-flight is now covered by the consumer.

## 3. Wrapper pruned-genesis patch (`l1_ready`): no blocking defect found

- **Strict 4444 recognition.** `rpc()` raises `RpcError` (still an `AssertionError` with "local RPC failed") only for a well-formed `{code:int, message:str}` error without `result`. `el_genesis` accepts the pruned basis only for code 4444 AND an exact `fullmatch` "pruned history unavailable: requested 0, earliest available N" with requested == 0. Anything else re-raises. A served genesis must hash to mainnet's. A null or wrong block refuses.
- **Finalized CL/EL pairing.** `/eth/v1/beacon/blinded_blocks/finalized` must have `execution_optimistic is False` and `finalized is True` (root confirmed both are present live). Its payload header must be in [EL earliest, EL finalized] and fresh. The EL block at that number must match number, hash, parentHash and timestamp. In the pruned path the CL `genesis_time` is additionally pinned. All the existing gates still apply: chain id, CL genesis root, spec, version, syncing, head pairing, blobs.
- **Tests:** 15 tests plus 18 mutants, all KILLED (`wrapper-pruned-identity-stage/logs` …082455Z, rc 0).
- **Integration item W1.** The wrapper sha changes from 4fc3b970. That sha is pinned in r12-final `producer/base_launch.py`, `src/finality_state.py`, `recovery/forward_sync.py` and `install/MANIFEST.json`, and in da0's overlay `base_launch`. The two stages both reach the same pins, so they must be composed in one cascade. There is no source overlap: `release_launch_lock` already exists in r12-final's wrapper.
- **Non-blocking:** "operational identity only" is stated correctly. A cosmetic `payload =beacon(` (missing space).

## 4. Canary timeout discrepancy (statement only; this stage does not edit the canary)

The guest-original-game canary raises `helios_timeout` to ≥ 900 because its Helios cold-starts from the pinned checkpoint. The production launcher passes no kwargs, so it uses `helios_timeout=90`. **The canary does not prove that the default 90 s works for a production cold boot.** That must be tested later at the actual supported production timeout, which root will set before freeze.
