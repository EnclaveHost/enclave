# rpc-priority — RESULT: maintained Base EVM in the Helios proof-backed path (2026-10-23 ~02:20Z)

**Status: SOURCE + OFFLINE/RECORDED FIXTURES ONLY. Nothing deployed, activated, hosted or run as a service.**
There were no transactions, no node sync, no NVMe allocation, and nothing was published. Live network use was read-only
public RPC fixture capture: mainnet.base.org, plus base.gateway.tenderly.co for cross-checks. Root owns integration
and production.

## 1. What now works (and how far it is proven)

| Capability | Proven by | Scope / limit |
|---|---|---|
| **Base `eth_call` from verified state with Base's own rules**: base/base v1.5.1 `base-common-evm` (BaseSpecId per upgrade, Base precompile sets incl. the Beryl/Cobalt state-backed activation registry) inside Helios, fed only by Helios's ProofDB | **Real Cobalt-era mainnet block 52965249**: 5 calls recomputed by the patched Helios from verified witnesses = provider `eth_call` byte for byte, live (recording) **and offline** (replay, no network, cache-only witnesses). Calls: AddressBook `addr("registry")`, AddressBook `all()`, **ActivationRegistry `admin()` (Base-only precompile 0x8453…01)**, **Osaka CLZ creation-call**, P256VERIFY vector. 4 agreed across two providers; `all()` is single-provider-confirmed because tenderly rate-limited that request. | Five calls is a meaningful but not exhaustive corpus. Gas-dependent and L1-fee-dependent calls and `eth_estimateGas` parity are not compared. Blocks from **Denim** on are refused by default (§3). |
| Spec ladder, precompile pricing, Base-only precompile install, halt/revert mapping, proof-DB reads | Rust unit tests (§4) using maintained revm/base crates | Synthetic in-memory state |
| **Fresh-head authenticity without a hosted service**: real Base gossip objects → patched `opstack-server --objects-dir --no-gossip` → relay / Helios client with Base's **real** signer (no override) | Worker B's maintained `base-consensus-gossip` listener captured 52 real heads (120 s live, authorized). Offline: server serves the top head and skips a tampered object. Helios adopts it, and **both refuse "latest" because it is stale**. | Head producer = B's listener (bounded tool; thin peer set: 2 real peers, 1 delivering). No backfill. Unsafe tier only. Signer is an admin pin. |
| Freshness | Helios core `check_head_age`: `latest`, `eth_blockNumber` and gas price are refused when the head is >60 s old (**corrects my earlier "Helios never rejects old heads"**). The relay also serves nothing older than `maxAgeMs`. | Block-hash-pinned queries are deliberately not age-checked (history). |
| Fail-closed paths | Missing witness ⇒ error (no unchecked provider fallback). Undecodable tx type (0x79 before Everest support) ⇒ block refused without a panic. Wrong signer ⇒ ignored. Tampered proof ⇒ rejected. wasm build ⇒ Base execution refused. | |

## 2. Exact inventory

