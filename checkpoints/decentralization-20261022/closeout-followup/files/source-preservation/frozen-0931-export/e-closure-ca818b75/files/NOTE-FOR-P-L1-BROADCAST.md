# Requirements for P's L1 pair (work/rpc-l1-source-package, pins 5ccee19 / c0282ca), from E's transaction work

This is a file note only. Nothing in P's tree was edited, and nothing here asks P to resume or change its active pins
on its own initiative. Route this through root.

## Why E needs anything from the L1 pair

`work/rpc-transaction-independence` builds UNSIGNED L1 `depositTransaction` requests to Base's OptimismPortal
(`0x4904…e97e`; observed implementation `0x03863ab7…`, `version()` 6.0.1, at L1 block `0x1909a37` from one public
provider). The deposit is the only censorship-resistant way onto Base: base-reth has tx gossip disabled, and every RPC
forwards to the sequencer.

To use it with no public RPC, three things are needed:
1. a way to BROADCAST one signed L1 transaction;
2. VERIFIED L1 reads before signing;
3. a VERIFIED L1 receipt and finality classification afterwards.

## 1. Opt-in local broadcast of a signed raw L1 transaction (maintained reth; no keys in the node)

- **Shape.** One loopback-only, opt-in method that hands an ALREADY SIGNED raw transaction (`0x02…`, chain id 1) to the
  local reth txpool. reth then propagates it to its peers (eth/68).
  - The signer stays outside the node: an operator-controlled wallet, after root review.
  - The node holds no key and signs nothing.
- **Current blocker.** `--disable-tx-gossip` (P's current READ-ONLY profile) stops propagation. Two options:
  - a separate "send" profile; or
  - a one-shot `eth_sendRawTransaction` from the loopback API under a profile without `--disable-tx-gossip`.

  Either must be a deliberate, separately reviewed switch, never the default. P decides which reth mechanism is cleanest;
  E needs only the method contract below.
- **Method contract E will call.**
  - `eth_sendRawTransaction(raw)` on `127.0.0.1` → tx hash.
  - No retries to any public RPC on failure: a refusal is an error returned to E. E's tracker owns resends, and a
    resend must reuse the same L1 nonce.
- **Gates.** It accepts only chain id 1, and only `to` = the pinned portal (an allowlist). A size limit is fine.
  Optional but useful:
  - a `txpool_content`-style local check that the tx is pending;
  - the peer count at send time.

## 2. Verified L1 reads before signing

All reads are pinned to one L1 block (EIP-1898 `{blockHash}`) whose header and state the pair has validated.
- Portal proxy EIP-1967 implementation slot `0x3608…2bbc` and `version()`. E pins implementation + version
  (`checkPortalPin`) and refuses any other.
- SystemConfig `resourceConfig()` and portal `params()` (`prevBaseFee`), for the L1 cost disclosure:
  - burn ≈ `gasLimit × prevBaseFee`;
  - measured: an 800k L2 gas limit costs about 832k L1 gas at a 1 gwei base fee.
- The sender's nonce and base fee (`eth_getTransactionCount`, `eth_feeHistory`) for the signer.

## 3. Verified L1 receipt and finality

- `eth_getTransactionReceipt` / `eth_getBlockReceipts` for the deposit's block, from the validated chain.
  - E's `matchDepositEvent` takes the receipt plus a proof label naming the verifier: `l1-execution-proof` for the
    full reth+Lighthouse pair, `l1-light-client` for a light client.
  - E refuses any other label, including its own test label `test-anvil-l1`.
- Finality: the L1 block's `finalized` status from the beacon node, as a separate, explicit field. When it is
  unavailable, E fails closed (`pending`). E never derives finality from the submission endpoint's answer.

## Not needed from P

- Base derivation and safe/finalized L2: those belong to S (the holder) and B (the verifier).
- Signing.
- Any public RPC fallback.
