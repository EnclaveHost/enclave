# windows-chain-authority-stage r4 (PREPARED, NOT RUN): the 3 actual r3 failures fixed with production-shaped fixtures + paid settlement through the own backend/verifier

**Not done:** no tests, builds, queue use, network, SSH, live change or commit. Only `node --check` and `bash -n` were
run.

**Preserved:** r1, r2 and r3, including the actual r3 failure `r3/run/20261026T015404Z` (`root-windows-authority-r3-0155`,
rc 1, runtime test 5/8), are unchanged. The frozen publication `source/ops/rpc-integration-progress-20261026` was not
touched.

**Base:** `aebf4c932`. `BASE-aebf4c932.sha256` pins the 8 base files, and the job verifies them.

## 1. The three actual r3 failures: causes and fixes (no validation relaxed)

| r3 test | Actual error | Cause | r4 fixture |
| --- | --- | --- | --- |
| #5 agent chain | `trusted checker addresses required` | my fixture passed `enclaveNetwork: {}`. `networkConfig` requires checkers, which is correct | a production-shaped enrollment with a trusted checker. The checker validation is **asserted** (an empty config still refuses). **The verified read must SUCCEED**: the value is `{at: "98", id: "8453"}` at head − 2 (98), and the recorder saw `eth_getBlockByNumber(98)`. There is no "ok or err" assertion |
| #6 admission | `invalid contract pin document` | a guessed pins shape | **the repository's own `contracts/deployments/contract-pins-base.json`** (`{version: 1, chainId: 8453, contracts}`), with the registry and catalog env taken from it. Under the verifier with `rpc: []` it builds (`decision` is a function, and `registry`/`catalog` equal the pins). Legacy `rpc: []` refuses with **the exact** `two independent HTTPS RPC origins`. An incomplete pins document refuses with `missing or invalid contract pin` (validation intact) |
| #8 contract wallet | `false !== true` (refusal hidden) | **Confirmed fixture mismatch, as root triaged.** The r3 `walletVerifier` answered every `eth_getBlockByNumber` with block `HEAD`. `LeaseReader.verifiedRead` asks for head − confirmations (98), and `verifiedHeader` requires the returned number to equal it: `verified block number differs from the one requested`. `verifyOwnerSignature` swallows that as `false`. The r3 timestamp was also re-read per call (a second-boundary risk) | The recorder now answers **the requested block** with **one fixed timestamp**. Before `verifyOwnerSignature`, a **direct verified read surfaces the exact values or the exact refusal**: `at` = 98, code `0x6001`, `isValidSignature` = `0x1626ba7e`. Every `eth_call`/`eth_getCode` is pinned by `blockHash`. Then ERC-1271 → true and SessionVault → true |

**New negative tests, each with its exact cause asserted from the direct verified read, and `verifyOwnerSignature` false:**
- **head-only answers** (reproduces the r3 cause): `differs from the one requested`;
- **stale block:** `stale`;
- **wrong chain:** `another chain`;
- **verifier down;**
- **refused signature:** the read succeeds with magic `0xffffffff`, and the signature is refused.

In every case the **public sentinel gets 0 requests**.

**Confirmations stay at their default (2).** Nothing is set to 0.

**Source change for these three:** none. The r3 product changes in `host.mjs`, `host-identity.mjs` and
`network/enclave-network-host.mjs` are byte-identical in r4. All three r3 failures were fixture defects.

## 2. Paid settlement under the explicit authority (source change)

**Real consumers traced:**
- `network/privacy-agent.mjs:255` calls `createPaidNetwork`.
- `network/paid-network.mjs` builds `client`/`wallet` for `ProviderUSDCSettlement`, which extends
  `USDCBandwidthSettlement` (`network/usdc-bandwidth.mjs`).
- That class signs locally, uses `client.sendRawTransaction`, and then **waits for `waitForTransactionReceipt`
  (confirmations 2) with `status === "success"`**. Its nonce journal reads `getTransactionCount('latest')` and
  `getTransactionReceipt`.

**Before:** `fallback([config.rpc, 'https://base.drpc.org', 'https://mainnet.base.org'])`, with the enrollment default
`paid.rpc = https://base-rpc.publicnode.com`. Those are public sends and reads.

