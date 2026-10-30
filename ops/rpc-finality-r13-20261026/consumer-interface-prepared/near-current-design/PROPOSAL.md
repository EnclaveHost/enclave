# Near-current authenticated Base state (≤ 1 h) inside the accepted domain: route analysis + proposal (PREPARED; nothing built/run)

**Sources inspected (read only):**
- Helios fork `verifier-canonical-stage/base-eeffcc9` (the source of SNP helios 8250f08a; opstack crate);
- Base **v1.5.1** source `/tmp/recipe-pk5njlzh/w8/vendor-inspect/base-v1.5.1`. This is the pinned `base` 9c44836d: `rpc-finality-r5…/harness/a2a4.py:35` says "base v1.5.1";
- candidate `rpc-final-candidate-20261026/tree/network/{rpc-runtime,verified-chain,chain-authority}.mjs`;
- `chain_service.py` (r12-final).

## Facts

**F1. Helios opstack has no safe or finalized source.**
- `opstack/src/consensus.rs`: `finalized_block_send` is created (line 51) but **never sent**. `Inner::advance` only fetches `<consensus_rpc>/latest`, verifies the sequencer signature with `unsafe_signer`, and pushes the unsafe head (lines 134–180).
- Its only L1 use is `verify_unsafe_signer` (lines 183–275). That embeds an Ethereum light client (`EthConsensusClient`) and verifies the SystemConfig unsafe-signer slot by MPT proof. Failure is ignored (`_ = fut.await`): it keeps the configured key.
- **So route (c) has no finalized/safe mode in the pinned Helios.**

**F2. Base v1.5.1 ships a complete derivation+execution proof client** (`crates/proof/`):
- `client` (prologue/driver/epilogue);
- `driver` (`no_std` derivation loop);
- `executor` (stateless `StatelessL2Builder` over a witness `TrieDB`);
- `host` (preimage server: online from L1/L2 RPCs, or offline from a store);
- `preimage`, `mpt`.

`BootInfo` (`proof/src/boot.rs:108`) trusts only:
- `l1_head` (an L1 block hash),
- `agreed_l2_output_root`,
- the claimed root and block,
- the rollup config.

Every other byte is a preimage that the client checks by its hash, so the host and RPC sources are untrusted. The epilogue fails `InvalidClaim` unless the computed output root equals the claim.

**F3. Base's own TEE prover runs exactly this client inside an AWS Nitro enclave** (`proof/tee/nitro-enclave/src/server.rs:144 prove`, `new_local()` dev mode). The host forwards preimages over vsock. The enclave signs `{l1_origin_hash = l1_head, prev_output_root = agreed, …}`. It is Nitro/NSM-specific, not SNP.

**F4. Our trust domain today:**
- The SNP chain-verifier image runs only `helios opstack` (the unsafe tier) and contains no L1 light client and no proof client.
- The non-SNP RPC VM has our own L1 pair and Base node. Its own derivation "safe/finalized" labels and root receipts are **not** remote authority.

## Routes compared

**(a) Verified derivation inside SNP: RECOMMENDED; the only route grounded in pinned source.** It runs the v1.5.1 proof client (F2) in the SNP verifier, with preimages served by an untrusted host over a vsock/pipe-like channel from the non-SNP L1/L2 nodes.
- **Trusted inputs, produced in-domain:**
  - `l1_head` = an L1 block hash the in-domain **L1 light client** reports as finalized (the same Helios consensus code F1 already embeds; it is not exposed as a service today);
  - `agreed_l2_output_root` = initially the L1-authenticated ASR anchor (`finalized-anchor.mjs`/`runA1` + `authenticateAnchor`, in-domain), then **the SNP's own previously verified output root** (chained).
