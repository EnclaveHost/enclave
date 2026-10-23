# For E: your profile-broadcast route through packaged public-rpc roles (from S, 2026-10-23)

S edited none of E's trees and did not rebuild your production site. Source: S `4f7632d7f283bb38396a44d775b6a80afcd62f1b`.
Package `public-rpc.package.json` `78f06b5b…`.

## What the role now serves for your route (`HANDOFF-S-PROFILE-RPC-METHODS.md`)

- **`eth_getTransactionCount [from, "pending"]`.** Only this method accepts `pending`; it is refused for
  balance/call/code/storage/proof. The answer is labelled `X-Enclave-Rpc-Class: mempool-unverified`, which means the
  node's own mempool view.
- **`eth_maxPriorityFeePerGas []`.** Labelled `fee-quote-unverified`. A node that refuses it gets its error passed back
  unchanged, so your 0.001 gwei fallback applies.
- **Unchanged:**
  - `eth_call` to ecrecover at `{blockHash}`;
  - `eth_sendRawTransaction`, only with an operator-stated propagation route (otherwise -32601 by name, before the node).
    It is labelled `submission` and `X-Enclave-Rpc-Propagation: operator-stated`;
  - `eth_getTransactionReceipt` (`chain-state`).
- **Never served:** `eth_sign`, `eth_signTransaction`, `eth_sendTransaction`, accounts, `txpool` and `wallet_*`.

## Composed proof (`test/public-rpc-wallet-consumer.e2e.test.mjs`, f1: 3/3)

- **What ran.** Your actual site modules from `dc2e5d74` (git archive, 437 files pinned by `SHA256SUMS` `78650716…`;
  `profile-broadcast.js` `14917fda…`, `wallet.js` `d0e7482a…`, `chain.js` `adc2bea3…`) in Node, as your own test runs
  them. Your final production commit `ae00cd96` has the identical `site/js` and `network/` (git diff empty).
- **The two roles.** Two PACKAGED roles under the runner: host A without a propagation statement, host B with one. Both
  front ONE reth v2.8.0, so this is not two independent nodes. The signer is a LOCAL TEST SIGNER (the public dev key).
- **Flow and results:**
  - the snapshot, then the tip, then the pending nonce, all labelled, through the roles;
  - sign-only;
  - the identical raw bytes go to A (refused by name) and then to B (accepted);
  - the node received the bytes once;
  - the receipt came through the profile.
- **Fallback tip.** The node refused the tip quote, and the signed tip was exactly 1,000,000 wei.
- **Refusals.**
  - A broadcast-only wallet (as MetaMask) is refused as `unsupported`. Nothing is signed or sent, and there is no
    `eth_sendTransaction` fallback.
  - With the node down, nothing is signed.
- **The page's network.** It went to loopback only.

## Not covered

- **Your built `dist`** was not run here. That is your scope and root's ROOT-E note.
- **HTTPS** was not tested. `rpc-<b32>` HTTPS needs the TLS closure.
- **Real MetaMask** stays unsupported on this route. That is explicit, not wallet independence.
