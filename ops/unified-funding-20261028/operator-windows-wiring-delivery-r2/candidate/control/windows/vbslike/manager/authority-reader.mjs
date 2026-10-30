/* ============================================================
   The manager's OWN authenticated authority reader (permit r1, SOURCE ONLY): what PermitEnforcement needs, and why
   r1 leaves it UNAVAILABLE in production rather than faking it.

   Contract consumed by permit-enforcement.mjs:
     reader.qualification === "production-derived-finality"
     reader.read(deployment) -> the servingContextOf(pins, snapshot) shape (deployment-host-authority.mjs):
       { assignment{deployment,host,state,operator,generation,policyRevision,admitted,funded,authorityTier,proofVerified,
                    observedAt,blockTimestamp,blockHash} | generationAuthority, policy{revision,threshold,witnesses},
         hostAuthority (same-block evidence: context,status,blockHash,proofVerified), hostAdmitted }
   derived from ONE authenticated block of the owner-selected chain view, never from a JSON status page, an RPC-quorum
   label, the permit transport or the controller.

   The qualified way to produce that is createLifecycleChainAdapter (deployment-chain-adapter.mjs) over
   createLifecycleFinalitySnapshot (lifecycle-finality-bridge.mjs: an in-process derivation reader readAnchor + proof
   verifier + durable anchor journal), then servingContextOf. In r18 that adapter's constructor also takes
   actorSigner/approvals/relay for its FINANCIAL operations; the manager must not hold those, and inventing a
   signer/relay or an authority.kind to satisfy the constructor is exactly the fabrication this task forbids. A
   read-only selection of the adapter has not been written or qualified. Therefore:

   MISSING (exact, all required before production capability can become available):
     1. a reviewed READ-ONLY selection of deployment-chain-adapter.mjs (snapshot/read path only, same trust checks,
        no actorSigner/approvals/relay) with its own qualification run;
     2. a Windows deployment of the in-process derivation reader (network/derived-reader/lifecycle.mjs + vendor
        anchor-bootstrap) supplying readAnchor, with pinned owner-selected L1/L2 sources (no Enclave-only endpoint);
     3. the proof-verifier capability for lifecycle-finality-bridge.mjs on Windows (not the remote attested-verifier
        client: that proves remote measured execution, not this manager, and is not a derived-finality adapter);
     4. a durable anchor journal on the Windows owned-log primitive (win-durable.mjs), not owned-durable-state/flock;
     5. the reviewed pins: lifecycle/ledger/registry addresses and code hashes, receipts root, policy document source,
        closure hashes, this host id.
   Until then createWindowsAuthorityReader() throws, main.mjs composes enforcement with authority = null, and /health
   reports permitEnforcement.available = false with this reason. Legacy behaviour is unaffected.

   CENSORSHIP RESISTANCE: the sources in (2) are owner-selected and independent; the witness set is the
   owner's on-chain policy; revocation authority is the wallet-owned host/app policy. No Enclave endpoint, catalog,
   admin key or Enclave-only signer is a dependency or an override here.
   ============================================================ */
export const MISSING_PRODUCTION_INPUTS = Object.freeze([
  "read-only qualified selection of deployment-chain-adapter.mjs (no actorSigner/approvals/relay)",
  "Windows in-process derivation reader (derived-reader/lifecycle.mjs readAnchor) with owner-selected sources",
  "Windows proof-verifier capability for lifecycle-finality-bridge.mjs",
  "durable anchor journal on win-durable.mjs",
  "reviewed chain/registry/receipt/policy/closure pins for this host",
]);

export function createWindowsAuthorityReader(_config) {
  throw Object.assign(Error(`no qualified Windows authority reader composition exists in r1; missing: ${MISSING_PRODUCTION_INPUTS.join("; ")}`),
    { code: "AUTHORITY_UNAVAILABLE", missing: MISSING_PRODUCTION_INPUTS });
}
