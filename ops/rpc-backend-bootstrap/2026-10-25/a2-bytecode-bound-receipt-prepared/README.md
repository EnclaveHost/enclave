# A2/A4 bytecode-gate integration (PREPARED source proposal; NOT RUN; root review next)

## Status

| Item | State |
|---|---|
| Base | A copy of `a1-a2-integration`. Its SHA256SUMS was `4bfd4fa7…` and its files were verified before copying (`base-copy.sha256`). That stage, `bytecode-native-validation` (source `lib.rs` `739c3245…`, release `42d692d4…`) and all publications are **unchanged** (`frozen-sources.sha256`). |
| Changed here | `a2a4.py`, `test/test_a2a4.py` and `mutants.sh` (baseline count 33 → 40 only), plus this README, `NATIVE-V2-PROPOSAL.md` and `diff-vs-a1-a2-integration.diff`. |
| Run | **Nothing run:** no tests, mutants, queue, compile, scan, live access or commit. Only parse checks (`ast.parse`, `bash -n`) and the static mutant-anchor preflight (33/33 OK). |
| Gap | **`bytecodes-content-unverified` stays OPEN in practice:** `BYTECODE_CHECKER_V2_SHA256 = None`, and the tested release emits v1 only. |

## Design (minimal; fail-closed unless every gate passes)

- **`OPEN_GAPS` is unchanged** (`['bytecodes-content-unverified']`). `release` drops that one entry **only if** `bytecode_gap_closed()` holds:
  - the bound receipt is **v2**;
  - its checker sha equals the **source pin** `BYTECODE_CHECKER_V2_SHA256`, which equals the config pin;
  - the receipt re-validates.

  Otherwise it refuses with `open_gaps`, as before.
- **`step_bytecodes`, in order:**
  1. A4 result present (`order`), and checker configured (`no_checker`).
  2. The checker is read **once** from a root-owned, non-writable file (`untrusted_file`) and matched to its config pin (`checker_pin`). It is then executed from a private 0500 copy in the 0700 workdir, so the executed bytes are the hashed bytes.
  3. `gate_static`: units stopped, no openers, final-134 download receipt, binary pin, prune config, capability, v2 layout.
  4. **Step order:** the last journaled mutation must be the finished A4 `stage run … merkle` (`bytecode_order`).
  5. The DB must be at N (`not_at_n`); header N must equal A4's (`header_changed`); `db_identity` is taken before.
  6. **Exact invocation:** `[<private copy>, datadir]`, empty environment, stdin `/dev/null`, bounded time and output, stderr captured, and only its own process group stopped (`bounded`).
  7. The receipt must parse, with rc 0 (`checker_output`/`bytecodes_failed`), and pass `check_bytecode_receipt`. Then `db_identity` after must equal before (`db_changed`).
  8. It binds `bytecodes-verified.json`: identity, A4 sha, checker sha, argv, env, receipt sha and file, receipt version, mutation-journal digest, download-receipt sha and manifest sha.
- **`check_bytecode_receipt`** (never trusts `ok` alone):
  - **Common to v1 and v2:**
    - the exact key set of that version;
    - counts are integers (bools refused);
    - `rows > 0`, with `failures`, `missingCode` and `paddingShortDupn` all 0, `firstFailures == {}` and `readError == None`;
    - `tag0 + tag2 + tag4 == rows`, and `nonCanonicalPadding ≤ tag2`;
    - `accountsWithCode > 0`.
  - **v2 additionally:**
    - `rows == bytecodesEntries`;
    - `accountsScanned == hashedAccountsEntries`, and `accountsWithCode ≤ accountsScanned`;
    - both digests are 64 hex, and `mdbxTxnId > 0`;
    - all 5 checkpoints equal N;
    - `datadir` equals the configured one.
- **`release`:** `bound_bytecodes` re-checks the identity, A4 sha, journal digest, download-receipt sha, manifest sha, stored receipt bytes and version (`bytecode_receipt`/`bytecode_receipt_stale`), then computes the gaps.

