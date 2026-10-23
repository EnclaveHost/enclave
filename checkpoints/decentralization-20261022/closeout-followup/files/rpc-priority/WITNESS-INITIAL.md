# WITNESS-INITIAL (revision 3 update, 2026-10-23 ~00:55Z): independent verification of the peer audit

These supersede the corresponding rev-2 statements below.

| Claim | Independently verified result | Evidence |
|---|---|---|
| "Helios can't decode Base 0x79" | **Mechanism TRUE, not triggered today.** Helios 0.12.0 locks op-alloy-consensus **2.0.0** (crate sha256 `6ca73133…` = Cargo.lock checksum). Its `OpTxEnvelope` has types 0, 1, 2, 4, 0x7E and **0x7D PostExec** (an OP type, *not* 0x79). Base `EIP8130_TX_TYPE_ID = 121 (0x79)` (base/base 5476069f `tx_type.rs`) is "gated behind Everest", and **mainnet `everest_timestamp: None`** (`chains/src/config.rs`). Live, read-only, single provider: 10 recent blocks, 2,107 txs, types {0x00, 0x02, 0x04, 0x7e} only (`fixtures/live-txtypes/evidence.json`). Helios `payload_to_block` `unwrap()`s the decode, and the release profile is `panic = "abort"`, so stock Helios will **abort** when Everest activates. | vendor-inspect/crates/oac, base/base API reads |
| v3/v4 gossip | **Helios opstack-server is broken for Base.** Base `BlockHandler::topic()` publishes Isthmus+ blocks on `/optimism/8453/3/blocks`, and the old topics retire 60 s after their replacement fork (base/base `consensus/gossip/src/handler.rs`; op-node `gossip.go` is the same). Helios subscribes to `/2/blocks` only. **The payload and signature are compatible**: Base `decode_v4` = `sig(65)‖parentBeaconRoot(32)‖SSZ BaseExecutionPayloadV4`, and V4 = ExecutionPayloadV3 + `withdrawals_root`, which is exactly Helios's `ExecutionPayload`. `signature_message` = keccak(0^32‖chainId‖keccak(parentBeaconRoot‖payload)), identical. **Only the topic string is wrong.** | base/base envelope.rs, payload/v4.rs |
| (new, not in the audit) execution spec | **Helios `eth_call` is NOT production-compatible with Base.** Helios opstack `get_spec_id_for_block_timestamp` tops out at `OpSpecId::ISTHMUS`, which op-revm 20.0.0 (sha256 `a5cfe618…` = lock) maps to **PRAGUE**. Base maps Azul/Beryl/Cobalt to **OSAKA** plus Base-only precompile sets (base/base `evm/src/spec.rs`, `precompiles/src/provider.rs`), live since Azul = 1779991200 (mainnet). Helios also uses OP's Isthmus time for Base (1744905600 vs Base 1746806401). Account, storage, code and receipt **proof verification is spec-independent** and stays valid. | op-revm 20 `spec.rs`, base/base |
| Hosted Base head | `base.operationsolarstorm.org` **and** `op-mainnet.operationsolarstorm.org` both returned **502** for `/latest` and `/chain_id` at 2026-10-23T00:38Z. Helios's stock Base default had no head at all. | `fixtures/live-20261023T003820Z/commitment.json` |
| Base P2P state or tx serving | Accepted from the audit (snap/2 off with no flag, GetNodeData empty, tx gossip disabled). Not re-derived. | rpc-peer-audit/RESULT.md |

**Consequences for the bridge (supersedes rev-2 §3 for consumers):**
* LeaseReader is **not** wired to Helios `eth_call`: no wrapper around a verifier that executes Base under the wrong
  spec. Patched Helios **refuses** local execution from Base Azul onward (explicit error).
* Patched Helios (branch `enclave-base-compat`, commit `0a02256` on `2af9b418`, SteveDeFacto) contains three changes:
  the v4 topic; an undecodable transaction refuses the block instead of panicking; and a Base fork schedule with
  `execution_unsupported_from_timestamp = Azul` (mainnet 1779991200, Sepolia 1776708000). Rust unit tests cover these.
  It is not a release and not deployed.
* What works through the verifier today (offline E2E, synthetic test-key heads): a signed-head follow plus
  **proof-verified** `eth_getStorageAt`, `eth_getProof`, `eth_getCode` and `eth_getBalance`, served from untrusted
  witnesses (gateway failover plus a block-hash-pinned cache).
