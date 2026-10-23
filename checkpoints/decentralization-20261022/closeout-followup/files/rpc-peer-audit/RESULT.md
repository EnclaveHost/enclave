# rpc-peer-audit — RESULT (2026-10-23T00:31Z; revised 00:50Z with §8–§9; revised 01:50Z with built listener and live run §10)

This is a read-only primary-source audit. I made no edits to `rpc-priority/repo`. I ran no builds, opened no peer
connections, did no scans and used no credentials. Sources were fetched read-only with `curl` from GitHub (API, raw and
codeload tarballs at immutable SHAs) and docs.base.org, into `/tmp/rpa-src` (RAM tmpfs, untrusted, not executed).
No secrets appear here. One note: the public `base/base` `.env.mainnet` contains a sample engine JWT. It is not ours,
and I have not reproduced it.

## 0. Bottom line

1. **The pinned default Base client serves no state witnesses over P2P: UNSUPPORTED by default.** In base/base
   v1.5.1 → base/reth `7134be3b`, snap/2 advertisement is off by default, and there is no CLI flag and no Base
   code path that turns it on. eth `GetNodeData` returns empty. The Base consensus-layer libp2p stack is gossip
   only, with no req/resp.
   *Scope:* this is a statement about the default build and configuration. It does **not** prove that every Base
   mainnet operator is unsupported: a custom build could enable snap/2. The live probe (§8) could not settle that
   question: every TCP connection attempt to the published bootnodes was refused, so it is inconclusive. With the default client, fresh account and storage proofs
   come only from JSON-RPC full nodes (`eth_getProof`, `debug_executionWitness`).
   Verifying witnesses locally removes the need to *trust* providers. It does **not** remove the dependency on a
   provider being *available*. Removing that dependency means running a Base full node (base-reth-node), which the user
   wants to avoid. A snap-enabled fork would still be a full node.
2. **Authenticated fresh Base root without a hosted service: now BUILT and live-verified (unsafe tier only; see §10).**
   Before §10 this was a missing consumer.
   The sequencer signs every unsafe block and publishes it on libp2p topic `/optimism/8453/3/blocks` (v4, since
   Isthmus). The only standalone listener I found is Helios `opstack-server`, and as a self-hosted source it
   **cannot receive current Base mainnet blocks**: it subscribes only to the v3 topic `/optimism/{chain}/2/blocks`.
   There is also a second, latent problem in the Helios client:
   * The client calls `OpTxEnvelope::decode(..).unwrap()`, using op-alloy-consensus **2.0.0**. That version is
     pinned in Helios's Cargo.lock, and I checked the crate's sha256 against it (`6ca73133…`).
   * The envelope accepts types 0, 1, 2, 4, **0x7D (PostExec)** and 0x7E (Deposit). Root's `PostExec` finding is
     correct, but PostExec is 0x7D, not Base's EIP-8130 type **0x79** (base/base `eip8130/constants.rs:27`). So a
     0x79 tx would fail decode and panic.
   * 0x79 did **not** occur in the 5 latest mainnet blocks I sampled (§8.2), so this is a source-level
     incompatibility, not an observed failure.
   What this tier proves is "the sequencer key signed this", nothing more.
3. **Settled Base root: the standard route is verified, but its components are not integrated.** The L1
   `AnchorStateRegistry` (Base mainnet proxy `0x909f6cf47ed12f010A796527f562bFc26C7F4E72`) exposes
   `getAnchorRoot()`, `isGameFinalized()` and `respectedGameType()`. This needs an authenticated finalized L1 header
   plus an L1 storage proof. The L1 header can come over P2P from `nimbus_light_client` (libp2p, a trusted-checkpoint
   input). For the L1 state proof I found no maintained standalone P2P tool. The settled root lags by days, so it is
   good for checkpoints, not live reads.
4. **Submission: Base P2P transaction gossip is UNSUPPORTED by the pinned default client.** base-reth-node
   hard-codes `tx_gossip_disabled = true` and drops inbound transactions. A custom build could differ; that is
   unverified. The only standard paths are the sequencer HTTP endpoint and an L1
   `OptimismPortal` deposit (forced inclusion). Neither broadcast proves inclusion. Inclusion needs a receipt in an
   authenticated block.

## 1. Immutable pins read

