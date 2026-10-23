# rpc-priority — RESULT (2026-10-23 ~01:20Z)

> **Superseded in part by `RESULT-BASE-EVM.md` (2026-10-23 ~02:20Z).** Since this was written:
> * Base execution now runs the maintained base/base v1.5.1 EVM inside Helios (branch `enclave-base-evm`). Real
>   Cobalt-era mainnet calls replay byte-exact; Denim stays refused.
> * Helios core **does** refuse stale heads for `latest` (`check_head_age`, >60 s). §4's "Helios itself never rejects
>   old heads" is wrong for client requests (its consensus intake accepts them).
> * Availability: snap is default-disabled on pinned Base releases; the peer probe is inconclusive about custom peers.

**Status: SOURCE + OFFLINE FIXTURES ONLY. Nothing deployed, activated or run against live peers. No production action,
no SSH, no transaction, no chain sync, no node-hosting allocation.** Analysis and rationale: `WITNESS-INITIAL.md`
(rev 3 table at the top). Peer/protocol facts: `../rpc-peer-audit/RESULT.md`, independently re-verified where it
mattered (below).

## 1. Bottom line

* The maintained verifier **Helios 0.12.0 is NOT production-compatible with Base mainnet as shipped.** Independently
  verified:
  1. Its self-run gossip head server (`opstack-server`) subscribes to the wrong topic (`/2/blocks`). Base publishes
     only `/3/blocks`. The payload and signature formats do match.
  2. It **executes `eth_call` under Prague rules**, while Base has run Osaka plus Base-only precompiles since Azul
     (2026-05-28).
  3. It **aborts** on any transaction type outside op-alloy-consensus 2.0.0. Base's 0x79 is gated behind Everest
     (mainnet: not scheduled), so this is latent today.
  4. Its default hosted head (`base.operationsolarstorm.org`) returned 502, as did the OP sibling.
* **Built and tested now:** a patched Helios plus an Enclave bridge, giving **proof-verified state reads**
  (storage, proof, code, balance) against a **sequencer-signed head** from **untrusted** witness sources. It survives a
  total outage of execution sources for a pinned block via an immutable witness cache. It **refuses**, rather than
  wrongly computing, `eth_call` on Base, and refuses heads it cannot decode.
* **Not achieved (exact blockers):**
  * Base `eth_call` verification needs Base's EVM inside Helios. That is a dependency-unification project (§5.1).
  * A fresh head without a hosted service needs the patched `opstack-server` to receive live Base gossip. It is built
    but not run live (§5.2; root-run probe ready).
  * Fresh witnesses when every public RPC refuses: Base P2P serves no state (audit), so this needs a Base full node.
    Read verification removes *trust* in providers, not *availability* dependence on them.
  * Tx broadcast under total provider outage: impossible on Base P2P (gossip disabled). The only paths are the
    sequencer HTTP endpoint and an L1 deposit.

## 2. Exact source inventory (all source-only)

| Item | Location | Commit / hash |
|---|---|---|
| Enclave candidate (branch `rpc-priority` off native-front-abort `dfe020abf`) | `rpc-priority/repo` | `97785a40c` (relay, gateway, tests) + `36a83c89b` (test assertion fix); 6 files, +782 |
| `network/op-head-relay.mjs` | Helios-consensus-API head relay: pinned signer and chain (viem `recoverAddress`), highest fresh block, stale ⇒ `null`, equivocation stops serving, refuses tx types the verifier can't decode | in `97785a40c` |
| `network/witness-gateway.mjs` | Helios execution endpoint: method allowlist, ordered failover across untrusted upstreams, create-only block-hash-pinned witness cache used **only** when every upstream fails, broadcast fan-out | in `97785a40c` |
| tests | `test/op-head-relay.test.mjs` (9), `test/witness-gateway.test.mjs` (7), `test/helios-witness.e2e.test.mjs` (5), `test/fixtures/op-commitment.mjs` (test-only SSZ V4 encoder + test-key signer) | |
| Patched Helios (branch `enclave-base-compat` on tag 0.12.0 = `2af9b41887e0…`) | `rpc-priority/helios-patched` | `0a02256`; 5 files, +83/−4 |
| patched `helios` CLI (debug, no debuginfo) | `rpc-priority/helios-target/debug/helios` | sha256 `0929f7f383a082b8aa7fda97c3058e72a4acc93cbf250a24c7a08ae4e1df98fc` |
| patched `opstack-server` (debug) | `rpc-priority/helios-target/debug/opstack-server` | sha256 `9568ae50ac09359015cf47cfeb54988206d620a410ee7c3e9b69860f2b5eb6c8` |
| stock Helios release 0.12.0 (comparison only) | `vendor-inspect/helios-release-0.12.0` | tar sha256 `dd2746b1…a94b4` (= GitHub asset digest); binary `a7f777b4…19180` |
| helios-ts npm 0.12.0 (inspected, not used: no consensus override) | `vendor-inspect/helios-npm-0.12.0` | tgz `3ae698f5…3e627` (= release digest) |
| Verified dependency crates | `vendor-inspect/crates` | op-alloy-consensus 2.0.0 `6ca73133…`, op-revm 20.0.0 `a5cfe618…` (both = Helios Cargo.lock checksums) |
| Root-run live probe (NOT RUN) | `probes/live-gossip-probe.sh` | |
| Job scripts / logs | `jobs/` | see §3 |

