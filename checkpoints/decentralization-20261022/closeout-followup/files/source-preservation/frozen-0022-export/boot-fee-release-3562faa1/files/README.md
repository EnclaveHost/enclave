# Boot-fee release: build template for the NEXT boot fix (ROOT-FEE-RELEASE-PREP.txt)

This is a source-only template, prepared 2026-10-23. Its author (D) built nothing and took no live action.

**Root's actual build** (23:28:02Z to 23:32:21Z): root approved H's 5db2be3f and ran the build, which PASSED with measurement
bc731956…. The first run refused (no approval file), which is kept. See `BUILD-RESULT.md`; only public metadata is committed.

**The fix it is for:** H's new sibling child of 9f6d37bd in `work/custody-boot-registration-20261023/repo` (branch
`boot-normal-fee`). It carries the reviewed 7dd3acd0 delta (pending shielded GPU price; a failed registry read never
registers) **plus** `sendOperatorTx` stating explicit fresh `estimateFeesPerGas` + `estimateContractGas` inside the existing
`_txChain`, so that viem's `eth_fillTransaction` path cannot multiply the node's padded fee again. The 7dd image's setProofKey was
refused: about 13.2 Mwei instead of the modelled 7 Mwei (`custody-boot-price-activation-20261023/FUNDING-MISMATCH-REVIEW.txt`).

**Code reuse:** every file but this README is **byte-identical to a340762**: `build-price.sh`, `precheck.py`, `verify.py`, `entries.py`,
`q.sh`, `scan.sh`, `refusal-tests/run.sh`, `tests/*`.
- **Same rules:** a single parent 9f6d37bd; delta exactly `supervisor.js` + the approved tests (+ `metal/guest/gsup.mjs` only with
  `gsup REVIEWED`); builder unchanged; a parent-anchored source patch free of the rewritten literal; the 9f control is
  byte-identical to the root-built 08d1f838; the candidate built twice; the exact manifest and entry delta; the image equals the
  commit; ed918e4b, ee5df6b8 and 08d1f838 reproduced.
- **Precheck pin:** `precheck.py`'s sha256 (e6f3cb97…) is unchanged, so the activation kit's `PRECHECK_SHA256` pin holds as-is.
- **Old commit.sh:** a340762's `commit.sh` is NOT copied (its file list and message belong to the 7dd release).
- **Nothing carried over:** no old `APPROVED-COMMIT.txt`, `stage/` or runtime file.

```
commit <40 hex of H's new commit>
gsup REVIEWED
tests <the exact test files the commit adds or changes, e.g. test/boot-gpu-price.test.mjs test/registry-advertise-retry.test.mjs test/...>
```

**Run (root, after approval):** `./q.sh 1024 build-price-1 bash ./build-price.sh` (the 7dd build peaked at about 301 MiB).
The 7dd build (b007d471) is not a control here, because the new commit is its SIBLING: the control is still 9f6d37bd = 08d1f838.