| Component | Version | Commit |
|---|---|---|
| base/base | v1.5.1 (2026-10-22T17:47Z) | `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42` (main is now `10abcfdd…`) |
| base/reth (pinned by base v1.5.1 Cargo.lock) | tag `base-v2.5.2.8` | `7134be3b51cf9d9504f988bff3266a23085f0bd9` |
| paradigmxyz/reth upstream | v2.8.0 (2026-10-20) | `05ba48120a0ce8d6beb65f0b2a7ad4710f4f2915`; v2.6.0 tag obj `ddf77688…`; PR 26339 merged `0ac3d410…` |
| go-ethereum | v1.17.9 (2026-10-21) | `9dffe6e976cbbb87a84c5fd395448f0950290def` |
| go-ethereum (local Go module cache) | v1.13.5 | `~/go/pkg/mod/github.com/ethereum/go-ethereum@v1.13.5` (cloudflare/aws deps for `cmd/devp2p` are **absent**, so it can't build offline) |
| a16z/helios | master = release 0.12.0 | `2af9b41887e069144ee56cd710f3ddca195473f8` |
| status-im/nimbus-eth2 | v26.10.1 | `963756c91c19b7824cea57e7aab5857ce2c776c7` |
| sigp/lighthouse | v8.3.1 | `0aba4605a9a18964a165d6c0d258ae8d1621ee40` |
| ethereum/devp2p | master | `2c19a28b25c29487773ad6b07243e290fa8d65ec` (`caps/snap.md` sha256 `181eed95…`) |
| ethereum/portal-network-specs | master | `d1d1dfd45a36a47bf1b2a4e8324df05ed44a220f` |
| ethereum-optimism/superchain-registry | main | `009155d5f96df7fe564fd37e2751d9dd0480e0ed` (**Base is not listed** under `superchain/configs/mainnet`) |
| docs.base.org base-contracts page | fetched 2026-10-23T00:30Z | page sha256 `a196c415…` (a mutable page, so this is evidence only) |

Locally installed libraries: go-ethereum v1.13.5 (Go module cache only). There is no alloy-trie or reth in the cargo
registry and no geth/reth/helios/nimbus binaries. The rpc-priority worker has vendored Helios 0.12.0 under
`rpc-priority/vendor-inspect/`.

## 2. snap on Base: what base/base actually pins

All paths below are under base/reth `7134be3b`.

* `crates/net/eth-wire-types/src/snap.rs`: there is only `SnapVersion::V2` (EIP-8189). **No snap/1 implementation.**
* `crates/net/network/src/eth_requests.rs` `on_snap_request`: real serving of GetAccountRange, GetStorageRanges
  (boundary proofs), GetByteCodes and GetBlockAccessLists.
* `crates/storage/provider/src/providers/blockchain_provider.rs:57`: `SNAPSHOT_STATE_RETENTION = 128` blocks. That is
  256 s at 2 s blocks and **25.6 s after Denim's 200 ms blocks**.
* `crates/net/network/src/config.rs:283,564`: `snap_enabled: false`, "Default off". `with_snap(true)` appears only in
  tests and `test_utils/testnet.rs`. `crates/node/core/src/args/network.rs` has **no snap flag**.
* base/base `5476069f`: there are **zero** calls to `with_snap` or snap protocols across all crates. The upstream
  `--snap.v2` flag is from reth v2.8.0 ("opt-in", advertised in ENRs only when enabled), which base-v2.5.2.8
  does not carry.
* `docs/guides/P2P.md:594` in base/base says "Reth also supports the `snap/1` protocol". **This is stale and
  contradicted by the pinned code.**
* `eth_requests.rs:231-236`: `GetNodeData` (removed state serving) returns an empty payload.
* geth (L1 context only): snap/1 is served when `SnapshotCache>0` (default 409). snap/2 is behind `SnapV2`
  (`eth/backend.go:463`, `eth/protocols/snap/handler.go MakeProtocols`). That matters for **Ethereum L1** peers, not
  Base.
* Can other clients follow Base mainnet? Base runs Base-only forks: Azul 2026-05-28, Beryl 2026-06-25,
  **Cobalt 2026-09-30 (live)** and **Denim 2026-11-05T18:00Z (scheduled; 200 ms blocks)**
  (`crates/common/chains/src/config.rs:455-479`). Its EIP-8130 tx type `0x79` is not decoded by op-geth
  (`etc/docker/README.md:116-119`). So a snap/1-advertising op-geth peer that still claims Base is unlikely to be on
  the canonical chain. Whether any third-party client follows Base after Cobalt is UNKNOWN.

**Verdict (pinned default client only):** snap/1 is not implemented in base-reth-node. snap/2 is off by default
with no flag. This does not establish what every custom operator runs.
Whether some operator runs a custom snap-enabled build on Base mainnet is UNKNOWN, and only a live probe (§6 P1) can
show it. Even then, the 128-block retention, satellite-of-eth design and full-node-bootstrap intent make it unsuitable
as an indefinite light-client witness service (devp2p `caps/snap.md` lines 29-39, 124, 219).

## 3. Authenticated Base root: four separate things

| Tier | What authenticates it | Existing source or library | Status |
|---|---|---|---|
| **Unsafe head** (seconds) | Sequencer ECDSA over the payload hash. Signer `0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a` (`config.rs:500`), updatable via L1 SystemConfig `0x73a79Fab69143498Ed3712e519A88a918e1f4072`. | libp2p gossipsub topic `/optimism/8453/3/blocks` (`crates/consensus/gossip/src/handler.rs:164,172-176`). Validation in `block_validity.rs`. The CL behaviour is gossipsub+identify+ping only; legacy `payload_by_number` req/resp is **not advertised** (`service/tests/actors/network/p2p.rs:26`). No backfill over P2P. | Protocol AVAILABLE. Light listener **MISSING**: Helios opstack-server listens on v3 `/2/blocks` only (`opstack/src/server/net/block_handler.rs:20-25`), so it is broken for Base after Isthmus. Helios client `payload_to_block` calls `OpTxEnvelope::decode(..).unwrap()` (`opstack/src/consensus.rs:284+`) on op-alloy-consensus 2.0.0, whose envelope types are 0/1/2/4/0x7D/0x7E. A 0x79 tx would panic it; this is latent, since none appeared in the §8.2 sample. Helios Base default `consensus_rpc` is hosted `base.operationsolarstorm.org`, with `verify_unsafe_signer: false` (`opstack/src/config.rs:103-112`). |
| **Proposed output** (TEE-signed, not final) | `AggregateVerifier` game created via `DisputeGameFactory.createWithInitData` (`crates/proof/proposer/README.md`). TEE proof from a Nitro enclave; ZK challenger `nullify()`/`challenge()`. | Base mainnet L1 (docs.base.org): DGF `0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e`, AggregateVerifier `0xeF9eCeA15265321753047EBF7D54C858D53cB94f`, TEEVerifier `0x1FbA0C57b07Af804A9717e51dec9CC27FBC12228`, TEEProverRegistry `0x1af2A7E537DE2eE795DE5B8BfbB1Ad0DD513A5aA`. | AVAILABLE as an L1 read. A proposed game **is not finality**. |
| **Finalized / settled output** | `AnchorStateRegistry` (ABI `crates/proof/contracts/src/anchor_state_registry.rs`): `getAnchorRoot()→(root,l2SequenceNumber)`, `isGameFinalized`, `isGameBlacklisted`, `isGameRetired`, `respectedGameType`, `paused`. | ASR proxy `0x909f6cf47ed12f010A796527f562bFc26C7F4E72` (the docs page). The base/base test fixture `0xdb9091e4…` is stale, so don't use it. | AVAILABLE as an L1 read. Delay values: UNKNOWN (they are in the Solidity, which I didn't read). Read `isGameFinalized`/`getAnchorRoot` instead of computing windows. Intervals change at Denim (`proposal_intervals.rs:1-7`). |
| **Execution / state proof against a root** | OutputRootV0 = keccak(32-byte version 0 ‖ stateRoot ‖ L2ToL1MessagePasser storage root ‖ blockHash) (`crates/consensus/protocol/src/output_root.rs`). Base derives the middle term from an **account proof** of the message passer (`challenge/src/validator.rs:232-234`). | Account and storage MPT proofs: JSON-RPC `eth_getProof` only (see §2). | Verification AVAILABLE (maintained verifiers: geth `trie.VerifyProof`, alloy-trie). **Retrieval without a JSON-RPC node: UNSUPPORTED.** |

