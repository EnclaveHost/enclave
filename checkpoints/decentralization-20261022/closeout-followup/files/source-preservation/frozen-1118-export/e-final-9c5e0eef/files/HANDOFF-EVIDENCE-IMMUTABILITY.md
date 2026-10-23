# Immutable evidence API: handoff for A (consumer parity), B (runtime) and root

**Gap fixed** (root probe `work/resume-after-checkpoint-20261022/root-evidence-immutability-review`, source `46dbfbef`):
- `mint()` froze only the outer object. After `createL1PairSource().receipt()`, a caller could still rewrite
  `evidence.transaction.nonce`, `receipt.status` and `receipt.logs`. The object kept its brand and its receipt identity
  while doing so.
- No external attacker or real transaction was involved.

## What changed (`src/evidence-brand.mjs`, both adapters)

- **`mint(obj)` = an owned deep snapshot.**
  - It copies with `structuredClone` (viem BigInts, nested receipts, logs, topics, transaction, heads, finality
    checkpoint and source all survive), then deep-freezes every object and array in the copy.
  - Binary buffers and functions are refused. Evidence is plain data with hex strings.
  - The adapter's working objects and any caller-passed object are NOT frozen. A caller's later writes do not reach the
    minted copy.
- **Receipt identity is unchanged:** `receipt(txHash)` returns `{state, receipt, evidence}` with
  `receipt === evidence.receipt`, the frozen snapshot. Every existing call keeps working:
  - `matchDepositEvent(plan, undefined | result.receipt, result.evidence)`
  - `classifyL2Outcome({receipt: result.receipt, source: {evidence}})`
  - `tracker.resolveFailedL1(key, result.receipt, result.evidence)`
- **Writes to minted evidence throw** `TypeError` in strict code (all ES modules). In sloppy scripts they are silently
  ignored; the facts still do not change.

## Consumer rules (A: CLI/MCP parity; B: runtime)

- Never copy evidence to "fix it up". A spread or `structuredClone` copy loses the brand and is refused by every
  default check.
- To annotate, keep your own object next to the evidence; never put fields inside it.
- Display `evidence.trust`, `evidence.level` / `finalized`, and the adapter readiness checks verbatim.
- `mint` is an ordinary export. Any code in the same process can mint, so this is NOT a cryptographic capability. It
  protects against callers, configs and endpoints asserting or altering evidence by accident or by data, not against
  code that deliberately mints its own.
- **Trust labels are unchanged.** `local-validated-pair` is local full-node validation, not a portable proof.
  `test-fixture` is refused by default.

## Evidence (tests)

`test/evidence-immutability.test.mjs`: the actual `createL1PairSource.receipt` over a labelled scripted loopback pair,
no real chain.

**Counter-control: the old source `46dbfbef`, extracted from git.**
- A rewritten nonce (7 → 999) let `resolveFailedL1` free a slot recorded for a different L1 transaction.
- A forged `TransactionDeposited` log pushed into a deposit-less receipt was MATCHED as a real deposit.
- `receipt.status` was writable.
- Top-level `finalized` was already frozen there, so that case was not exploitable.

**Current source:** every one of those writes throws, and the classifiers see the node's answer:
- `l1-receipt-mismatch` for the slot;
- the deposit is not L1-final;
- no deposit to match.

BigInt and receipt identity are kept, and the caller's own object is not frozen.

## Runs

- `test/evidence-immutability.test.mjs`: **3/3** (`logs/immut-3.out`).
- **Re-run of only the suites that consume minted evidence**, in one 512-MiB job (`logs/immut-final-suite.out`):
  evidence-immutability 3 + finality 1 + source-binding (anvil) 4 + source-binding (scripted) 2 = **10/10**. That
  includes the positive deposit match on frozen REAL portal logs and safe/finalized through frozen Base evidence.
- **Mutants:** 27 (no owned copy) and 28 (shallow freeze only) **killed** (`logs/immut-final.out`).
- **Not re-run, and why:** the other 25 of the previous 32 tests (fee audit 3, forced inclusion 6, l1-portal 5, policy 3, tracker 1, vault 7) mint
  nothing and use only explicit `test-*` labels. The delta (mint + the two adapters' returned receipt) does not reach
  them.
- **Earlier failed runs, kept:**
  - `immut-1`: the counter-control expected the old top-level `finalized` to be writable; it was already frozen.
  - `immut-2`: the scenario wrote `status = reverted` before matching.
- **Scans:** crypto-key scan clean, gitleaks no leaks.
