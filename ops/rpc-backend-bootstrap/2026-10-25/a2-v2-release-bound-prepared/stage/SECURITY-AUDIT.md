# Security audit of the copied A2 bytecode gate (written BEFORE any change in this stage)

**Scope:** the inherited `a2a4.py` bytecode section (`private_checker`, `step_bytecodes`, `check_bytecode_receipt`, `bound_bytecodes`, `bytecode_gap_closed`, `step_release`) and its tests, copied byte-identical from the frozen `a2-bytecode-integration` (`SHA256SUMS` `87cad724…`, verified intact).

**Method:** reading the code only; nothing was executed.

| # | Finding | Severity | Action here |
|---|---|---|---|
| S1 | **The pin closes the gap automatically.** With a non-`None` source pin, `release` drops `bytecodes-content-unverified` as soon as a bound v2 receipt from that binary re-validates. There is no separate operator approval of the real scan. | Design: the pin is necessary, not sufficient | **Kept**, and documented. Closure for production still requires a real read-only scan of the stopped datadir at N, after A2–A4, producing that receipt **under root review**. Pinning the binary alone closes nothing: without such a receipt for THIS DB, `release` refuses (`bytecode_receipt` / `open_gaps`). |
| S2 | **The frozen test fixture resets the pin to `None`** (`BytecodeGate.setUp`/`tearDown`). With a real source pin, this would make every later test see `None`, hiding the production value and any regression in it. | Test integrity | **Fixed** in the copy: the fixture restores the **imported source value**, and a new test binds that value to the actual release evidence. |
| S3 | **The scanned state is not carried into the launch record.** `m10-launch.json` records the checker sha, receipt sha and version, but not the receipt's `rowsDigest`/`codeHashesDigest`/`mdbxTxnId`. They stay only in `bytecodes-verified.json`, inside the workdir. | Evidence completeness, low | **Reported, not changed** (no unrelated changes). Proposal: copy those three fields into `m10-launch.json`. |
| S4 | **`bound_bytecodes` trusts `receiptFile`.** It reads `w/'cmd'/receiptFile`, taking the name from `bytecodes-verified.json` without a name check. Both files live in the 0700 workdir owned by the operator, so only that same principal could plant a traversal. | Low | **Reported**. Proposal: require `re.fullmatch(r'bytecodes-\d{8}T\d{12}Z\.json')`. |
| S5 | **The release-time DB identity is root-custody evidence**, not cryptographic: mdbx dev/ino/size/mtime, the stage-checkpoint text and the header-N hash. A2 cannot re-read the MDBX transaction id without running the checker again. | Known limit (documented in v2) | Unchanged. |
| S6 | **A second `bytecodes` run crashes instead of refusing.** `save()` uses `open('x')`, so a second run in the same workdir raises `FileExistsError`. It is not a `Refused`, so `main` crashes, but nothing is overwritten. | Robustness (fail-closed) | Reported. A re-scan needs a fresh workdir. |
| S7 | **`nonCanonicalPadding > 0` is accepted**, provided it is ≤ tag2 rows. This is by design: such rows are non-canonical but execute identically, as the native checker proved per row. | By design | Unchanged. DUPN short padding still refuses (`paddingShortDupn` must be 0). |
| S8 | **The checker's stderr is never parsed.** It is size-bounded only while the checker runs, and is not re-checked after exit. | Low | Unchanged. |

**No finding requires weakening or replacing any gate.** All A1/A2/A3/A4/static/download-134/journal/read-only gates are inherited byte-identical; the copied diff shows this.