**L1 header input.** The settled tier needs an authenticated finalized L1 header.
* `nimbus_light_client` (nimbus-eth2 `963756c9`) syncs over libp2p only from `--trusted-block-root`
  (`beacon_chain/conf_light_client.nim:128-130`).
* The standalone binary uses `LightClientFinalizationMode.Optimistic` (`nimbus_light_client.nim:110`). Its own
  docstring says it "may end up on incorrect forks if run in a hostile network environment"
  (`gossip_processing/light_client_processor.nim:64-72`). `Strict` is the security-preferring mode, but it is not
  what the binary ships with.
* Serving defaults: Nimbus BN `--light-client-data-serve` defaults true (`conf.nim:545-548`). Lighthouse v8.3.1 serves
  unless `--disable-light-client-server` is set (`book/src/help_bn.md:488`).
* The standalone LC exposes its output through engine-API calls to an EL (`--el`) and its DB. There is no read API
  for Enclave.
* The `--trusted-block-root` checkpoint is a trust input. It could be admin-pinned, which is compatible with the
  preserved-admin requirement.
* The L1 state proof for the ASR slot comes from L1 `eth_getProof` (any single provider, verified locally) or from
  L1 snap/1 at roots within 128 blocks of a geth peer's head. I verified no maintained standalone P2P client for
  that: geth `devp2p rlpx snap-test` is a conformance suite that needs the target's chain.rlp and genesis.

