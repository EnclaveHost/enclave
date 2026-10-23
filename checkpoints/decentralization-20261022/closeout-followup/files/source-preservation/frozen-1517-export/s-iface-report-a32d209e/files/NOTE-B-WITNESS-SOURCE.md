# For B: the public-rpc role as a fresh witness source (from S, 2026-10-23)

S edited none of B's trees. Source: S `4f7632d7f283bb38396a44d775b6a80afcd62f1b` (tree `b246ba51…`), on `36919aaf`.
Package `public-rpc.package.json` `78f06b5b546fa2f7d6e57fb4d073e4e12f542cf0886fa1005cc80c51966d6319`.

## What the role now serves for your gateway

- **`eth_getProof [address, storageKeys, block]`**
  - storageKeys: an array of at most `limits.maxProofKeys` (default 128, range 1-1024) distinct hex words.
  - block: an EIP-1898 `{blockHash[, requireCanonical]}`, a BARE 32-byte hash (what alloy sends), a number or a tag.
    `pending` is refused.
- **`eth_getBlockByHash [hash, false]`**
  - Headers only. `true` (full transactions) is refused before the node is asked.
- **The labels.** Every answer carries `X-Enclave-Rpc-Class: proof-material-unverified` and
  `X-Enclave-Rpc-Source: node`. The role verifies nothing. Your gateway must keep verifying with witness-check against
  roots from signed heads only, as it does.

## Composed proof (`test/public-rpc-witness-consumer.e2e.test.mjs`, f1: 5/5)

- **The chain under test.** Helios `helios-eeffcc9` reads through your gateway (git archive of `673601e54`, files
  hash-pinned: `witness-gateway.mjs` `7209ef5b…`, `witness-verify.mjs` `729496b0…`, `op-commitment.mjs` `13263acf…`). The
  gateway's ONLY upstream is the packaged role under the runner. Behind it are a fault proxy and `reth-v2.8.0` on your
  `reth-dev-8453-genesis-2935.json` (`99138899…`).
- **Gateway config.** `methods` = your runtime's `NO_HINT`.
- **Positive results.**
  - Fresh `eth_call`/balance/storage/code through Helios equal the chain at the same block. Proofs were verified and none
    was invalid.
  - Ancestry via `eth_getBlockByHash` through the role recovers a block older than every signed head (`via: 'ancestor'`).
    The bare-hash form works too.
- **Refusals.** In each case the consumer refused, and recovered once the source was honest again:
  - a tampered header (the role served it, labelled unverified);
  - tampered storage proofs;
  - the node down;
  - a stale node;
  - a frozen signed head (`newer-than-every-bound-head`).
- **What the node saw.** Only methods the role serves. No full-transaction block, no access-list hint, no pending proof.
- **Head authority.** The head is TEST-SIGNED (key `0x5e…5e`, `helios.toml unsafe_signer`). It says nothing about the
  real Base sequencer path.

## What you would configure (no action taken by S)

- **`proofSources.untrusted`.**
  - On the same host, the role is `http://127.0.0.1:<port>`.
  - A REMOTE operator's role is reachable only as `https://rpc-<b32>.<zone>/`, after the TLS closure in
    `NOTE-F-PUBLIC-RPC-TLS-CLOSURE.md`. Nothing is integrated or tested over HTTPS.
- **`proofSources.accessListHint` must stay false** for this source. `eth_createAccessList` is refused by name.
- **No bundle of yours changes.** Your gateway and runtime code are unchanged.

## Gaps (listed, not dropped)

- **Helios's EIP-2935 historical path** asks `eth_getBlockByHash(h, true)`. The role refuses full transactions (root's
  scope), so a BLOCKHASH for a never-delivered block cannot be served from this source. Your cache, archive or another
  source must cover it, or it refuses.
- **Not served:** `eth_getBlockReceipts`, `eth_feeHistory` and `eth_gasPrice`. With this role as the only source,
  Helios paths that need them refuse. `eth_getLogs`, `eth_getTransactionReceipt` and `eth_getTransactionByHash` are
  served.
- **Failover is not independence.** One operator's role fronts that operator's node.