The Helios patch (`0a02256`):
* `server/net/block_handler.rs`: subscribe to `/optimism/{chain}/3/blocks` (V4).
* `consensus.rs` `payload_to_block`: an undecodable tx returns an error instead of `unwrap()` (no abort, no dead head
  task).
* `common/fork_schedule.rs` plus `opstack/evm.rs`: new `execution_unsupported_from_timestamp`. Local execution is
  refused at or after it.
* `opstack/config.rs`: Base mainnet schedule (Isthmus 1746806401, Jovian 1764691201, execution refused from Azul
  1779991200). Base Sepolia refused from 1776708000.
* Unit tests for each change.

## 3. Test evidence (shared queue, actual terminal results)

| Job | Cap | Result |
|---|---|---|
| `jobs/helios-build-test-r1` | 1536 | **guard-stopped** (exit 99): 1545 MiB while rust-lld linked the test binary. No result. |
| `jobs/helios-build-test-r2` (debuginfo off, lld 1 thread) | 1536 | `cargo test -p helios-opstack --lib`: **6 passed / 0 failed** (incl. `unsupported_transaction_type_is_an_error_not_a_panic`, `base_schedules_refuse_execution_from_azul`, `subscribes_to_the_isthmus_v4_blocks_topic`). opstack-server built. CLI **not built** (my cargo line applied `--bin` to both packages). Exit 2. Peak 1107 MiB. |
| `jobs/helios-build-r3` | 1536 | CLI built, exit 0, peak 1196 MiB. |
| `jobs/witness-tests-r1` | 1024 | 16/21 pass. All 5 E2E failed in the `before` hook from a **test-side** `JSON.stringify(BigInt)` message. |
| `jobs/witness-tests-r2` | 1024 | **21/21 pass**, exit 0, peak 237 MiB, inside `unshare -r -n` (the script asserts that external HTTPS is unreachable). |

E2E details (r2; **synthetic test-key heads over Anvil chain id 8453; not live-chain compatibility**):
1. Patched Helios adopts the relay's signed head (hash and stateRoot match). It returns **proof-verified**
   `eth_getStorageAt` (AddressBook `addr["registry"]`, slot 3; slot 2 proves 0), `eth_getCode`, `eth_getBalance` and
   `eth_getProof`. `eth_call` is **refused** ("local execution refused").
2. A tamper proxy rewriting storage-proof values: Helios rejects the read and never returns the value.
3. A wrong-signer head is not adopted. A correctly signed head carrying a 0x79 tx is refused, the patched process
   survives, **and the head loop then adopts a valid higher block** (this matters because a debug build only kills the
   task on panic).
4. Stock 0.12.0 comparison: `eth_call` returned
   `0x…868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac` under Prague rules on an Azul+ timestamp (it executes under an
   unsupported spec). After the 0x79 head: **SIGABRT**, `panicked at opstack/src/consensus.rs:296:73: called
   Result::unwrap() on an Err value: Custom("unexpected tx type")`.
5. **Outage of every execution source** (Anvil killed, no network at all): a freshly restarted verifier proves
   `addr["registry"]` for the pinned head from the witness cache (cacheHits = 1). A never-fetched slot is refused, and
   `eth_sendRawTransaction` is refused.

Live read-only evidence (real chain; small, bounded):
* `fixtures/live-20261023T003820Z/commitment.json`: the hosted Base head returned HTTP 502 (the OP sibling also 502,
  00:38Z).
* `fixtures/live-txtypes/evidence.json`: mainnet.base.org only, 10 blocks around head 52963456, 2,107 txs. Types:
  0x02 = 1932, 0x00 = 161, 0x7e = 10, 0x04 = 4. **No 0x79.** Newest timestamp 1792716249 is after Cobalt and before
  Denim. Header keys include `requestsHash` and `withdrawalsRoot`. This is single-provider, so unverified data.
* publicnode refused the first request with "Rate limit (1200rqs/60s) reached" on this site's shared egress. I made no
  further requests there. This is a sign that production already saturates that provider.