- **Result:** the derived **safe head** at `l1_head`. Because `l1_head` is L1-finalized, it is "finalized" in the derivation sense. Its age is roughly the L1 finality lag (~13–19 min) plus the batch-posting lag, which can meet ≤ 1 h.
- **Costs/unknowns (must be measured offline before any commitment):**
  - **Initial catch-up from a days-old anchor** (~10⁵ Base blocks of stateless execution with per-node preimages) is unmeasured and likely hours or more.
  - **Steady state** is about 1,800 blocks/hour of Base execution in-guest. The SNP guest is admitted at about 2 GiB today, and CPU/RAM per block are unknown.
  - **Restart** loses chained state (ramdisk). Without measurement-bound sealing (an SNP derived key) every restart re-catches-up from the ASR anchor.
  - **Missing pieces:** an SNP preimage transport (Nitro vsock code is not reusable as-is); an L1 light-client service in-domain; a rollup-config pin; the build and measurement.

**(b) Attested full derivation node in SNP: NOT practical.** A full `base` EL+CL needs TB-scale state (base disk 4 TB) on host-controlled storage. Inside SNP nothing verifies DB integrity (a node trusts its own DB), and RAM is far above the SNP admission budget. A node that executes from an untrusted disk is not stronger than (a), and is much heavier.

**(c) Other existing proof modes in the pinned clients:** none gives near-current authority in **our** domain.
- Helios: F1.
- Base's Nitro TEE and ZK proofs are verified on L1 through the dispute or aggregate system. Accepting a Base-registered Nitro signer would mean trusting AWS Nitro plus Base's registration (an external authority, not ours), and a proposal is not final until resolved (days). Not inspected further: out of the ≤ 1 h requirement unless the owner explicitly accepts that external trust.

**Not acceptable at all:** the sequencer-signed unsafe head, or RPC `safe`/`finalized` labels from any node, including ours.

## Ownership/interface proposal (RPC stream owns the authority path; KVM owns lifecycle)

**RPC stream builds, in the SNP verifier image:**
1. `l1-light-client` service (in-domain): `l1Finalized() -> {number, hash, stateRoot, timestamp}`, from the reviewed checkpoint, with untrusted CL/EL behind loopback relays.
2. `anchor-bootstrap` (exists, `finalized-anchor.mjs`, after the defect fixes): an in-domain ASR anchor `{N, hash, stateRoot, outputRoot}`. It is used **only** as the first `agreed_l2_output_root`, never served as "near-current".
3. `derivation-verifier`: the v1.5.1 proof client in-guest, `verify({l1Head, agreed:{number, outputRoot}, claimed:{number, outputRoot}}) -> {ok, safeHead:{number, hash, stateRoot, outputRoot}, l1Head}`, with preimages from an untrusted host channel. It chains `agreed := last verified`.
4. Consumer API (separate from the unsafe client): `enclave_finalizedHead() -> {tier:"l1-finalized-derived", base:{number, hash, stateRoot, outputRoot, timestamp}, l1:{number, hash, timestamp}, verifiedAt}`, plus proof reads pinned to that `stateRoot` (`checkProofResponse`). Our own Base node holds proofs for the last 1,800 blocks, which is ≥ 1 h at 2 s, so near-current state reads are servable. This is unlike the days-old anchor.
5. **Age rule:** `maxAnchorAgeSec` applies to `base.timestamp` (the verified block's own time). 0 means finality-only. Re-verification never refreshes an old block's age.

**KVM owns:** lifecycle, witnesses, denies, expiry, the host manager, and whether to consume `enclave_finalizedHead` or deny on staleness or absence.

**Admin rights unchanged:** no control path, version pin or consumer selection moves.

## Next concrete steps (in order; no code written here because the route is unmeasured)

1. **Offline measurement**: run `base-proof-client` (v1.5.1, host online mode against our non-SNP nodes) for (i) 1,800 blocks and (ii) the anchor-to-head catch-up. Record CPU, RAM and witness bytes per block.
2. Decide the SNP guest size and the sealing approach (an SNP measurement-derived key for the chained checkpoint, or always re-catch-up).
3. Expose the L1 light client in-domain (helios ethereum mode, if the 8250f08a/eeffcc9 CLI supports it; verify).
4. Build the SNP preimage transport, then the image, measurement and trust-list binding.
5. Only then: a bounded skeleton of `derivation-verifier` and the consumer API.