**Portal:** the specs cover Ethereum L1 only. The state network now sits under `legacy/state/`. There is **no Base
evidence**, and I'm not claiming any.

## 4. Submission and inclusion

| Path | Status | Evidence |
|---|---|---|
| Base devp2p tx gossip (Transactions / NewPooledTransactionHashes) | **UNSUPPORTED in the pinned default client**: base-reth-node peers drop inbound and never propagate (custom operators unverified) | base/base `crates/execution/node/src/node.rs:1366` `network_config.tx_gossip_disabled = true` (unconditional). base/reth `transactions/mod.rs:622,891,1046,1171,1268,1385` (early returns). |
| Sequencer HTTP `eth_sendRawTransaction` | AVAILABLE, but hosted by Base (it is the sole orderer). Default `https://mainnet-sequencer.base.org`. | `.env.mainnet:6`, `crates/execution/cli/src/lib.rs:187`. |
| L1 `OptimismPortal.depositTransaction` (forced inclusion) | AVAILABLE standard path. Portal `0x49048044D57e1C92A77f79988d21Fa8fAF74E97e`. Derivation bound `seq_window_size 3600` L1 blocks (about 12 h). Needs L1 ETH and an L1 tx broadcast. L1 devp2p tx gossip is standard, but broadcast ≠ inclusion. | `config.rs:460,496`. |
| Inclusion proof | A receipt in an authenticated L2 block, checked against `receiptsRoot`. Headers and receipts are served over Base devp2p eth (`on_headers_request`, `on_receipts69/70_request`), but a client needs a Base-correct eth Status/fork-id. That library is reth-network + base chainspec (heavy Rust build). Whether peers keep serving a non-serving light peer is UNKNOWN. | `eth_requests.rs:192-290`. EthVersion 66-72. |

## 5. Sia role (consistent with rpc-priority WITNESS-INITIAL §6-7)

Store only immutable, self-authenticating objects under deterministic keys, with no listing or index required:
* sequencer-signed v4 envelopes (verifiable against the signer),
* L1 light-client updates (verifiable from the checkpoint),
* `eth_getProof` results keyed by `(chainId, blockHash, address, slots)`, verifiable against an authenticated root.

A cache hit proves availability at that pinned block only. It never proves freshness, canonicality or non-reorg. An
unsafe-tier object can be reorged, so it must carry its tier. At Denim's 5 blocks/s, per-block Sia writes (about 45 s
per PUT according to the worker) cannot be on any hot path. Write only the anchors and proofs that are actually
consumed.

## 6. Next probe recipes (root-run only; none of these has been run)

**P1: Hello capability probe (RAN 2026-10-23T00:38Z, as a minimal program rather than `cmd/devp2p`; results in §8.1).** Library: go-ethereum
v1.17.9 `9dffe6e9` `cmd/devp2p`. The local v1.13.5 can't build offline.
1. Fetch the source at the commit and `go build ./cmd/devp2p` through `work/claude-test-queue.py` at 1024 MiB with
   `GOMAXPROCS=2 go build -p 1`, wall clock ≤ 15 min. Peak memory is UNKNOWN, so treat an OOM as "not run".
2. For each of the 10 published entries in base/base `config.rs:507-516` (5 hosts × ports 30301/9200), run
   `timeout 10s devp2p rlpx ping <enode>` serially. That is ≤ 100 s and only Base-published endpoints: no discovery
   crawl, no scan.
3. Record `Name` and `Caps` from the Hello.
   * Pass/fail meaning: `snap/2` in Caps means "advertised". It does **not** mean "on chain 8453" (Hello has no
     Status/fork-id) or "serves proofs".
   * A refused or timed-out connection is inconclusive, because these may be discovery-only bootnodes.
   * Going beyond the bootnodes needs discv5 discovery (`devp2p discv5 crawl`, which is a DHT walk). That needs
     explicit root authorization. I have not verified that it accepts these enode-format bootnodes.

