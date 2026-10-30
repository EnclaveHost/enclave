# Finalized consumer interface: contract (PREPARED; nothing run, integrated or committed)

Read from exact current files:
- candidate `rpc-final-candidate-20261026/tree/network/{verified-chain,chain-authority,rpc-runtime}.mjs`, `metal/chain-verifier-image.json`;
- `base-finality-proof-stage/r12-final/{src/finality-core.mjs,vendor/anchor-bootstrap.mjs}`;
- `source/.../l1-anchor-a1/a1-anchor.mjs`.

## 1. What exists today (facts)

- **Candidate verifier = UNSAFE tier only.**
  - `rpc-runtime.mjs:580-582` runs `helios opstack --network base` with a pinned `unsafe_signer` (`config.chain.unsafeSigner`).
  - `createVerifiedSnapshot` and `pinnedClient` return `tier:'unsafe', finality:'none'` (`verified-chain.mjs:163`).
  - `chain-authority.mjs:205-206` refuses `safe`/`finalized`.
  - **The SNP chain-verifier image contains no L1 light client.** Its binaries are the head listener, Helios 8250f08a (opstack mode) and witness-check.
- **Finality backend (RPC VM, non-SNP).**
  - `finality-core.mjs qualify()` authenticates a NEW L1-finalized ASR output root at N′ and walks the headers N′ down to the original launch anchor on our node.
  - `finality_state.py` wraps it: capture, journal, runtime pins, published status.
  - Its outputs are root-owned files on the RPC VM. **They are not remote-verifiable**:
    - the A1 evidence carries Helios-verified *values*, not the light-client or `eth_call` proofs;
    - the journal carries N′ and its hash, not the headers or proofs.
  - **So no receipt from the RPC VM may serve as finality authority for a remote consumer.**
- **Reusable pure verification code.** It needs no files from the RPC VM; only transports are injected.
  - `a1-anchor.mjs runA1(cfg, {helios, el}, {keccak, headerHash, now})`: from a Helios-FINALIZED L1 block, the ASR anchor (root, `l2SequenceNumber`) and anchor game. It checks respected, finalized, not blacklisted, not retired, DEFENDER_WINS, root/number/ASR/type agreement, and code presence via MPT account proofs from an untrusted EL. It returns `{verdict, N, outputRoot, game, asr, respectedGameType, l1:{number,hash,stateRoot,timestamp,ageSec}}`.
  - `anchor-bootstrap.mjs authenticateAnchor({rootClaim, l2BlockNumber}, header, keccak)`: recomputes keccak(RLP(Isthmus header)) and OutputRootV0 = keccak(0³² ‖ stateRoot ‖ withdrawalsRoot ‖ blockHash) and must reproduce the root. `headerHash()` is exported too.
  - `a1-anchor.mjs checkProofResponse(stateRoot, eth_getProof JSON, keccak)`: account and storage MPT verification.

## 2. Interface: `src/finalized-anchor.mjs`

Bundled beside the pinned `a1-anchor.mjs` (ec92b70f) and `anchor-bootstrap.mjs` (90a8afba). No new cryptography.

```
authenticateFinalizedAnchor({ a1Config, l1: {helios, el}, base: {request}, keccak, now, maxAnchorAgeSec })
  -> FinalizedAnchor = frozen {
       format: "enclave-base-finalized-anchor/v1", tier: "finalized", finality: "l1-finalized-asr-anchor",
       base: { number, hash, stateRoot, messagePasserStorageRoot, timestamp (s), outputRoot },
       game, asr, respectedGameType,
       l1:   { number, hash, stateRoot, timestamp },       // the Helios-finalized L1 block every L1 read was pinned to
       anchorAgeSec,      // now - base.timestamp: the anchor BLOCK's age, never the observation time
       maxAnchorAgeSec,   // 0 = finality-only (owner opt-in); > 0 refuses anchor_too_old
       observedAt }
  throws A1Error {code}: wrong_chain, no_finality, finalized_stale, game_not_finalized, game_retired, root_mismatch, ...
         FinalizedAnchorError {code}: bad_input, bad_anchor, anchor_header_missing, output_root/hash_claim/anchor_number
                                      (from authenticateAnchor), anchor_future, anchor_too_old

readAnchorAccount(anchor, base, address, slots, keccak)
  -> { nonce, balance, storageRoot, codeHash, storage: { slot32: bigint } }   // eth_getProof at {blockHash: anchor.base.hash},
                                                                               // proven against anchor.base.stateRoot

checkHeadAgainstAnchor(anchor, head{number,hash,timestamp ms}, { now, maxHeadAgeMs=60000, headers?, keccak, maxDepth=4096 })
  -> frozen { deny: bool, reasons: [head_below_finalized_anchor | head_stale | head_not_descendant_of_finalized_anchor |
                                     descent_unchecked | malformed_head], tier: "unsafe", finality: "none" }
```