**r4, `settlementChain({config, leaseReader, chainVerifier})` (exported; `createPaidNetwork` now uses it):**
- **Under the agent's local-verifier authority:** `createChainAuthority({verifier: cfg.chain.verifier, backend:
  paid.txBackend})`, the same module and routing as `supervisor.js`.
  - **Reads go to the verifier:** state, the 'latest' nonce, the anchor block and receipts (checked against the
    receipts root).
  - **The submission, pending nonce and fee hints go to the own backend.** `sendRawTransaction` is wrapped by
    `actionGate({submit: true})`: a fresh verifier head, and the backend bound to the verifier's chain and head hash
    before **each** send.
  - **Refused:** a settlement `rpc` under the verifier, a missing backend, or a missing verifier.
- **Legacy:** unchanged. A `txBackend` in legacy mode is refused (never mixed).
- **Success is still only a verified receipt** (the unchanged settlement logic). **Backend acceptance is never
  success** (tested).

**Plumbing:**
- `chain.mjs` `ownTxBackend()`.
- `agent.mjs` adds `paid.txBackend` under the authority.
- `network-enroll.mjs` `networkConfig`: legacy is unchanged (`rpc` default kept). Under the authority it writes
  `{proofKeyFile, gasKeyFile, txBackend, maxPending6}` with **no rpc**. Under the authority **without** an own backend,
  paid is **not configured**: nothing could be submitted, and no public RPC is used instead.
- `privacy-agent.mjs:255` passes `chainVerifier: cfg.chain.verifier` under the verifier.

**Tests:**
- **Prepare:** wallet preparation takes the pending nonce 5 from the backend; the estimate comes from the verifier.
- **Send:** the backend receives `eth_chainId` and `eth_getBlockByNumber` (the binding) **before**
  `eth_sendRawTransaction`. The verifier never gets a send.
- **Receipt:** it comes from the verifier, and the backend is never asked.
- **Backend accepts but the verifier has no receipt:** `waitForTransactionReceipt` **rejects**.
- **A backend on another chain:** the send is refused and nothing is submitted.
- **Configuration refusals:** RPC under the verifier, no backend, no verifier, a txBackend in legacy mode, and a
  non-HTTPS legacy RPC are all refused. Legacy still builds.
- **Enrollment:** legacy, own-backend, and no-backend paid configuration.
- **Sentinel:** 0 public requests.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/` (`BASE-aebf4c932.sha256`), `candidate/` (`CANDIDATE.sha256`) | the 8 files |
| `windows-chain-authority-r4.patch` | 743 lines. Applies to `git archive aebf4c932` and reproduces `CANDIDATE.sha256` exactly (checked) |
| `test/windows-chain-authority-runtime.test.mjs` | **12 tests** |
| `EXPECTED-TAP.txt` | the runtime test 12; regressions `lease-seams-windows` 3 and `move-release-confirm` 20; touched-module regressions on **both** candidate and unpatched baseline: `paid-network` 5, `contract-owner-signature` 2, `enclave-network-host-canary` 5, `network-authority-pins` 4, `host-egress` 9 |
| `jobs/windows-chain-authority-r4-tests.sh` | root's r3 runner (parser-exit `case`, offline, stage/base/candidate checks, dependency identity: lock-identical absolute `node_modules` link) |
| `jobs/bundle-closure.mjs` | unchanged from r3 |

**The 8 candidate files:**
- r3, byte-identical: `windows/node/host.mjs`, `host-identity.mjs`, `network/enclave-network-host.mjs`.
- Paid plumbing on top of r3: `windows/node/chain.mjs`, `network-enroll.mjs`, `agent.mjs`.
- New in r4: `network/paid-network.mjs` and `network/privacy-agent.mjs`.

**How the job differs from r3:** r4 paths; the patch; 8 files `--check`ed; and each `EXPECTED-TAP` line runs in its
own tree, so the base lines use the unpatched baseline clone. The bundle closure is unchanged (staleness published,
the host-admission pair rebuilt from exact source, baseline and candidate compared).

## Root job (after review; offline, cap 1792)

```
./jobs/q-exit-status.sh windows-chain-authority-r4 1792 unshare -rn bash windows-chain-authority-stage/r4/jobs/windows-chain-authority-r4-tests.sh
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

## Remaining

- **The owner CLI `windows/node/host-onchain.mjs`:** a separate follow-up (`:39`, `:45`, `:53`, `:77`/`:91`).
- **The regenerated host-admission and host-policy bundles:** they must be committed in the source with the patch.
- **Paid under the authority without an own backend** is deliberately **not configured** (no public fallback). That
  feature needs `ENCLAVE_CHAIN_TX_BACKEND`.
- **The fake verifier answers without proofs.** These tests prove routing, binding, pinning and the refusal causes,
  not proof verification (which the real verifier does).
- **Not yet:** no live configuration, and no SNP qualification. Lease consumers stay on HOLD; the lease flags and
  source are unchanged; Custody v2 stays refused.
