# windows-owner-cli-stage (PREPARED, NOT RUN): `windows/node/host-onchain.mjs` without public RPC under the explicit verifier

**Not done:** no tests, builds, queue use, network, SSH, live change or commit. Only `node --check` and `bash -n` were
run. Root owns applying it to the source.

**Not touched:** r4 (`windows-chain-authority-stage/r4`; root's run 0208 reported `RESULT: PASS`) and the frozen
publication.

**Base:** `aebf4c932` + the **exact r4 source**. `r4-inputs/` holds the r4 patch (`f6aa86a5…`) and r4's
`CANDIDATE`/`BASE` manifests, copied unchanged. The r4 `chain.mjs` (`c5423d81…`) and `host-identity.mjs`
(`3eb47c0c…`) are byte-identical to the r4 candidate.

## What the CLI did (aebf4c932) and what it does now

**Its public dependencies (all of them):**

| Line | Dependency | Used by |
| --- | --- | --- |
| `:39` | `RPCS` = `BASE_RPCS` or publicnode/drpc/mainnet.base.org | everything below |
| `:45` | `pub = createPublicClient(fallback(RPCS))` | status balance, simulate, receipts |
| `:53` | `quorumReader(rpcClients(RPCS))` | `prepare-ownership`, `ownership-status` |
| `:77` | `wal = createWalletClient(fallback(RPCS))` | `writeContract` in `send` (declare-payout, deploy) and `sendTransaction` (fund-operator) |

The `chain.mjs` reads (`resolveAddresses`, `readEnclave`, `resolveAppRef`) were already routed by r4.

**Under `ENCLAVE_CHAIN_AUTHORITY=verifier`, using only existing APIs** (`chain.chainAuthority()` from r4,
`network/chain-authority.mjs`'s transport and `actionGate`, and r4's `host-identity.mjs` `verifierReader`):
- **`pub` and `wal`** use the authority's routed transport. Reads, simulation, estimates and receipts go to the local
  verifier (proven). `eth_sendRawTransaction`, the pending nonce and fee hints go to the operator-owned backend only.
  A transaction is never sent to the verifier.
- **Before EACH owner-signed submission:** `actionGate({submit: true})` runs (for declare-payout and deploy via `send`,
  and for fund-operator). The verifier's head must be fresh and the backend bound to its chain and head hash.
  - **No backend:** refused (`chain_no_backend`), nothing signed or sent.
  - **A backend on another chain:** refused.
- **The ownership commands** use `verifierReader({client: authority.client})`: the same reader contract and per-read
  policy (head − confirmations, the block re-read, staleness and reorg refused).
- **Refused before anything is read** (exit 2):
  - **an invalid selection**, including a backend without the verifier selection and a non-loopback verifier;
  - **`BASE_RPCS` beside the verifier** (mixed).
- **Inclusion:** `send` already required a receipt with `status === "success"`. **fund-operator** only waited for
  *some* receipt; it now also requires `status === "success"` (in both modes). A backend accepting the transaction is
  never treated as inclusion.
- **Unchanged:**
  - every command, its arguments and its output;
  - the `OWNER_KEY` handling (the wallet signs locally, and the operator key is never used);
  - fees and gas (viem preparation);
  - `prepare-ownership`'s unsigned transaction package and the ownership checks (verified code hash, the pinned
    registry and catalog);
  - the legacy `BASE_RPCS` path.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/windows/node/host-onchain.mjs` | `git show aebf4c932:` (`BASE-aebf4c932.sha256`) |
| `candidate/windows/node/host-onchain.mjs`, `candidate/test/windows-owner-cli.test.mjs` | `CANDIDATE.sha256` |
| `windows-owner-cli.patch` | 276 lines. On `git archive aebf4c932` + the r4 patch (R4 hashes verified) it applies and reproduces `CANDIDATE.sha256` exactly (checked) |
| `r4-inputs/` | the r4 patch and r4's `CANDIDATE`/`BASE` manifests, unchanged |
| `ALL-PATCHED.sha256` | r4 plus owner-CLI files, for the bundle-closure comparison |
| `EXPECTED-TAP.txt` | new 8; r4 runtime 12; `lease-seams-windows` 3; `move-release-confirm` 20 |
| `jobs/windows-owner-cli-tests.sh` | root's r4 runner with the same parser-exit `case`, offline, stage/base checks, dependency identity and bundle closure. It applies the EXACT r4 patch, verifies R4 hashes, then the owner-CLI patch |
| `jobs/bundle-closure.mjs` | unchanged |

**The test (8):** it runs the REAL CLI as a child process (argv + env) against loopback recorders (verifier, backend,
and a public sentinel) sharing one fake chain. The production registry ABI is taken from `chain.mjs` itself, and the
repository's real pins and verified-authorities files are used.
1. **`status`:** the registry entry and the owner balance come from the verifier; nothing goes to the backend or the
   public sentinel.
2. **`fund-operator`:**
   - the backend is bound (`eth_chainId` and `eth_getBlockByNumber`) **before** exactly one `eth_sendRawTransaction`;
   - the pending nonce comes from the backend;
   - the receipt comes from the verifier only;
   - the verifier never gets a send;
   - public 0.
3. **`declare-payout`:** the simulation runs on the verifier; then the gated submission; then the payout wallet is read
   back from the verifier.
4. **Pool acceptance is not inclusion:**
   - the backend accepted, but the verifier has no receipt: no success (it never reports "funded");
   - a reverted receipt: refused with `fund-operator reverted`.
5. **No backend:** `status` works; fund-operator and declare-payout are refused with a "backend" error; nothing is
   submitted anywhere.
6. **Selection refusals (exit 2), with nothing read or sent:** mixed `BASE_RPCS`, 4 invalid selections, and a
   wrong-chain backend (refused, nothing submitted).
7. **`ownership-status`:** the verified `EnclaveHostOwnership` is read at head − 2 through the verifier. A
   **contract-wallet owner** (the CLI supports any owner address; acceptance is signed by that wallet) is reported
   exactly, and `ready` is true.
8. **Legacy:** `BASE_RPCS` is used exactly as before for reads and the send; the verifier and backend are never
   contacted.

## Root job (after review; offline, cap 1792)

```
./jobs/q-exit-status.sh windows-owner-cli 1792 unshare -rn bash windows-owner-cli-stage/jobs/windows-owner-cli-tests.sh
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

## Remaining limits

- **`prepare-ownership` is not driven end to end.** Its observation requires the ownership contract's code hash to
  equal the verified one, and a recorder cannot serve those real bytes. It shares the exact reader path that test 7
  exercises. `deploy` is also not driven, because it needs a catalog fixture; it uses the same tested `send` path.
- **The fake verifier answers without proofs.** These tests cover routing, binding, gating, receipts and refusals; the
  real verifier does the proof verification.
- **Trust tier:** the verifier is the unsafe tier, with no L1 finality.
- **Not yet:** no live configuration and no SNP qualification.
- **The source commit** must carry r4 (with its regenerated host-admission and host-policy bundles) plus this patch.
- **Lease consumers stay on HOLD**, and Custody v2 stays refused.