**`checkHeadAgainstAnchor` is DENY-ONLY.**
- The head comes from the separate sequencer-signed head authority (the SNP opstack verifier with its pinned `unsafe_signer`).
- A non-deny result never upgrades the head.
- The optional descent check recomputes hashes from the anchor upward to the signed head hash. It proves consistency only, not finality.
- Spans above `maxDepth` deny (`descent_unchecked`) rather than pass.

## 3. Trust boundary (must hold for any finality claim to a remote consumer)

- **All three functions run inside the consumer's accepted domain:** the SNP chain-verifier VM, attested, or the consumer itself.
- `l1.helios` is an **L1 ethereum-mode light client running in that same domain**, bootstrapped from a reviewed weak-subjectivity checkpoint.
- `l1.el`, `base.request` and the headers may be any untrusted server, including our RPC VM: every value is verified.
- **Inputs that are never accepted:** the RPC VM's `base-finality-status.json`, journal entries, capture evidence or launch records.

## 4. Missing proof/runtime path (why this is not yet deployable): concrete next patch

1. **No L1 light client in the SNP image.**
   - Add an in-domain `helios ethereum` process: same fork; 8250f08a's ethereum subcommand **must be verified** (not assumed), or pin the L1-mode build cc962e2b.
   - Give it the reviewed checkpoint record, `--consensus-rpc` (an untrusted beacon API via a loopback relay) and `--execution-rpc` (an untrusted L1 EL via the witness-style gateway).
   - Expose it on SNP loopback as `l1.helios`.
   - Add a re-measured image and new trust-list binding (`final-proof-image-stage` successor).
2. **Bundle the pure modules** into the image: `a1-anchor.mjs`, `anchor-bootstrap.mjs`, the cold-proof r3 `a1-read.mjs` for `a1io` deadlines, and `finalized-anchor.mjs`. Plus `@noble/hashes` keccak; it is already in the image deps via viem, so pin the exact path.
3. **A JSON-RPC surface in `rpc-runtime`**, e.g. `enclave_finalizedAnchor` → FinalizedAnchor, and `eth_getProof`/reads at the anchor through `readAnchorAccount`. Keep it separate from the unsafe `pinnedClient`, and **never** answer `finalized` tags from the unsafe verifier.
4. **State at the anchor is often unreachable.**
   - The ASR anchor is a resolved game: typically days old, about 10⁵ Base blocks.
   - Our Base node runs with `--rpc.eth-proof-window 1800` (`chain_service.py:984`), and historical-proof cost at that depth is unmeasured (L1 showed 22 s cold at 82 blocks).
   - `readAnchorAccount` therefore needs a source that holds proofs for the anchor block. Raising the window is a separate, measured decision.
   - `authenticateFinalizedAnchor` itself needs only the anchor **header**.

## 5. Limitations to communicate to the KVM chat

- **"Finalized" here means the L1-finalized ASR anchor** (a resolved, respected, DEFENDER_WINS game). It is not op-node's derivation `finalized` tag, and it lags by days.
  - `maxAnchorAgeSec` > 0 bounds that lag by the anchor block's own timestamp.
  - `maxAnchorAgeSec` = 0 is finality-only. Re-observing an old anchor never refreshes its age.
- **Blocks above the anchor are never authenticated.** The current head is sequencer-signed UNSAFE: deny-only checks, never a finality upgrade.
- **The deny-only head authority trusts the pinned `unsafe_signer` from config.** Signer rotation through L1 SystemConfig is not followed: a separate gap.
- **Fail-closed on new header formats.** `requireIsthmus` headers: a future Base fork that adds header fields makes `authenticateAnchor` refuse until `anchor-bootstrap.mjs` is updated.
- **L1 finality rests on the in-domain light client's checkpoint** (weak subjectivity), refreshed under the reviewed checkpoint policy.

## 6. Tests to add with the integration (not written/run here; reuse fixtures)

Reuse the `a1-anchor.test.mjs` world mocks (27 tests) for the L1 side, and an Isthmus header fixture (as in the anchor-bootstrap tests) for authenticateAnchor:
1. A correct world returns FinalizedAnchor.
2. A tampered header field refuses `output_root`, and a claimed hash ≠ keccak refuses `hash_claim`.
3. `maxAnchorAgeSec` 0 ignores age, `>0` refuses `anchor_too_old`, and re-observation with an unchanged anchor keeps the same `anchorAgeSec` basis.
4. `readAnchorAccount` refuses a wrong-root proof (`checkProofResponse`) and a wrong address.
5. `checkHeadAgainstAnchor`: below anchor, stale, broken link, a span over `maxDepth` → deny; a valid chain → `deny:false` with `tier:'unsafe'`.
