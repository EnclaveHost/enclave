# Host-sponsor submit on the real pinned verifier, offline chain: result

- **Base:** commit `d6fbafb93` (`fix/rpc-relay-consumers-20261025`). Only `relay-consumer-source` is touched.
- **Not done:** no keys, live config, SSH, images, commits or pushes.
- **Historical evidence is unchanged:** `logs/claude-relay-consumer-result.md`.
- **No deployment claim.** Full relay activation stays **BLOCKED** by writer finality and complete history, as recorded
  there. Nothing here changes that.

## Source changes

**No product source changed:** neither E2E revealed a product defect. New, untracked files only (sha256):

| file | sha256 |
|---|---|
| `test/relay-sponsor-verifier.e2e.test.mjs` | `5eafe08bc25f172aa2e1803b22e70e9070025e2b51644c5d6bca84d4befb1fdd` |
| `test/relay-counterfactual-wallet-verifier.e2e.test.mjs` | `d25fe44ad626c8e8cc44314735d9d223126186fafabffb2dcceeaf0413ffd348` |
| `jobs/relay-sponsor-e2e.sh` (outside the tree; offline runner, skips fail) | `c6e3f12e37b709adfcac5af44af0974e0daea2d189457d8e74b859943a2fa2c3` |
| `jobs/forge-prebuild-sponsor.sh` (outside the tree; serial prebuild) | `600cc37eecadbfbb23cbb9a5ba021706ac2ff64bc98d48c43f5b6b2b9a9ff4af` |

Generated, gitignored artifacts (`contracts/foundry/out`), built one source per invocation with `forge build -j 1` at
1024 MiB (peak 73 MiB, `logs/forge-prebuild-sponsor.out`):
- `EnclaveRegistry.json`: `1c9c52b4…`
- `EnclaveHostPaymaster.json`: `1917e40b…`

## 1. Full host-sponsor submit: REAL pinned verifier, offline chain — **3/3 pass, 0 skipped**

- Log: `logs/relay-sponsor-r2.tap` and `.summary`.
- Guard: 1408 MiB, peak 845 MiB (`logs/rs1.guard`).
- Offline: `test-control.sh`, `unshare -n`, required artifacts.

**Setup (all synthetic, on an isolated chain):**
- **Chain:** reth `--dev`, chain 8453, Prague from block 0. A derived genesis places the canonical Base EntryPoint v0.8,
  SenderCreator and Simple7702Account code from `test/fixtures/base-code/aa-code-base.json`, and sets a Base-like base fee
  of 0.01 gwei (see the first run below).
- **Contracts:** `EnclaveRegistry` and `EnclaveHostPaymaster` are deployed from the Foundry build. The paymaster has a
  0.001 ETH cost cap and a 0.05 ETH deposit; the bundler gets 1 ETH from a dev key.
- **Relay:** `hostSponsor({ authority })`. The authority is `createChainAuthority` over the REAL verifier runtime
  (`helios-eeffcc9`) as the only read/simulate/receipt authority, with reth as the own backend. Each sits behind a loopback
  recorder. The legacy `rpc` is a dead URL.
- **Box:** the REAL `windows/node/sponsor.mjs` `sponsoredRegister`, over HTTP (`hostSponsorRouter`). Negative cases
  rewrite the box's request through its `fetchImpl` and re-sign it with the box's transport key, as a box would.

| case | observed |
|---|---|
| success | A fresh key with 0 ETH registers. `success: true`; the chain receipt is `success`; `UserOperationEvent.success` with the paymaster paying; the registry emits `Registered(operator, endpoint)`; the key still holds 0 ETH. Exactly **one** broadcast: type 4 (`eip7702`) to the EntryPoint, carrying the operator's Simple7702 authorization, hash = the returned tx, sent to the own backend. The verifier was never sent a transaction. The backend was never asked `eth_call` / `eth_estimateGas` / `eth_getCode` / `eth_getTransactionReceipt` |
| the same machine again | **403** "sponsored already" at the voucher; nothing broadcast |
| authorization for another account nonce (validly signed by the operator, nonce + 1) | **409** "proven nonce is 0"; nothing broadcast |
| authorization signed by another key | **400** "not signed by the operator key"; nothing broadcast |
| invalid paymaster voucher (signature byte flipped, op re-signed over it) | **422** "the operation would fail": handleOps reverts in the verified simulation; nothing broadcast |
| invalid operation signature (the operator's key over the wrong hash) | **422** "would fail"; nothing broadcast |
| unsupported operation shape (`initCode` set) | **403** "initCode must be empty"; nothing broadcast |

**First run (`logs/relay-sponsor-r1.tap`): 0/3, environment, NOT a product defect.**
- The dev genesis starts at a 1 gwei base fee. The box client prices the op at 2 × base fee + tip.
- That exceeds the sponsor's unchanged 1 gwei cap (`LIMITS.maxFeePerGas`), so every voucher was rightly refused:
  "op fees exceed the sponsored maximum".
- Fix: the derived test genesis now carries Base-like fees (`baseFeePerGas` 0.01 gwei). The limit was not touched.

## 2. Undeployed (counterfactual) ERC-6492 wallets: REAL pinned verifier — **3/3 pass, 0 skipped**

- Log: `logs/relay-sponsor-cf1.tap` and `.summary`.
- Guard: 1408 MiB, peak 795 MiB.

**Setup:** two hand-assembled CREATE2 factories (ALWAYS / NEVER wallet). The wallets are never deployed; the chain and
the verifier both show no code. Signatures are wrapped with `serializeErc6492Signature(factory, calldata, sig)`.

| product path | support | observed (oracle reth vs verifier) |
|---|---|---|
| `relay/auth.js` smart-wallet sign-in (viem `verifySiweMessage`) | **supported** | ALWAYS: true / true. NEVER: false / false. The factory runs inside viem's deployless validator on the real Helios, and verifying deploys nothing |
| secrets owner gate (`relay/contract-owner-signature.mjs`) | **not supported, by design** (addressed ERC-1271: getCode first) | false / false for both wallets |
| network owner check (`network/owner-signature.mjs`) | **not supported, by design** | false / false for both wallets |

These are distinct from the already-tested **deployed** wallets (`logs/relay-sw-rc5b.summary`). For those, all three
paths equal the chain.

## 3. Remaining (exact)

- **No relevant regression rerun:** no product source changed in this task. The committed evidence in
  `logs/claude-relay-consumer-result.md` stands as recorded.
- **Synthetic setup:** the sponsor E2E uses the registry and paymaster built from this tree's sources on a synthetic
  chain, not Base's deployed instances.
- **Fee envelope:** the paymaster's `maxCostPerOp` and the relay's fee limits were exercised only at Base-like fees.
- **Unchanged blockers:** writer-authority finality and completeness (refused under the verifier, guest self-fences);
  stale measured guest bundles; and the other unmigrated components, as listed in the historical report.