* **Real fix for Enclave contract calls (next step, not done):** replace op-revm in Helios's opstack `evm.rs` with
  base/base `base-common-evm` (revm 42.0.1, alloy-evm 0.38, alloy-consensus 2.3). Helios pins revm 38 via op-revm 20
  and alloy 2.1, so this needs a Helios dependency bump or a fork to revm 42. Cobalt precompiles read state
  (`base-precompile-storage`); Helios's ProofDB must supply those proofs. Add 0x79 decode with base-common-consensus
  before Everest.
* **Fresh head without any hosted service:** patched `opstack-server` (v4 topic) listening on Base gossip. It is built
  but has **not been run against live peers** (no authorization for a P2P join in this session). Root-run probe recipe
  in RESULT.

---

# WITNESS-INITIAL (revision 2) — Helios verifier bridge for Enclave contract calls

rpc-priority worker, 2026-10-23 UTC. **Source and offline fixtures only. Nothing deployed, nothing activated.**
Revision 1 (custom MPT walk plus an address-book-only cache) is withdrawn per root and kept verbatim in
`WITNESS-INITIAL.v1-superseded.md`. It contained no code. Candidate repo: `rpc-priority/repo`, branch `rpc-priority`
off dfe020abf (still unedited when this was written).

## 1. Maintained verifier: Helios 0.12.0 (a16z), pinned

| Artifact | Pin | Source |
|---|---|---|
| git tag `0.12.0` | commit `2af9b41887e069144ee56cd710f3ddca195473f8` (2026-10-05) | `git ls-remote` tag = shallow clone in `vendor-inspect/helios-src-2af9b418` |
| `helios_linux_amd64.tar.gz` (CLI `helios`, 23,486,912 B) | sha256 `dd2746b11323f8f4a4e4613891b275148f34963bf4912cab79a34316a02a94b4` = GitHub release asset digest | `vendor-inspect/helios-release-0.12.0` |
| npm `@a16z/helios@0.12.0` (helios-ts wasm) | tgz sha256 `3ae698f52fc69e6c0ed35a8f71f97fbf935a237bcf5a690624f8e38295d3e627` = release asset digest | `vendor-inspect/helios-npm-0.12.0` |

What Helios opstack verifies (source-read, `opstack/src/consensus.rs`, `core/src/execution/providers/rpc.rs`):
* **Head:** it polls `<consensus_rpc>/latest` for a `SequencerCommitment` (snappy-decoded gossip message:
  65-byte signature plus `parentBeaconRoot‖SSZ ExecutionPayload`). It accepts the commitment iff it recovers to the pinned
  `unsafe_signer` over `keccak(0^32‖chainId‖keccak(data))` and the block number increases. The resulting
  `TrustedBlockRef::Full` carries `state_root` and `block_hash` taken from the signed payload.
* **State and calls:** `eth_getProof` and `eth_getCode` are fetched from ONE untrusted `execution_rpc`, **pinned by block
  hash**. Account and storage proofs are verified against the trusted `state_root`, and `eth_call` runs locally in
  op-revm. `eth_createAccessList` from the RPC is only a prefetch hint. It keeps the last 256 trusted blocks, plus EIP-2935
  historical-block verification.
* **Tx:** `eth_sendRawTransaction` is forwarded to `execution_rpc` as is. Inclusion is checked later through verified
  receipts and blocks.

## 2. What it does NOT give, and the exact blockers

1. **Trust class of the head:** the sequencer-signed **unsafe** head. Base's sequencer (one operator) can equivocate,
   reorg unsafe blocks or withhold. It is not L1-safe or finalized: the opstack consensus never emits a finalized
   block. Not "Ethereum-finalized execution verification".
2. **Signer authentication:** the Base `unsafe_signer` is a constant in Helios's config
   (`0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a`, SystemConfig `0x73a79Fab69143498Ed3712e519A88a918e1f4072`).
   `verify_unsafe_signer` (L1 light client plus SystemConfig storage proof) defaults false, and it fetches its proof from
   `<consensus_rpc>/unsafe_signer_proof/<l1hash>`, a route the self-run `opstack-server` does **not** implement (only
   `/latest` and `/chain_id`). A rotation on L1 would stop heads until the pin is updated: fail-closed, never wrong.
