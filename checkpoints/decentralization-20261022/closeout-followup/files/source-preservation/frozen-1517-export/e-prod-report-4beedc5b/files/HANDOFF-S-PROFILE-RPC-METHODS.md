# Handoff for S: the profile-RPC methods the built dashboard sends (file handoff only; S's tree is not edited)

**Candidate:** `work/rpc-wallet-production-build-20261023/repo`, branch `rpc-wallet-production-build`. The final commit is
in `RESULT-PRODUCTION-BUILD.md`.

This is what a browser on a confirmed independent profile sends to the profile's RPC origins.

## Always (unchanged by this work; S's closure `349318a06`)

Reads and estimates:
- `eth_chainId`
- `eth_blockNumber`
- `eth_getBlockByNumber`
- `eth_call` at `{blockHash}`
- `eth_estimateGas`
- `eth_getBalance`
- `eth_getCode`
- `eth_getLogs`
- `eth_getStorageAt`
- `eth_getTransactionReceipt`

## New, only when the owner explicitly chooses "the network profile broadcasts" in the wallet menu

| Method | Params | Purpose |
| --- | --- | --- |
| `eth_getTransactionCount` | `[from, "pending"]` | nonce for the transaction the wallet will sign |
| `eth_maxPriorityFeePerGas` | `[]` | tip. Optional: with no answer the page uses 0.001 gwei, and it caps the tip at 2 gwei |
| `eth_call` to `0x0000000000000000000000000000000000000001` | `[{to, data}, {blockHash}]` through the quorum | the chain's ecrecover checks who signed |
| **`eth_sendRawTransaction`** | `[signed EIP-1559 hex]` | the only write method. It goes to one origin at a time, in profile order; the same bytes go to the next origin only after a JSON-RPC error, no answer, or a different hash |

## Accepted answers

- `result` = keccak256 of the bytes.
- A JSON-RPC error matching `/already known|known transaction|already imported|already exists/i` also counts as
  accepted.
- Any other JSON-RPC error is a refusal; the page shows its message verbatim.

## Ingress requirements for that route

- CORS `POST` with `content-type` from the dashboard origin.
- Admit `eth_sendRawTransaction` by name. Do not open a generic method allowlist.
- Forward the bytes unmodified to a node that forwards to the sequencer. base-reth runs with gossip disabled.
- The receipt is then polled with `eth_getTransactionReceipt` through the profile. The page never asks the wallet about a
  transaction the profile broadcast.

## Not S's (for completeness)

- **Owner-named ERC-4337 bundlers:** P's Alto service, safe mode on.
- **The WalletConnect relay:** an outside service, and optional. Injected wallets and passkey accounts remain.
- **MetaMask:** it broadcasts through the RPC configured in the wallet. Pointing it at a verified live endpoint is a human
  wallet setting at cutover. The page cannot override it.
