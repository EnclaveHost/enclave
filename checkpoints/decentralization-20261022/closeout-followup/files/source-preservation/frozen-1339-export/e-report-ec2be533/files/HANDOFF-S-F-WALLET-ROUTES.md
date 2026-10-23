# Handoff for S (public RPC ingress) and F (host services): browser wallet and bundler routes

Source: `work/rpc-wallet-dependency-20261023/repo`, branch `rpc-wallet-dependency`, commit `6ab298f19` on S's `349318a06`.
Not integrated; root reviews it first. This is not a request for S to change scope: it lists the methods the new browser
route sends to the endpoints S already serves.

## 1. New browser → profile RPC traffic (only when the owner explicitly chooses "the network profile broadcasts")

These go to the profile's RPCs (reads rotate as `baseRpc` does; the ecrecover call goes to the quorum):
- `eth_getTransactionCount [from, "pending"]`
- `eth_maxPriorityFeePerGas []` (optional: without an answer the page uses 0.001 gwei)
- `eth_call` to the ecrecover precompile `0x…0001` at an agreed `{blockHash}` (quorum)
- **`eth_sendRawTransaction [signedType2Hex]`**: one endpoint at a time, in the profile's order. The same bytes go to the
  next endpoint only after a JSON-RPC error, no answer or a different hash.

The existing reads stay as they are: `eth_estimateGas`, `eth_call`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`.

What the page expects back:
- **Accepted:** `result` equal to keccak256 of the raw bytes. A JSON-RPC error whose message matches
  `/already known|known transaction|already imported|already exists/i` is also accepted.
- **Refused:** any other JSON-RPC error. The page shows the message verbatim and tries the next endpoint.
- **Unknown:** an HTTP failure, non-JSON or a different hash. The page offers the **same signed bytes** to the next
  endpoint. That is idempotent propagation: no new signature, nonce or replacement, and one hash that executes at most
  once. After the last endpoint it sends nothing more, and reports the outcome as unknown. The owner must check the hash
  before creating another transaction.

What ingress must allow for this route to work (S):
- `eth_sendRawTransaction` from the browser origin, with CORS `POST` + `content-type`.
- Forward it to the node, which forwards to the sequencer (base-reth runs with gossip disabled).
- Do not rewrite or "fix up" the bytes; the hash is checked.
- This is the only write method the browser sends to profile RPCs. Admit it as a specific method, not through a generic
  allowlist. Rate-limit it per origin as S already does for reads.

## 2. Bundler endpoints (owner-named, per account; NOT profile RPCs)

The methods are `eth_maxPriorityFeePerGas`, `eth_estimateUserOperationGas` and `eth_sendUserOperation`, plus ERC-7677
`pm_*` to the owner's paymaster URL. The target is EntryPoint v0.7 only. There is no Enclave default.

A host role that wants to offer a bundler needs a real bundler service (`RECIPE-SELFHOSTED-BUNDLER.md`). F must not
ship a forwarding proxy and call it a bundler. Forwarding `eth_sendUserOperation` to a third-party bundler only moves
the dependency.

## 3. Existing self-hosted pieces that already fit

- **The credit page's relay route.** On `/credit/`, `relayTransport` → `/v1/credit-vault/submit` is served by
  `network/host-services/credit-vault-submitter.mjs`. That is an existing host service, owner-selectable, and the
  outcome is read from the chain (A owns its parity).
- **The admin console migrator** broadcasts its own signed transactions through the profile's `baseRpc`, i.e. the same
  `eth_sendRawTransaction` dependency as section 1.

## 4. Not supplied by any self-hosted component

- **MetaMask and other wallets without `eth_signTransaction`:** the broadcast always goes through the wallet's own RPC.
  Neither the page nor a host can change that. The owner's choices are:
  - set the wallet's Base RPC by hand (EIP-3085 is only an offer);
  - use a signing-only wallet;
  - use a passkey account with their own bundler.
- **WalletConnect:** every signing request crosses the WalletConnect relay (`projectId`), an outside service. Its `rpcMap`
  follows the profile.
- **Passkeys:** they are bound to their RP domain. If the RP is `enclave.host`, Enclave decides whether they stay usable,
  and the capability list now says so.