**P2: proof retrieval from Base peers. None verified.** No maintained tool sends snap GetAccountRange to a Base peer
with a Base-correct Status. A positive P1 would justify scoping one on reth-network with the base chainspec.

**P3: settled-anchor read (the useful next step).**
* Steps: `nimbus_light_client` `963756c9` with an admin-pinned `--trusted-block-root`, giving the finalized L1 header.
  Then L1 `eth_getProof(ASR 0x909f…4E72, slots)` from ≥1 L1 endpoint, verified locally with a maintained MPT verifier.
  Then `getAnchorRoot`.
* Missing pieces:
  * Nimbus LC exposes no read API. Its output comes through engine-API calls to an EL (`--el`) and its DB, so glue
    is needed to extract the header.
  * The ASR storage slot layout must come from the deployed source, which I haven't read.
  * The L1 proof still uses an L1 JSON-RPC provider, any one of them.
* Bounds: Nimbus LC RAM/disk are UNKNOWN. Whether the release tarball (`nimbus-eth2_Linux_amd64_26.10.1_963756c9.tar.gz`,
  62 MB) contains `nimbus_light_client` is UNKNOWN.

**P4: unsafe-head listener. DONE (§10); the original proposal is in §9.** Glue around the maintained `base-consensus-gossip`
crate (base/base `5476069f`, MIT) that subscribes to v4, applies the existing `block_validity.rs` checks, and emits
`(number, hash, parentHash, stateRoot, timestamp)` signed-envelope objects. Build cost of a Rust libp2p/alloy crate
under a 1024 MiB cap: UNKNOWN. Root should decide before anyone builds it. Fixing Helios upstream (adding the v4 topic
and 8130 decoding) is the alternative, but it is not ours to do.

## 7. Summary table

| Item | Status |
|---|---|
| snap/1 on Base | Not implemented in pinned base-reth-node; custom operators UNKNOWN |
| snap/2 on Base | UNSUPPORTED by default, no flag; custom operators UNKNOWN (P1 ran: observed TCP refusal, so inconclusive) |
| eth GetNodeData state | Empty reply in pinned base-reth-node; custom operators UNKNOWN |
| CL req/resp backfill | Not advertised by pinned base-consensus; custom operators UNKNOWN |
| CL unsafe gossip v4 + signer check | AVAILABLE and **live-verified** with enclave-base-head-listener (§10: 52 heads in 120 s, RPC-corroborated); Helios server v3-only (blocker), client 0x79 decode panic latent |
| L1 ASR / AggregateVerifier / DGF reads | AVAILABLE (addresses above); finality-delay values UNKNOWN |
| L1 header via libp2p light client | AVAILABLE (nimbus_light_client; Optimistic-mode caveat; checkpoint input) |
| L1 state proof without RPC | protocol AVAILABLE (geth snap/1); maintained standalone client NOT VERIFIED |
| Base state proof without JSON-RPC | No interface in the pinned default clients; no custom serving operator observed (UNKNOWN, not disproven) |
| Base devp2p tx submission | Dropped by pinned base-reth-node; custom operators UNKNOWN |
| Sequencer HTTP / L1 forced deposit | AVAILABLE (hosted sequencer / L1 path ≤ about 12 h) |
| Ethereum Portal for Base | NO EVIDENCE |
| Denim 2026-11-05 (200 ms, new proposal intervals) | Must be handled by any consumer; affects retention and windows |

## 8. Live verification (bounded, root-authorized 2026-10-23)

All artifacts are in `rpc-peer-audit/probe/`. They contain no secrets: the probe uses one ephemeral key per target,
held in memory and never written to disk.

### 8.1 RLPx Hello probe

**Source.** `probe/main.go` (sha256 `63e2ce61…`), roughly 190 lines.
* It imports only go-ethereum **v1.17.9** packages: `p2p/rlpx` (ECIES handshake and framing), `p2p/enode`, `crypto`
  and `rlp`. There is no custom crypto, and it does not use `cmd/devp2p`.
* The targets are a compiled-in allowlist of the 10 entries from base/base `config.rs:507-516`. They were extracted
  by script into `probe/targets.txt`, and the excerpt is `bootnodes-source-excerpt.txt` (sha256 `747995a1…`). I
  checked that the embedded list equals the source list.

**Bounds.**
* Targets are probed serially, at most 10.
* Each target has one `context.WithDeadline` covering the dial plus `SetDeadline` on the socket covering the
  handshake and read: 10 s each. The outer bound is `timeout -k 5 130`.
