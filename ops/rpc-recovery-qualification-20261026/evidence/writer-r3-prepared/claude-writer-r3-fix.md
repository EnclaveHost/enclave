# writer-two-anchor r3: fix of root 1545's single slice failure (EARLY DIAGNOSIS; source-only; nothing run)

## Inputs
- **r2 stage:** `SHA256SUMS` `3dba09e6…22fe2`, `sha256sum -c` OK; r2 patch `6ee01917…11a9`.
- **Failing run receipt (kept, not touched):** `writer-two-anchor-stage/r2/runs/20261026T183226Z-slice-2144547/`.
  - `verdict.json`: `two-anchor-reader-r2` 11/12; every other suite passes.
  - `logs/two-anchor-reader-r2.tap` `not ok 5`.
- **Reconstruction:** the r2 files were rebuilt in a NEW scratch `/tmp/w3r/r2` from r9 `release.git` `296a5833…` + r1 patch + r2 patch. **All 11 file hashes equal r2 `PROVENANCE.md`.**
- **Not touched:** `/tmp/w2b` and agent 50's work.

## Cause: a malformed test fixture, not a journal defect
**The failing test** (`test/derived-reader/two-anchor-r2.test.mjs:142-158`, "A2 journal: bounds are fail-closed…") writes a saved `provisional` section and opens it.
- **What it writes:** facts in the **API entry shape** `issued(S)`, i.e. `{at, fact, finalized, state}`.
- **What the journal persists and validates:** `{at, fact, finalized}` (`deployment-lifecycle-journal.mjs:76-80` `validIssued`, `sameKeys(f, ['at','fact','finalized'])`).
- **`recordProvisionalFact` strips `state`** before storing (`:168`).

**So the saved section the test fabricated is not one the journal could ever write:**
1. `validate()` at open rejects it (`:22`), and the journal starts closed ("lifecycle journal is unreadable: invalid provisional evidence").
2. The test's `recordProvisionalFact` then sees that closure instead of the capacity refusal (`/evidence is full/`).

**The journal behaved correctly:** a corrupt or unknown persisted section fails closed and is never reset.

**Normal full-capacity input works** (traced in source with correctly shaped persisted facts):
- 128 states × 1 fact opens;
- a new S gives `provisional evidence is full…` **before** any write or state change (`:174`, before `commitState`);
- a known fact gives `duplicate` (no write);
- another fact under a known S is `recorded` (129 facts ≤ 512; bytes ≈ 64 KB < 196,608).
- With 512 facts under one S, the 513th is refused as full.

**Two further latent defects in the same test:**
- the `many` file also carries the extra key, so its "fact bound before byte bound" size assertion is inflated;
- `over` (129 states) is asserted `/invalid provisional evidence/`, but with the malformed facts it would fail for the **wrong** reason. Today it is vacuous: it would still pass if the 128-state bound were missing.

## Fix (r3; test-only; the journal code is unchanged)
- In that test, write the **persisted** shape (`stored(S, i)` = `issued` without `state`) for `full`, `many` and `over`.
- Assert that the full journal **opens** with exactly 128 states.
- Make `over` invalid **only** by the 129th state, and add an explicit malformed-shape negative (a persisted fact with an extra `state` key is refused at open).
- **Same test, so counts are unchanged:** two-anchor-reader-r2 stays at 12.
- **Not weakened:** bounds, the durable fence, the prior-journal validation, the full-capacity refusal before mutation and the error texts.

(Frozen hashes, the patch against r2 and the root job follow below once prepared.)

---

## Frozen r3 stage (2026-10-26 18:39Z)
`writer-two-anchor-stage/r3/SHA256SUMS` sha256 **`5ca6754e1117ee442e00ee1854db1f814fafdf58dd2fc72c38e36cd91abe0f7a`** (all files `a-w`)