## 4. Trust and freshness audit (what each piece proves)

| Piece | Proves | Does NOT prove |
|---|---|---|
| Signed commitment (relay, Helios) | the pinned Base unsafe-block key signed (number, hash, stateRoot, …) | L1 safety or finality, no equivocation or withholding by the sequencer, a current signer (the pin is a constant; Helios `verify_unsafe_signer` needs an `unsafe_signer_proof` route that opstack-server lacks) |
| Relay `maxAgeMs` | the served head is ≤ maxAgeMs old by the local clock. **Helios itself never rejects old heads.** Consumers must check the verified block timestamp too. | liveness of the network |
| Helios proof reads | the value is in the state trie under the signed stateRoot | anything about other blocks; execution results on Base (refused) |
| Witness cache hit | availability of a verified witness **for that pinned block hash only** | freshness, canonicality, non-reorg |
| Gateway broadcast | some upstream accepted the bytes | inclusion (needs a receipt in a verified block) |

The quorum readers are unchanged. No quorum is weakened, and the verifier is a separate local-validation authority
that is not yet wired to any consumer. There is no admin, auth or catalog bypass: admin-controlled contracts would be
read through the same path.

## 5. Remaining work and exact blockers

1. **Base `eth_call` in the verifier (blocker for "normal contract calls").** Replace op-revm 20 in Helios
   `opstack/src/evm.rs` with base/base `base-common-evm` (@5476069f: revm 42.0.1, alloy-evm 0.38, alloy-consensus 2.3,
   `BaseSpecId`, `BasePrecompiles` incl. the state-reading Cobalt set). Helios pins revm 38 (via op-revm 20) and alloy
   2.1, so this needs either a Helios dependency bump to revm 42 / alloy 2.3, or a fork, plus a `ProofDB` adapter to
   the revm-42 `Database` trait. Add `BaseTxEnvelope` decoding (0x79) before Everest. Track Denim (2026-11-05,
   200 ms blocks; gossip stays v4 at 5476069f). Until then, Enclave consumers get only proof-verified **storage** reads,
   which need per-contract layout pins (e.g. the deployed AddressBook predates `pendingOwner`: `addr` at slot 2, the
   current source uses slot 3).
2. **Independent fresh head (root-run).** `probes/live-gossip-probe.sh` runs the patched `opstack-server` for ≤120 s
   on Base gossip and verifies captured commitments against `0xAf6E19BE…8a`, comparing them with a public block. Not run:
   joining P2P wasn't authorized in this session. If it passes, the head is a release build plus a supervised service.
   Signer rotation stays a pinned value until an L1 SystemConfig proof path exists (nimbus LC + L1 proof, audit P3).
3. **Witness availability without public RPC:** none exists on Base P2P. It needs an Enclave-run Base full node
   (persistent writable volume, which metal lacks; no-NVMe constraint) or acceptance that providers stay an untrusted
   availability layer. The gateway already makes them interchangeable and keeps a pinned-block cache. A Sia-S3 backend
   for that cache is not built (deferred per root's priority). The sia-s3 auth model (SigV4 on every request,
   `If-None-Match:*`, ~45 s small PUTs) is documented in WITNESS-INITIAL §6–7.
4. **Consumers:** LeaseReader is intentionally not wired, because no Base `eth_call` path is verified. Once §5.1
   exists, add an opt-in `verifier` authority with the verified-timestamp freshness check, monotonic block and one
   deadline (design in WITNESS-INITIAL rev 2 §3). provider-settlement and usdc-bandwidth read `leaseReader.clients`
   directly and would need their own change.
5. **Release build:** upstream's release profile is fat LTO with `panic=abort`. All builds here are debug with no
   debuginfo. A release build at ≤1536 MiB is untested and may need `lto=thin`.

## 6. Side effects and housekeeping (disclosed)

* **The global toolchain changed unintentionally:** `rustup toolchain list` run inside the Helios checkout
  auto-installed the upstream-pinned **Rust 1.94.0** (599 MB, `~/.rustup/toolchains/1.94.0-x86_64-unknown-linux-gnu`,
  00:39Z). It was used for the builds. Remove it with `rustup toolchain uninstall 1.94.0` if it isn't wanted.
* Crates went into a workspace-local `rpc-priority/cargo-home` (1.3 GB) and build output into `rpc-priority/helios-target`.
  `~/.cargo` was not touched.
* There are leftover scaffold files in `rpc-priority/geth-oracle` (go.mod and main.go only; the offline geth
  resolution failed). Deletion needed approval, so they are untouched.
* Candidate repo local links, not committed: `node_modules` → native-front-abort's; `contracts/foundry/out` →
  work/enclave's.
* `enclave-apps-sia-recovery` was read only. No other Claude was prompted.