* Received bytes are capped at 64 KiB + 1 MiB plus framing by a limiting `net.Conn`, and the decoded Hello must be
  ≤ 1 MiB. Caveat: geth's rlpx frame buffer can transiently allocate up to the 24-bit frame maximum (16 MiB) before
  that read fails.
* The probe sends nothing after the handshake: no Hello, no eth Status, no snap request. No listening, no discovery
  and no DHT.
* It records only p2p version, capabilities, whether the Hello ID matches the dial key, the outcome and the elapsed
  time. It does not record the client name.

**Build.** `probe/build.sh` ran through `claude-test-queue.py --mib 1024`.
* Settings: `GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2 go build -p 1 -trimpath`, with go1.27.2.
* Modules came from proxy.golang.org, verified through the go.sum database: go-ethereum v1.17.9
  `h1:p05tsTJyvqI1WKBZlBl9+wYQG1eo/qVwmz66owsp+yA=`, decred secp256k1 v4.0.1, snappy, uint256 v1.3.2, goleveldb,
  x/sys v0.47.0. Every fetch succeeded.
* It finished at 00:37:29→00:38:06Z with **peak 148 MiB**, exit 0.
* Hashes: binary `a1f00f9d0e2ae479bd92d0722347f4f1047cbe0beeb84232f9cebc282482c2ba`, go.mod `4d00a395…`, go.sum
  `a4057a34…`. Log: `probe/build.out`.

**Run.** `probe/run.sh` ran through the queue's 256 MiB lane at 2026-10-23T00:38:21Z: peak 17 MiB, exit 0.
Output: `probe/hello.jsonl`.

| # | Endpoint | Outcome |
|---|---|---|
| 0-9 | all 10 (5 hosts × TCP 30301/9200) | `dial_error: connect: connection refused`, about 61 ms each |

**Interpretation (corrected).**
* What was observed: a TCP connection refusal (ECONNREFUSED) after about 61 ms for every target. That shows only
  that *something on the path* rejected the SYN, so this records "observed TCP refusal".
* It does **not** show what state the named hosts are in. A middlebox or firewall could have sent the reset. I make
  no claim about what the hosts listen on.
* No Hello was obtained, so no capability was observed. **Result: INCONCLUSIVE.** It neither confirms nor refutes
  snap on any Base peer, and default-unsupported does not prove that every operator is unsupported.

### 8.2 Base block tx-type fixture (read-only, bounded)

`probe/block-types.py`, against `https://mainnet.base.org`.
* Bounds: at most 5 blocks, 20 s per call, 32 MiB response cap. The script checks `chainId == 8453` first.
* Output: `probe/block-types-fixture.json`, generated 2026-10-23T00:36:52Z.

**Result.** Blocks 52963228-52963232 are 2 s apart and hold 1176 txs. The types seen were only `0x0`, `0x2`,
`0x4` and `0x7e`. There were **no 0x79 and no 0x7D**. 0x79 therefore wasn't present in this small window; its
frequency on mainnet is UNKNOWN. This is one provider and 5 blocks, a compatibility fixture only.

## 9. Fresh unsafe-head listener: source proposal (not built)

The maintained library is `base-consensus-gossip` from base/base `5476069f`, MIT, `crates/consensus/gossip`.

**Construction (existing APIs).**
* `GossipDriverBuilder::new(rollup_config, signer, gossip_addr, keypair)` (`builder.rs:52-57`), then `.build()`,
  which returns `(GossipDriver, watch::Sender<Address>)` (`builder.rs:151-158`).
* `driver.start()` calls `swarm.listen_on(addr)` (`driver.rs:166`). The listener must therefore bind a TCP port;
  binding to loopback is possible but rules out inbound peers.
* `driver.dial(enr)` validates the ENR chain id (`driver.rs:301-313`). It can dial the 5 published CL bootnode
  ENRs directly, with no DHT walk, though without discv5 the peer count stays small.
* `driver.next()` and `handle_event()` return a validated `NetworkPayloadEnvelope` (`driver.rs:198,502`).

**Validation inherited from `block_valid`** (`block_validity.rs:116-260`):
* timestamp within +5 s and −60 s (`handler.rs:119`);
* ECDSA signer equal to the configured signer, checked before the hash;
* block hash recomputed from the payload, with Isthmus `requests_hash`;
* version-specific fields;
* Base time-schedule txs;
* at most 5 blocks per height.

**Output.** Emit `(number, hash, parentHash, stateRoot, timestamp, signer)` plus the raw signed envelope as an
immutable object (§5). This becomes the authenticated `stateRoot` against which locally verified `eth_getProof`
results can be checked.

