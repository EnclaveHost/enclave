# windows-verifier.e2e r3: diagnostic-only driver patch (prepared; NOT run; candidate, r1/r2 stages and raw receipts untouched)

**Patch:** `r3/patches/windows-chain-driver-cause-chain.patch` (sha256 `ca1aac24fedfd61d145b39f8f957f992276f02c0929c00db0ce9eef71ed7390f`). It changes only `test/helpers/windows-chain-driver.mjs`.
- **Base:** blob `b8b24c66`, which is both the candidate HEAD and the r2 run repo's copy.
- **Result:** blob `d9c48bbc`; `node --check` passes.
- **Scope:** it applies independently of r1/r2, which touch only the test file. **No production code and no test assertion changes.**

## Actual r2 failure (`logs/root-windows-proof-r2-20261026T050834Z/test.tap`, sha256 `5a7ed3b9…`): 5 pass, test 5 fails
- **What the test received:** `readEnclave` was refused (`ok:false`) with "RPC Request failed. URL: verifier … Request body … Raw Call Arguments … Contract Call … Details: RPC Request failed …". The driver's `String(e.message).slice(0, 800)` cut it off inside the repeated request metadata.
- **Where the real reason would be:** the verifier transport (`network/chain-authority.mjs`) throws reasons such as `fail('chain_stale', "the verifier's head is N s old …")` (`:156`). `network/verified-chain.mjs:154/158` gives "verified block … is older than …", and other paths use `RpcRequestError` (`:92`, `:96`) or "… unreachable" (`:89`). viem nests these as `cause`.
- **I did not assume which of these is present:** the patch just reports whatever the chain holds.

## The change
- **New :** it walks `e → e.cause → …`, bounded to 8 levels and cycle-safe (a `Set`). For each level it takes `[code]`, the first line of `shortMessage || message`, and the first line of `details` if different, capped at 400 chars per level.
- **Output order:** the levels **innermost first**, joined with ` <- `, then ` || ` plus the full outer message, with 4000 chars total.
- **Unchanged:** `ok:false` and `code: e?.code ?? e?.cause?.code ?? null`.
- **The stale assertion is not weakened:** `/stale|behind|older/i` and `doesNotMatch /Invalid parameters/` stay in the test, unchanged. If the innermost cause is not a staleness reason, the test still fails, now showing the true reason.

## Reuse of the 5 actual passes
In `windows-verifier.e2e`, the driver's `error` string is used only:
- in `ok()`'s failure message (never on a passing op);
- in test 4's assert message, where the asserted value is `code === 'session_ended'` and the `code` derivation is unchanged;
- in test 5.

So tests 1–4 and 6 do not depend on the error text, and their actual passes are logically unaffected.
- **Rerun only the stale case** (r1+r2 test file, plus this driver), for example: `node --test --test-reporter=tap --test-timeout=300000 --test-name-pattern="stale head" test/windows-verifier.e2e.test.mjs`.
  - It still runs `before`/`after` (the rig) and test 5's tamper/down loop.
  - Strict byte-receipt identity for the reused 5 is root's call, since the driver blob changes.
- **The driver's other user is `test/windows-chain-authority.test.mjs`.** It matches error text at `:71` (`/verified chain state|verifier/i`) and `:76` (the exact `txPending` "pending pool is only known to an own transaction backend (ENCLAVE_CHAIN_TX_BACKEND unset)").
  - The new text still contains the full outer message after the cause chain, so both should still match.
  - That is not proven: total text is capped at 4000 chars. **Its receipt is affected by the driver change; rerun it** (no rig needed per its usage) or keep the old driver for it.

## Pins
`r3/SOURCE-PINS.txt` and `r3/SHA256SUMS`.
