/* ============================================================
   READ-ONLY selection of the r18 deployment-chain-adapter (permit r2, SOURCE ONLY - authored, not run, NOT QUALIFIED).

   Corrected fact (r1 overstated it): createLifecycleChainAdapter (generated r18 candidate/src/network/
   deployment-chain-adapter.mjs, sha256 b648a3ed..., lines 224-254) ACCEPTS actorSigner/approvals/relay but does not
   require them; actorSigner/approvals/relay are used only by submit() (lines 560-583) and receipts only by prove()
   (submit path). read(id) (lines 444-540) uses authority.snapshot, hostPolicy.load and the optional generation
   head/certificate sources only. So this module constructs THE ACTUAL adapter - same checks, unmodified - with
   every financial/write capability replaced by a counting trap that throws, and returns an object exposing ONLY
   read(id) (plus the trap counters). prepare/submit/reconcile are not reachable through it.

   What it does NOT solve (capability stays false in production until each is supplied and qualified by root):
     - authority: an owner-selected DERIVED snapshot capability ({kind:"derived", snapshot}) running on Windows. The
       existing derived reader (L/network/derived-reader/process.mjs) is Linux-only; importing it on Windows is not a
       deployment. createLifecycleFinalitySnapshot also needs a Windows proof-verifier and an anchor journal on the
       Windows owned-log primitive. AttestedVerifierClient is not this capability.
     - generation: head.read/certificates.read sources (owner-selected, not Enclave endpoints).
     - pins: the reviewed chain/registry/closure/host pins of the deploying owner.
   "rpc-quorum" authority is refused here (the adapter would label its reads tier rpc-quorum, which the enforcement
   stage() refuses anyway): only kind "derived" is accepted, and qualification is "production-derived-finality"
   ONLY when the caller also passes the root-qualified Windows derived-authority record. Nothing here defaults it.

   Mapping to the enforcement contract: read(deployment) -> servingContextOf(pins, snapshot) from the vendored r18
   deployment-host-authority.mjs if the caller provides it (it is the r18 function; no re-derivation here).
   ============================================================ */
export const READ_ONLY_TRAPS = Object.freeze(["actorSigner", "approvals", "relay", "receipts.locate", "receipts.header", "receipts.block"]);

/**
 * createReadOnlyAuthority({ createLifecycleChainAdapter, servingContextOf, pins, authority, hostPolicy, generation, qualifiedDerivedAuthority })
 *   createLifecycleChainAdapter / servingContextOf: the exact vendored r18 functions (injected so the pinned files are used, not copies)
 */
export function createReadOnlyAuthority({ createLifecycleChainAdapter, servingContextOf, pins, authority, hostPolicy, generation = null, qualifiedDerivedAuthority = null }) {
  if (typeof createLifecycleChainAdapter !== "function" || typeof servingContextOf !== "function") throw Error("the vendored r18 adapter and servingContextOf are required");
  if (authority?.kind !== "derived" || typeof authority.snapshot !== "function") throw Error("only an owner-selected DERIVED authority snapshot capability is accepted (no rpc-quorum)");
  const calls = Object.fromEntries(READ_ONLY_TRAPS.map((k) => [k, 0]));
  const trap = (k) => async () => { calls[k]++; throw Error(`read-only authority: ${k} is not held by the manager`); };
  const adapter = createLifecycleChainAdapter({ pins, authority, hostPolicy, generation,
    actorSigner: trap("actorSigner"), approvals: trap("approvals"),
    relay: Object.freeze({ address: "0x0000000000000000000000000000000000000000", send: trap("relay") }),
    receipts: Object.freeze({ locate: trap("receipts.locate"), header: trap("receipts.header"), block: trap("receipts.block") }) });
  const qualified = qualifiedDerivedAuthority?.schema === "enclave-windows-derived-authority-qualification/1" && qualifiedDerivedAuthority.qualifiedBy === "root"
    && qualifiedDerivedAuthority.platform === "win32" && qualifiedDerivedAuthority.authorityKind === "derived";
  return Object.freeze({
    qualification: qualified ? "production-derived-finality" : "UNQUALIFIED-read-only-selection",
    async read(deployment) {
      const snapshot = await adapter.read(deployment);
      if (snapshot?.authority !== "derived" || snapshot.proofVerified !== true) throw Error("authority read is not proof-verified derived finality: unknown");
      return servingContextOf(pins, snapshot);
    },
    trapCalls: () => ({ ...calls }),
  });
}