| file | sha256 |
|---|---|
| `PROVENANCE.md` | `a70f607dba423169c0717676a7effcb240b9db036c447ce73c1518a108ea6e9d` |
| `patches/writer-two-anchor-r3-vs-r2.patch` (test only) | `ac9ecaf5c5b7ac993b2a0c296a85c9146b58b03e4d7e1c35196607d1f47577a9` |
| `jobs/root-writer-two-anchor-r3.sh` | `8a04b6f77cae4f0a3a4956cc59ae5e012d415995e68f920b7019e5f1e47e8508` |
| `inputs/r2-slice-1545-verdict.json` (copy of the r2 receipt) | `8bc0c867fdf6a63122a1d4316b28d0cf2547b04326814808caaf39fd14e086d4` |
| `inputs/r2-slice-1545-two-anchor-reader-r2.tap` (copy) | `2d038038929058ec8a8eb7726590f2d7495f67e3246b9ad573cdd8aa13332020` |

**Trees, recomputed in a scratch bare repo whose alternates point at r9 `release.git` objects (nothing written into it):**
- r9 `296a5833…`, then r1 patch: `f22d554c…` ✓;
- then the r2 patch: `20d0d76a…` ✓;
- then the r3 patch: **`5f141c3fa476b904d6a0107a75c31c9113726591`**.
- The changed test file is `38110cd2…c372` (r2 `727cc09f…`).
- **No other file changes.**

**r1, r2 and their receipts are unchanged:** r1 and r2 SUMS re-verified; the r2 run dir was not touched.

**The job** is r2's job with exact, asserted substitutions only:
- `S=…/r3`;
- it verifies the frozen r2 stage (`W2_SUMS 3dba09e6…`);
- it composes r9 + r1 (= `f22d554c`) + r2 (= `20d0d76a`) + r3 (= `5f141c3f`), each tree asserted;
- labels and budget variable renamed;
- **every suite and count is unchanged** (slice 158: two-anchor-reader 13, two-anchor-reader-r2 12, two-anchor-writer 12, KVM 22/6/5/10/8/14, writer 23, composition 6, replica 8, enrollment 19);
- the check set is unchanged.
- **Checks I made:** `bash -n` only.

**Root commands (not run by me):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh w2a-r3-slice  512 unshare -Urnm bash writer-two-anchor-stage/r3/jobs/root-writer-two-anchor-r3.sh slice
bash jobs/q-exit-status.sh w2a-r3-check 2560 unshare -Urnm bash writer-two-anchor-stage/r3/jobs/root-writer-two-anchor-r3.sh check
```
- **PASS** = `verdict.json` `ok: true` with the exact counts above.
- **Untested:** I did not execute the new assertions. They are traced in source:
  - full states file ≈ 54 KB; 512-fact file ≈ 150 KB (< 196,608);
  - the refusal is thrown at `recordProvisionalFact` `:174`, before `commitState`, so the file bytes stay identical.

## Bounded review of the other r2 code (no blockers found for this fix; observations for root and agent 50; NOT changed in r3)
- **O1 (availability). The provider lock can be held for up to about 15 s.**
  - `settleEvidence` runs inside the merge's `exclusive` section and retries `commit pending` up to 60 × 250 ms while holding the provider lock (`provider.mjs` `settleEvidence`, called from `submit`'s merge).
  - Reads (B_f, S, logs) can therefore be refused as busy for up to about 15 s during contention with a bridge floor commit.
  - It is bounded and fails closed; it partially undoes A1's "reads proceed".
- **O2 (availability coupling). One failed evidence commit closes the whole anchor journal.**
  - A failed or timed-out provisional-evidence commit sets the lifecycle journal's `failed` (`commitState` catch). The **whole** anchor journal is then closed, including the bridge floor (`readAnchor`/`acceptAnchor`), until restart.
  - These are the same semantics as a failed `acceptAnchor` in r9, but r2 adds a frequent new writer (one commit per new two-anchor fact).
  - Fail-closed, not a security issue. Worth a decision: should an evidence-commit failure fence only the provisional tier rather than the finalized path?
- **Checked and fine:**
  - the relay commits evidence **before** returning a fact, and maps marker/full/failed to `provisional_disabled`/`evidence_unrecorded` (no fact);
  - S1 refuses `provisional` without the enrolled state, also defensively after start;
  - S2: the bridge requires `state.finalizedRoot` == this B_f;
  - S3: overlay segments link by the native-bound agreed output root;
  - the durable fence check runs before and after the read;
  - bounds and texts are unchanged.

No admin control, threshold or activation is changed. **Root reviews r3 independently before use.**
