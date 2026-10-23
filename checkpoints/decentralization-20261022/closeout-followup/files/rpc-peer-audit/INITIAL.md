# rpc-peer-audit — INITIAL (2026-10-22 local / 2026-10-23 UTC)

Worker: second Claude worker, READ-ONLY primary-source protocol audit. No edits to
`rpc-priority/repo` (owned by worker 329522d2), no builds, no live peer connections,
no scans, no credentials, no production action.

Requirements read: `work/effective-goal-requirements.txt` (RPC PRIORITY 2026-10-23,
no-NVMe, admin controls, contract compatibility, Sia-S3 must not create a bootstrap cycle).

## Questions in scope

1. What does `base/base` actually pin (reth version, network protocols, snap/1 vs snap/2
   serving)? Immutable commit/tag, not branch names.
2. Do Base mainnet peers advertise snap (1 or 2)? Docs ports 9222/30303 are NOT proof.
   Only a bounded RLPx Hello capability probe can answer; recipe to be written, not run.
3. Proof semantics of snap range proofs vs what Enclave needs (eth_call-style contract
   reads at an authenticated recent root; account+storage proofs; code).
4. Authenticated Base root: separate (a) unsafe sequencer-signed gossip/commitment,
   (b) output-root proposal on L1 (DisputeGameFactory), (c) finality (L1 finalized +
   game resolution / challenge window), (d) execution/state proof against a root.
   Helios opstack = (a) via hosted consensus_rpc. L1 light client gives L1 headers only.
5. Transaction submission: P2P tx broadcast (eth Transactions/NewPooledTransactionHashes)
   vs sequencer acceptance vs inclusion proof (receipt proof against authenticated root).
6. Sia role: immutable hash-addressed proof objects only; never canonicality, never a
   required central index.

## Local libraries found so far (before any web read)

- Go module cache: `github.com/ethereum/go-ethereum@v1.13.5` (contains `p2p/rlpx`,
  `cmd/devp2p` (rlpx ping), `eth/protocols/snap` snap/1 client+`trie.VerifyRangeProof`).
  Old (Nov 2023); OP/Base fork-id awareness to be checked.
- Toolchains present: go, cargo/rustc, node, python3. No geth/reth/op-node/helios binaries.

## Plan

Primary-source reads (raw GitHub at immutable refs, official specs) → RESULT.md with
available / unsupported / unknown tables and one bounded probe recipe (or "none verified").