## What is authenticated, and the exact remaining gap

See `NATIVE-V2-PROPOSAL.md`. In short:
- **Code-hash set:** authenticated by the A4 state-root rebuild.
- **Row content:** authenticated by the per-row keccak.
- **Absence:** covered by the checker's `HashedAccounts` completeness walk (the pinned reth source shows execution reads exactly these MDBX tables under v2).
- **Remaining gap:** the **binding** of the scan to the DB state at N. v1 has no in-transaction table counts, no total accounts scanned, no digests and no checkpoints/transaction id. That needs **native helper work (receipt v2)**, then tests, controls, a release pin and a live run. It is not marked done.

## Tests (prepared; `test/test_a2a4.py`, 40 = 33 inherited + 7 new `BytecodeGate`)

- **Fixture alignment (inherited test):** the "good" v1 receipt now uses the **real** v1 schema (all 13 keys from `Report::json()`). The old fixture lacked `paddingShortDupn`, `firstFailures` and `readError`, and the strict key check would refuse it.
- **New `BytecodeGate` tests:**
  - **v2 closes the gap:** a v2 receipt from the source-pinned checker closes the gap, and `m10-launch.json` records the checker and receipt.
  - **Gap stays open:** with a v1 receipt even when its bytes are pinned, with source pin `None`, and when the source pin differs from the config pin.
  - **20 malformed, missing or empty cases:**
    - missing code, 0 rows, `ok:false`, `firstFailures`, `readError`, short DUPN padding;
    - tag sum, bool count, non-canonical > tag2, `accountsWithCode` 0;
    - entries mismatch, accounts scanned mismatch, more code accounts than accounts;
    - digest, transaction id, checkpoint not at N, partial checkpoints;
    - an extra key, a v1 receipt missing a key, an unknown format.

    A refused check binds nothing. Rc 1 with an "ok" JSON is refused.
  - **Another datadir** in the receipt is refused.
  - **Wrong or untrusted binary:** a wrong pin and a group-writable checker are refused before any scan.
  - **Step order:** `bytecodes` without A4 is refused; a mutation after A4 gives `bytecode_order`; a journal change after the scan makes `release` stale.
  - **Stale bindings:** `release` is stale after `mdbx.dat` changes, a checkpoint changes, the download receipt is rewritten (passing `gate_download`), the stored receipt file is tampered with, or the receipt version is edited.
- **Not added:** mutants for the new rules (the 33 inherited mutants are unchanged). Proposed for review: removing `bytecode_order`, the v2 `entries` check, `accountsWithCode > 0`, the journal binding, and the source-pin condition in `bytecode_gap_closed`.

## Root commands (after review; foreground; shared queue 256)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/a2-bytecode-integration
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/tests.guard -- unshare -rn sh run-tests.sh > logs/tests.out 2>&1; echo $? > logs/tests.rc
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/mutants.guard -- unshare -rn bash mutants.sh > logs/mutants.out 2>&1; echo $? > logs/mutants.rc
```

- Accept only `RUN-TESTS rc=0` (40 + 2 + 1 bare `OK`, node 8 clean).
- Then accept only `MUTANTS rc=0` (33/33; baseline count 40).

## Prerequisites before any production bytecode scan (none done here)

1. These tests and mutants pass, and root has reviewed them.
2. The native v2 work is complete (`NATIVE-V2-PROPOSAL.md`), and `BYTECODE_CHECKER_V2_SHA256` is set by a reviewed source change.
3. The final-134 download receipt is present.
4. A2 → A3 → A4 have passed on the real datadir, all units are stopped and there are no openers.
5. The live scan runs under root review.

**Limits:**
- `db_identity` and the journal are root-custody evidence, not cryptographic.
- Code that our own EL writes after N is not scanned.
- `E_PADDING_SHORT_DUPN` remains a refusal that root must review.
