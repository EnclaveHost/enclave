# windows-owner-cli-stage r2 (PREPARED, NOT RUN): the stdout JSON contract of status / ownership-status

**Not done:** no tests, builds, queue use, SSH, network, live change or commit. Only `node --check` and `bash -n` were
run.

**Preserved:** r1 (`../`) and its actual failure `../run/20261026T021322Z` are unchanged. The consumer head
`e4f507d6b` was read only.

## The actual r1 failure (`root-windows-owner-cli-0215`, rc 1)

- **The new owner-CLI test:** 6 of 8. Tests #1 (`status`) and #7 (`ownership-status`) failed with
  `JSON.parse(stdout)`: `Unexpected token 'c', "[chain] aut"... is not valid JSON`.
- **The regressions** (r4 runtime 12, `lease-seams-windows` 3, `move-release-confirm` 20): all pass.

## The output contract (the evidence) and the decision

- **`host-onchain.mjs` writes exactly one `JSON.stringify(...)` document to stdout** for `status`
  (`console.log(JSON.stringify({owner, ownerEth, endpoint, enclaveId, registered, entry, addresses}, null, 1))`) and for
  `ownership-status` (`console.log(JSON.stringify(await own.ownershipStatus(...), null, 1))`). It is the same at
  `aebf4c932` and `e4f507d6b`; `host-onchain.mjs` is byte-identical there.
- **Before the authority existed, importing `chain.mjs` printed nothing to stdout.** The `[chain] authority: …` line is
  new: r4's `console.log` at `windows/node/chain.mjs:54`, on every import under an explicit selection.
- **The contract therefore promises machine-readable JSON** on stdout. A diagnostic there is a **real regression**:
  any script piping `status` into a JSON parser breaks. It must not be hidden by stripping text in the test.
- **The fix** (`windows/node/chain.mjs`, the one line): the authority diagnostic uses `console.error` (stderr), like the
  module's existing invalid-selection message. Nothing else changes, and nothing is removed:
  - the line still prints on every load under the authority;
  - REFUSING selections still print their reason;
  - every error path is unchanged.

  `supervisor.js` has the same `console.log` line. It is not a JSON-printing CLI, so it is not touched here.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/` (`BASE-e4f507d6b.sha256`) | `windows/node/chain.mjs` (= r4 candidate `c5423d81…`) and `windows/node/host-onchain.mjs` (= aebf `de5f5b27…`) |
| `candidate/` (`CANDIDATE.sha256`) | `chain.mjs` (the stderr line), `host-onchain.mjs` (**byte-identical to r1's candidate**) and the test |
| `windows-owner-cli-r2.patch` | 295 lines. Applies to `git archive e4f507d6b` and reproduces `CANDIDATE.sha256` exactly (checked) |
| `EXPECTED-TAP.txt` | owner-CLI 8, r4 runtime 12, `lease-seams-windows` 3, `move-release-confirm` 20: **exactly 43** passing, 0 fail/skip/todo/cancelled |
| `jobs/windows-owner-cli-r2-tests.sh` | the r1 job on base `e4f507d6b` (no r4 patch: the head carries it). It keeps the parser-exit `case`, offline checks, base/candidate checks, dependency identity and the bundle closure |
| `jobs/bundle-closure.mjs` | unchanged |

**What the test changes (r2) asserts in #1 and #7:**
- **The WHOLE stdout parses as one JSON document.** Nothing is stripped or extracted.
- **stderr carries `[chain] authority: local verifier … (unsafe tier, no L1 finality)`**, so the diagnostic is not
  dropped.
- **stdout has no `[chain]`.**

**And in #8 (legacy):** no authority line at all. All other assertions are unchanged from r1.

## Root job (after review; offline, cap 1792)

```
./jobs/q-exit-status.sh windows-owner-cli-r2 1792 unshare -rn bash windows-owner-cli-stage/r2/jobs/windows-owner-cli-r2-tests.sh
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS (all 43) |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

## Limits

- **The source patch changes `chain.mjs`** (one line, already in the pushed head). The source commit carries it with
  `host-onchain.mjs`.
- **Log capture:** a Windows node whose log capture reads only stdout would no longer see the authority line. Its
  stderr is captured in the same log, per the node's launcher; this is not re-verified here.
- **r1's other limits stand:** `prepare-ownership` and `deploy` are not driven end to end, the fake verifier serves no
  proofs, the verifier is the unsafe tier, and nothing is live or SNP-qualified. Lease consumers stay on HOLD, and
  Custody v2 stays refused.