**What it does not give.**
* No backfill and no history: it only sees blocks while connected.
* No finality, and reorgs of unsafe blocks are possible.
* No state: it still needs a JSON-RPC proof source.

**Trust inputs.**
* The signer address. It defaults to `config.rs:500`; rotation is via L1 SystemConfig and needs an authenticated
  L1 read, i.e. the P3 path.
* The `RollupConfig` / Base fork schedule, including Denim on 2026-11-05.

**Participation.** As a gossipsub mesh member it forwards valid blocks. That is normal participation, but it is
not passive.

**Build feasibility: not started, and no Rust build is running.**
* Base pins toolchain **1.96.0** (`rust-toolchain.toml`). It is not installed (the local toolchains are 1.88.0,
  stable, and nightlies up to 1.99), so rustup would have to fetch it.
* Dependency set: libp2p (tcp/dns/noise/yamux/gossipsub/identify), discv5, alloy, k256, and the base-protocol and
  base-common crates.
* A cold single-job build is probably **longer than 15 min**. Peak memory is UNKNOWN; my estimate is that it fits
  1536 with `CARGO_BUILD_JOBS=1`, but that is unverified.
* It needs root to approve one queued 1536 job, plus a live run of at most 60 s with direct dials to the 5 CL
  bootnode ENRs only, no discv5 walk. Its pass criterion: at least one envelope that passes `block_valid` and whose
  hash matches a public RPC `eth_getBlockByNumber` at the same number.
* Helios needs an upstream fix (subscribe to v4, add 0x79 decoding). That is the alternative, and it isn't ours to
  do.

## 10. Built unsafe-head listener and live runs (2026-10-23, root-authorized)

### 10.1 Source and provenance

* **Repo:** `rpc-peer-audit/head-listener/`, a local git repository with SteveDeFacto identity and no remote.
  Commits: `975a77c` → `54b0866` → `59433a4` → `e388d17` → `f3159ea`. It contains no binaries and no secrets;
  `target/`, `upstream/` and `runs/` are gitignored.
* **Upstream:** base/base `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42`, codeload tarball sha256 `9784e20a…8012`
  (byte-stable across 2 downloads). `tools/prepare-upstream.py` vendors 9 crates with **unmodified** manifests:
  gossip, peers, disc, protocol, chains, genesis, consensus, rpc-types-engine, metrics.
* **Lock:** vendored crates are non-member path dependencies, so optional `reth-*` dependencies (and the
  `base/reth` git source) are not resolved. All 625 entries in `Cargo.lock` (sha256 `267fcb51…`) are identical
  to base/base's own lock, except this crate. There is no `--locked` claim.
* **Toolchain:** rust 1.96.0, installed by root authorization.
  * Unrequested side effect: `rustup` self-updated from 1.29.0 to 1.29.2.
  * A first resolution attempt (members layout) began cloning `base/reth`. I stopped it (rc 143, peak 226 MiB),
    and it left a partial 130 MB cache at `~/.cargo/git/db/reth-babcd6134566c621`.
* **What the code adds:** a CLI and library (`INTEGRATION.md`, output contract `enclave-base-unsafe-head/v1`).
  * Accepted heads come only from the maintained driver's `handle_event` → `BlockHandler::block_valid`.
  * There is no custom signature or hash code. The offline `verify-object` calls the same maintained functions
    and omits only the wall-clock window and seen-cache.
  * Signer: an administrator pin, required. Fork schedule: static `ChainConfig::mainnet()`.
* **Tests:** 14 pass (12 integration + 2 CLI), run through queue jobs at 1536 MiB (build peaks 722, 708 and
  295 MiB). They cover:
  * accept with round trip, wrong signer, wrong chain domain, stale (−120 s) and future (+30 s) at receipt,
    tampered payload, truncated object;
  * store write-once and budget; dial queue de-duplication, caps and expiry; dial-error classification; CLI
    loopback and bounds checks;
  * **real mainnet fixture** block 52965074 (39454-byte object, as hex text): it verifies against the pin; a
    wrong signer, the Sepolia domain and tampering are refused; and the maintained `block_valid` now rejects
    it as stale.

### 10.2 Live run 1 — FAIL (60 s)

Run `live-20261023T012648Z`, binary `83196199…`:
* Exit 3: accepted 0 and 0 objects.
* `peersMax` 2, discovery started at 15 s, 274 ENRs forwarded, dial counter 200.
* The 274 and 200 counted **duplicates**: the discovery driver forwards the same ENR repeatedly, and the gater
  allows one dial per peer per hour.
* Dials were unpaced against the driver's 16-pending-outbound limit, and pending-dial and gater pruning were
  missing. Base's own service runs both pruners; my loop did not.