3. **Freshness:** Helios does not reject old heads; it only requires the number to increase. **The Enclave bridge must
   enforce the block-age bound itself** (LeaseReader's `maxBlockAgeMs` on the verified header).
4. **Head source:** default `consensus_rpc` for Base is hosted `https://base.operationsolarstorm.org`, which is
   forbidden as a mandatory dependency. helios-ts 0.12.0's `OpStackClient(executionRpc, verifiableApi, network)` has
   **no consensus override** (hardcoded per network), so helios-ts can't take an independent head. The **CLI**
   accepts `--consensus-rpc` and a `~/.helios/helios.toml` `[base]` override, so the bridge uses the pinned CLI binary.
5. **Self-run gossip head (`opstack-server`) has an upstream incompatibility:** Helios @2af9b418
   `opstack/src/server/net/block_handler.rs` subscribes only to `/optimism/{chain}/2/blocks` (the V3 topic) while decoding
   the V4 payload layout (with `withdrawals_root`). op-node `p2p/gossip.go` (optimism develop @5de51bfd)
   `publishRawSignedPayload` publishes Isthmus-era blocks **only on `/optimism/{chain}/3/blocks`** (V4). Unless Base
   sequencers still publish on V3 (UNVERIFIED; worker b8ffe356's peer audit owns probing), a stock opstack-server receives
   no Base heads. `opstack-server` is also not in the prebuilt release: it needs a focused Rust build plus a one-topic
   patch. Neither is done or claimed.
6. **Fresh witnesses when ALL public RPC providers refuse:** Helios needs *some* source of block-hash-pinned proofs
   for the current head. Candidates are public providers, an Enclave-run full node (persistent writable volume missing on
   metal; no-NVMe constraint), or snap/2 peers (Reth v2.6 serves; Base peer exposure unknown, b8ffe356). The Sia cache
   only re-serves proofs that were already fetched, pinned to their block hash. A hit proves availability for that block
   only, never latest or freshness.
7. **Tx broadcast under total provider outage:** none. Every execution source forwards to the single sequencer. The L1
   OptimismPortal deposit (forced inclusion) needs an L1 RPC plus L1 ETH. Not implemented; reported as remaining.

## 3. Architecture being implemented now (pluggable at both ends)

```
 head sources (untrusted HTTP, Helios consensus API: /latest,/chain_id)        witness transports (untrusted)
  - Enclave-hosted opstack-server replicas (once built/patched)                  - http execution RPC (providers, Enclave node)
  - operator-chosen extra sources; hosted solarstorm only if explicitly listed   - immutable cache: memory / dir / sia-s3 (SigV4)
  - [direct gossip: NOT available until §2.5 fixed]                              - [snap/2 peers: NOT available, declared unsupported]
            │                                                                              │
   op-head-relay.mjs (loopback): verifies signer (viem recoverAddress),        witness-gateway.mjs (loopback JSON-RPC):
   picks the highest valid commitment, refuses wrong chain, serves /latest      method allowlist, failover, block-hash-pinned
            │                                                                  getProof/getCode cache, broadcast fan-out
            └──────────────► pinned Helios CLI 0.12.0 (helios-verifier.mjs) ◄──────────────┘
                              verifies proofs + runs eth_call (op-revm)
                                         │ loopback verified JSON-RPC
                              LeaseReader authority 'verifier' (opt-in; quorum default unchanged):
                              head-confirmations block, header re-read, maxBlockAgeMs on the VERIFIED
                              timestamp, monotonic block, one deadline → the same readSnapshot/bookAddress/
                              registryEntries callbacks every Enclave consumer already uses
```

* The verifier is a **locally validating node**, a separate authority mode. It is never one vote in, or a substitute for,
  the k-of-n quorum, and never treated as an unverified server. Quorum mode stays the default during incremental work and
  is **not** claimed as independent operation.
* There is no admin or auth bypass. Enclave admin contracts and policy are read exactly as before; only the transport
  of the reads changes.
* **Bootstrap:** the relay, gateway and Helios all run locally from config. No chain discovery is needed to start. The
  Sia cache is optional, configured locally, and never on the lease/claim path, so there is no storage↔RPC cycle.

## 4. Tests (offline, `work/claude-test-queue.py`)

* Unit: relay signature, chain, freshness and highest-pick rules; gateway allowlist, failover, cache and tamper
  pass-through; a SigV4 published test vector; LeaseReader verifier-mode freshness, deadline and monotonicity.
* End-to-end **inside `unshare -r -n` (no external network at all = every external RPC provider down)**: Anvil (chain id
  8453) as the only execution source; a test head source signing Anvil blocks with a test key (Helios `[base.chain]
  unsafe_signer` override in a private HOME, test-only); the real pinned Helios binary. Real Enclave reads (the
  AddressBook `addr`, compiled from source) go through `LeaseReader` verifier mode. Negative controls: tampered proof,
  wrong signer, stale head, upstream death. Cache-only recovery after a Helios restart while the upstream is dead, at the
  same block. Fresh and uncached reads and tx sends must refuse.

**Next step after this file:** implement the four modules and tests in the candidate, then run the focused queue job.