| Item | Location | Pin |
|---|---|---|
| Helios patched, **compat** branch (preserved, unchanged) | `rpc-priority/helios-patched` `enclave-base-compat` | `0a02256`; binaries in `helios-target/debug` (helios `0929f7f3…`) |
| Helios patched, **Base EVM** branch | same repo, `enclave-base-evm` | `3416a24` (Base EVM backend + deps), `b93fcfd` (horizon Azul→Denim after live replay), `eeffcc9` (opstack-server `--objects-dir`/`--no-gossip` + real-object tests) |
| Base EVM build outputs (debug, no debuginfo) | `rpc-priority/helios-target-base/debug` | helios `cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0`; opstack-server `35e2f0127d13a9f054cae1751d61578267802c0511ecdf511e17ca1030b95fee` |
| base/base source (path dependency; MIT) | `rpc-priority/vendor-inspect/base-v1.5.1` (shallow, tag v1.5.1) | `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42` |
| Key lock pins (Helios Cargo.lock on `enclave-base-evm`) | | revm **42.0.1** = base lock, alloy-evm **0.38.0** = base lock, alloy-primitives **1.6.1** = base lock. alloy family **2.5.0** (base pins 2.4.1, which is semver-compatible; cargo would not resolve 2.4.1 alongside Helios's crates; recorded as a deviation). Helios keeps revm 43 (core) and op-revm 20/revm 38 (non-Base OP chains). |
| Toolchain | | **Rust 1.96.0** is required by base/base (`rust-version = 1.96`). It was already installed at 00:53Z (not by me; likely worker B) and is selected per job with `RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0`. Nothing new was installed this round. |
| Enclave candidate (branch `rpc-priority`) | `rpc-priority/repo` | `97785a40c`, `36a83c89b` (earlier); **`eb707adc0`** (gateway bare-hash keys + `methods` option, Base-mode E2E + Denim refusal, real-Base replay test); **`9fdc1418c`** (real-gossip head E2E) |
| Recorder (read-only live fixture tool) | `rpc-priority/fixture-tools/record-base-calls.mjs` | not in repo (tooling) |
| Fixture: real Base calls + witnesses | `rpc-priority/fixtures/base-calls-20261023T014412Z` (`fixture.json`, `cache/` 544 KiB, 49 witnesses) | block `0x117db438…89c5`, stateRoot `0x3b94c43e…f1b4` |
| Fixture: real Base heads (copy of B's run, sha256-named) | `rpc-priority/fixtures/base-heads-b-live-20261023T013719Z` (52 objects + heads.jsonl) | names = content sha256 (checked) |
| Job scripts / logs | `rpc-priority/jobs/` | names below |

## 3. Fork horizon (fail-closed policy)

* Base mainnet: execution is allowed through Cobalt and **refused from Denim 1793901600 (2026-11-05T18:00Z)**. Base
  Sepolia is refused from its Denim (1792605600, already active, so Sepolia execution is refused today).
* Reason: the live replay validates Cobalt-era state only. v1.5.1 implements Denim, but nothing here has validated it.
  To lift the horizon after activation, record and replay a Denim-era block with `record-base-calls.mjs`, then bump
  `execution_unsupported_from_timestamp`.
* Any **newly scheduled** Base upgrade (Everest is unscheduled at v1.5.1) requires a new base/base release pin. The
  compiled schedule cannot know it. Operational rule: upgrade before activation; the horizon knob is the brake.

## 4. Test evidence (queue; actual terminal results)

| Job | Cap | Result |
|---|---|---|
| `base-evm-build-test-r1` | 1536 | compiled; 7/12 (5 failed on a **test-side** `TxEnv::default()` chain id 1) |
| `base-evm-build-test-r2` | 1536 | 11/12 (pre-Azul CLZ halts `NotActivated` under REVM 42; the test expected `OpcodeNotFound`) |
| `base-evm-build-test-r3` | 1536 | **12/12**, binaries built, peak 1166 MiB |
| `base-record-r1` | 1024 | client timed out at 20 s, cache empty (transient; cause not identified) |
| `base-record-r2` | 1024 | 5/5 calls Helios = providers, but **nothing cached**: alloy 2.5 sends a bare block hash, and the gateway keyed only `{blockHash}` (fixed) |
| `base-record-r3` | 1024 | 5/5 Helios = mainnet.base.org; 4/5 also = tenderly (1 rate-limited); 49 witnesses cached ⇒ fixture |
| `base-replay-r1` | 1024 | 8/12: Helios refused a stale `latest` (`check_head_age`) during readiness. Test changed to pinned-hash queries. |
| `base-replay-r2` | 1024 | **12/12** offline (replay 5/5, missing witness fails closed, stale latest refused, compat control refuses, default-horizon check, gateway units) |
| `base-evm-build-test-r4` | 1536 | **12/12** with the Denim horizon |
| `base-final-tests-r1` | 1024 | 26/27 offline. The Denim test used Anvil's genesis block, whose account proof Helios rejected (refusal, not a wrong answer). |
| `base-final-tests-r2` | 1024 | **6/6** (helios-witness E2E in Base-execution mode incl. Denim-era refusal; stock 0.12.0 still SIGABRTs on 0x79) |
| `chain-r5` (build + head E2E) | 1536 | Rust **15/15** (incl. real-object tests); head E2E 2/3 (readiness race in the test) |
| `base-head-e2e-r2` | 1024 | **3/3** offline, real heads, real signer |

## 5. Corrected availability statements

* snap is **default-disabled with no flag on pinned Base releases** (audit). The bounded EL probe saw 10/10 TCP
  refusals, which is **inconclusive** about custom peers. I do not claim that no Base peer anywhere can serve proofs.
  The verifier fails closed when no proof source is actually available.
* Fresh witnesses today come from **any single** JSON-RPC execution source, which is untrusted because every proof is
  verified. During an outage of every source, only previously fetched block-hash-pinned witnesses remain (history, not
  freshness).

## 6. Remaining blockers / next steps (honest)

1. **Fresh witness availability without public RPC:** no default-Base P2P proof source exists. The options are an
   Enclave-run Base full node (needs persistent writable storage on metal; no-NVMe constraint) or a custom
   snap-serving peer (unknown). The gateway already accepts any such source as an upstream.
2. **Consumer wiring:** LeaseReader `verifier` authority (Helios loopback, verified-timestamp freshness, monotonic
   block, single deadline) is now technically unblocked for Cobalt-era Base, but **not implemented**.
   provider-settlement and usdc-bandwidth read `leaseReader.clients` directly.
3. **Head production in service form:** supervise B's listener → objects dir → `opstack-server --objects-dir
   --no-gossip` → relay → Helios. B reports a thin peer set and a Denim-rate sizing issue (64 MiB cap ≈ 50 s at 200 ms
   blocks). Signer rotation from L1 is not implemented (admin pin).
4. **Denim validation** after 2026-11-05 (§3). **Release builds** (upstream fat LTO, `panic=abort`) are untested at
   ≤1536 MiB; all evidence here is from debug builds.
5. **Tx submission** is unchanged: only the sequencer HTTP endpoint or an L1 deposit. A broadcast is not inclusion.
6. Sia-S3 witness-cache backend: not built. The cache contract (create-only, block-hash-pinned, re-verified) is ready.