* That run had no stage diagnostics, so whether useful peers were reached is **unknown**.

### 10.3 Source diagnosis before run 2

* **ENR filtering:** the maintained `Discv5Driver` forwards only ENRs whose `opstack` entry decodes as chain
  8453, version 0. That applies to all of `Discovered`, `SessionEstablished`, `UnverifiableEnr` and periodic
  `find_node` (`disc/src/driver.rs:309-372`). Base execution-layer ENRs use `opel`, so they are excluded.
  Unrelated Ethereum discovery peers are not dialed.
* **Fixes:**
  * `DialQueue`: de-duplicate by PeerId, bootnodes first, at most 8 in flight, total cap 200, peer cap 20,
    35 s in-flight expiry.
  * The maintained `clear_expired_pending_connections` (every 5 s) and gater `prune` (every 60 s).
  * Staged counts: transport established → identify → meshsub-capable → subscribed to v4 → v4 messages →
    accepted.
* **Validation:** signer, hash, fork and freshness checks are unchanged.

### 10.4 Live run 2 — PASS (120 s)

Run `live-20261023T013719Z`, binary `8ef3d51d…`. Bounds: max 20 peers, 200 dials, 64 MiB output, loopback
listener, empty isolated `HOME` (still empty afterwards). Exit 0, peak 42 MiB.

* **Heads:**
  * **52 heads**, blocks 52965055–52965106: contiguous, no gaps, no duplicates. All v4, all signed by the pinned
    `0xAf6E…9e8a`, all `tier=unsafe`, `finality=none`.
  * Receive latency after block timestamp: 205 / 319 / 763 ms (min / median / max). Blocks are still 2 s apart
    (pre-Denim).
  * 52 objects, 2,895,576 bytes; output 2,938,036 bytes.
* **Validation funnel:**
  * **52 v4 messages received = 52 accepted**: no rejected or invalid blocks.
  * No `Received invalid block` warnings appeared in stderr (1,859 bytes in total).
* **Peer funnel:**
  * Discovery: 806 ENRs received, 266 unique, 545 duplicates; 200 dials made (cap hit around 100 s), 66 never
    dialed.
  * Transport: 160 outbound connections established, 158 closed.
  * Useful peers: only **2 identified** (agent product "base"); 2 meshsub-capable; **2 subscribed to v4**;
    **v4 mesh at most 1** peer at any time.
  * Dial errors: timeout 21, wrong-peer-id 8, handshake 5, reset 4, refused 1, unreachable 1.
* **Bootnodes:** all 5 published consensus bootnodes failed, with transport reset ×2 and handshake ×3. No
  bootnode reached the established state. This was observed from this site only; the cause is unknown and I make
  no claim about their configuration.
* **Offline re-check:** 52/52 objects pass `verify-object` with the pinned signer, and a wrong signer is refused
  (exit 1).
* **RPC corroboration:** 10/10 hash and `stateRoot` matches against `mainnet.base.org`. This is corroboration
  only, not the source of authenticity.

**Limits and uncertainty**
* **Single-peer dependency:** heads arrived through a mesh of size ≤ 1. One run, one site, one network vantage.
  Availability over longer windows is UNMEASURED.
* **Bootnode connectivity:** whether the published bootnodes ever accept this client is UNKNOWN.
* **Discovery wait:** discovery needed about 10 s before the first useful peer (first heads appeared by
  about 20 s).
* **No history:** gossip only (no backfill); offline the listener sees nothing. Reorgs of unsafe blocks are
  possible.
* **Not covered:** finality and state availability.
* **Discovery socket:** bounded discovery bound UDP on `0.0.0.0:<ephemeral>` for the remaining ~110 s. The gossip
  TCP listener stayed on loopback.
* **Denim (2026-11-05):** 200 ms blocks mean about 10× the message rate (about 1.3 MB/s at the observed ~65 KB
  per block, an estimate). The 64 MiB output cap would last about 50 s, so sizing must be revisited. The real
  fixture test stays valid; a synthetic test using block number 50,000,000 stays pre-Denim.

**Evidence:** `rpc-peer-audit/evidence/`
* `live-*/heads.jsonl`, `stderr.log`, `crosscheck.json`, `objects.sha256`, `post-check.out`;
* build, resolve and guard logs;
* `upstream-PROVENANCE.json`.

Object binaries stay in the gitignored `head-listener/runs/`.

**Consumer:** worker A (329522d2) can consume `INTEGRATION.md`'s contract. I did not edit its repository or send
it anything.
