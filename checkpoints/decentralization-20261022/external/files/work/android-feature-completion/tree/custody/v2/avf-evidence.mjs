// Android protected-VM (AVF pVM) release evidence for a custody v2 custodian (custody/v2/custodian.mjs `avf`). OFF unless
// the custodian's operator installs it (custody/v2/avf-operator.mjs, measured), and then used only for a document of this
// format under owner-committed AVF rules (custody/v2/avf-rules.mjs). Nothing here changes the SEV-SNP or Shield paths, the
// shares, the HPKE sealing or the committee: it is custodian step 9 for one more platform, on the Shield precedent.
//
// THE RECIPIENT EVIDENCE. The pVM's measured payload generates the recipient key inside the VM (the Go custody client,
// isolation/m2/pvmcustody, the same ObtainV2 as SNP), and asks AVmPayload_requestAttestation for a certificate over the
// 64-byte challenge
//     challenge[0:32]  = avfReleaseInput = SHA-256("enclave-custody-avf-v1\n" || v2 releaseBinding (32) || InstanceID (32))
//     challenge[32:64] = the AppID: SHA-256 of the component the payload loaded (the payload's word, as on SNP the front's)
// v2.releaseBinding already commits chain, vault, deployment, policy and secret revisions, committee and epoch, every
// custodian's challenge, the RuntimeID, SHA-256(transport SPKI) and the recipient key; InstanceID (SHA-256 of the VM
// instance key's SPKI, INSTANCE-BINDING.md) adds WHICH VM, and the instance key signs the whole challenge. AVF has no
// HOST_DATA: the deployment rides inside the binding, stated by the measured payload, which serves one deployment per VM.
//
// THE CHECKS, in order (each a refusal):
//   1. the document's closed shape; abi/2; no nonce (the challenges are in the binding);
//   2. the app is the rules' app; the runtime identity is admissible, canonical, and its self-test passes;
//   3. the transport key is the attested Ed25519 key, and transportKey is exactly its bytes (the binding commits those);
//   4. the instance key is its own (never the transport key), and listed when the owner bound the rules to instances;
//   5. the AVF chain (relay/avf-verify.mjs, unchanged): a PINNED Google attestation root, every signature, validity dates
//      against THIS custodian's clock, CA bits, isVmSecure, the challenge above, every APK component signed by an admitted
//      authority and one carrying an admitted code hash; then that component's (codeHash, authorityHash) is an admitted PAIR;
//   6. the instance key's signature over the challenge;
//   7. REVOCATION: no certificate of the chain is on Google's attestation status list (custody/v2/avf-status.mjs), read by
//      this custodian itself; an unreadable or stale list refuses.
// What a verdict says, always: tier avf-pvm, hostExcluded true (pKVM), revocation checked.
//
// TEST HOOK, and the only one: rootPins replaces Google's pinned roots with a SYNTHETIC chain's (test/fixtures/avf-synthetic.mjs).
// The operator adapter (avf-operator.mjs) never passes it, and a verifier built with it says so in every verdict.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { verifyAvfEvidence, GOOGLE_ATTESTATION_ROOT_SHA256 } from "../../relay/avf-verify.mjs";
import { canonical, validateRuntimeIdentity, checkRuntimeSelfTest, instanceSigMessage } from "../../relay/pvm-evidence-core.mjs";
import { chainSerials } from "./avf-status.mjs";

export const AVF_EVIDENCE_FORMAT = "enclave-pvm-custody-evidence/v1";
export const AVF_EVIDENCE_TIER = "avf-pvm";
export const AVF_CUSTODY_DOMAIN = "enclave-custody-avf-v1\n";
const ABI2 = "enclave-domain-abi/2";
const KEYS = ["abi", "appSha256", "chain", "format", "identity", "instanceKey", "instanceSig", "runtime", "selftest", "spki", "transportKey"];
const ED25519_SPKI = /^302a300506032b6570032100[0-9a-f]{64}$/;
const sha256 = (...p) => createHash("sha256").update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();

/** challenge[0:32] of an AVF custody release (isolation/m2/pvmcustody avf.go computes the same bytes). */
export function avfReleaseInput({ binding, instanceId }) {
  const b = Buffer.from(binding || []), i = Buffer.from(instanceId || []);
  if (b.length !== 32) throw new Error("the release binding is 32 bytes");
  if (i.length !== 32) throw new Error("the instance id is 32 bytes");
  return sha256(Buffer.from(AVF_CUSTODY_DOMAIN), b, i);
}
/** The whole 64-byte AVF challenge: avfReleaseInput || AppID. */
export const avfReleaseChallenge = ({ binding, instanceId, appId }) => {
  const a = Buffer.from(appId || []);
  if (a.length !== 32) throw new Error("the app id is 32 bytes");
  return Buffer.concat([avfReleaseInput({ binding, instanceId }), a]);
};

const ed25519Verify = (spkiHex, msg, sigHex) => {
  try { return cryptoVerify(null, msg, createPublicKey({ key: Buffer.from(spkiHex, "hex"), format: "der", type: "spki" }), Buffer.from(sigHex, "hex")); }
  catch { return false; }
};

/**
 * createAvfCustody({ statusList, now, rootPins })
 *   statusList  custody/v2/avf-status.mjs createAvfStatusList(): Google's list, fetched by THIS custodian (required)
 *   now         the custodian's clock (ms)
 *   rootPins    TEST ONLY: synthetic root pins; every verdict then says synthetic
 * -> { verify(args), tier, synthetic }
 */
export function createAvfCustody({ statusList, now = Date.now, rootPins = undefined } = {}) {
  if (!statusList || typeof statusList.check !== "function") throw new Error("AVF custody: the attestation status list (revocation) is required");
  const synthetic = rootPins !== undefined;
  if (synthetic && (!Array.isArray(rootPins) || !rootPins.length)) throw new Error("AVF custody: test root pins must be a non-empty list");
  const pins = synthetic ? rootPins : [...GOOGLE_ATTESTATION_ROOT_SHA256.values()];

  /** the custodian's step 9 for an AVF document -> { ok, reason?, measurement, instanceId, tier, hostExcluded, revocation } */
  async function verify({ doc, allowedMeasurements, binding, appId, rules }) {
    const no = (reason) => ({ ok: false, reason: synthetic ? `${reason} (synthetic roots)` : reason });
    try {
      // 1. shape
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return no("the AVF evidence is not an object");
      if (Object.prototype.hasOwnProperty.call(doc, "nonce")) return no("a custody release document must not state a nonce (the challenges are bound in the AVF challenge)");
      if (Object.keys(doc).sort().join() !== KEYS.join()) return no(`the AVF evidence fields must be exactly ${KEYS.join(",")}`);
      if (doc.format !== AVF_EVIDENCE_FORMAT || doc.abi !== ABI2) return no(`evidence must be a ${AVF_EVIDENCE_FORMAT} document stating ${ABI2}`);
      // 2. app and runtime
      const app = Buffer.from(appId).toString("hex");
      if (doc.appSha256 !== app) return no("the document names another app than the rules admit");
      if (!Array.isArray(allowedMeasurements) || !allowedMeasurements.length) return no("no admitted AVF image for this runtime");
      const why = validateRuntimeIdentity(doc.runtime);
      if (why) return no(`the runtime identity is not admissible: ${why}`);
      if (typeof doc.identity !== "string" || doc.identity.length > 1024 || !canonical(doc.runtime).equals(Buffer.from(doc.identity)))
        return no("the runtime identity line is not the canonical form of the stated runtime");
      const st = checkRuntimeSelfTest(doc.selftest, doc.runtime);
      if (!st.ok) return no(st.reasons[0]);
      // 3. transport key
      if (typeof doc.spki !== "string" || !ED25519_SPKI.test(doc.spki)) return no("the transport key is not a 44-byte Ed25519 SPKI (lowercase hex)");
      if (doc.transportKey !== Buffer.from(doc.spki, "hex").toString("base64")) return no("transportKey is not base64 of the attested transport key");
      // 4. instance
      if (typeof doc.instanceKey !== "string" || !ED25519_SPKI.test(doc.instanceKey)) return no("the instance key is not a 44-byte Ed25519 SPKI (lowercase hex)");
      if (doc.instanceKey === doc.spki) return no("the instance key is the transport key: an instance key is its own, never the boot's");
      if (typeof doc.instanceSig !== "string" || !/^[0-9a-f]{128}$/.test(doc.instanceSig)) return no("instanceSig is not 128 lowercase hex (an Ed25519 signature)");
      const instanceId = sha256(Buffer.from(doc.instanceKey, "hex"));
      if (rules && Array.isArray(rules.instances) && !rules.instances.includes(instanceId.toString("hex")))
        return no(`instance ${instanceId.toString("hex").slice(0, 16)}… is not one the owner bound this deployment to`);
      // 5. the chain over THIS release's challenge
      if (!Array.isArray(doc.chain) || doc.chain.length < 2 || doc.chain.length > 8) return no("the AVF chain is not 2..8 certificates");
      const chain = [];
      for (const ce of doc.chain) {
        if (typeof ce !== "string" || ce.length > 87384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ce) || ce.length % 4) return no("a chain entry is not canonical base64");
        const der = Buffer.from(ce, "base64");
        if (!der.length || der.toString("base64") !== ce) return no("a chain entry is not canonical base64 DER");
        chain.push(der);
      }
      const challenge = avfReleaseChallenge({ binding, instanceId, appId });
      const codes = [...new Set(allowedMeasurements.map((m) => m.codeHash))], auths = [...new Set(allowedMeasurements.map((m) => m.authorityHash))];
      const v = verifyAvfEvidence({ chain, challenge }, { allowedCodeHashes: codes, allowedAuthorityHashes: auths, rootPins: pins, now: now() });
      if (!v.ok) return no(`AVF attestation: ${v.reasons.at(-1)}`);
      const c = v.component;
      if (!allowedMeasurements.some((m) => m.codeHash === c.codeHash && m.authorityHash === c.authorityHash))
        return no("the attested APK's (codeHash, authorityHash) is not a pair the owner admitted for this runtime");
      // 6. the instance key signed this challenge
      if (!ed25519Verify(doc.instanceKey, instanceSigMessage(challenge), doc.instanceSig)) return no("the instanceSig is not the instance key's signature over this release's challenge");
      // 7. revocation, by this custodian's own read of Google's list
      let serials;
      try { serials = chainSerials(chain); } catch (e) { return no(`a chain certificate has no usable serial: ${e.message}`); }
      const rev = await statusList.check(serials);
      if (!rev || rev.state !== "good") return no(rev && rev.state === "revoked" ? rev.reason : `revocation unknown: ${(rev && rev.reason) || "no verdict"}`);
      return { ok: true, synthetic, measurement: c.codeHash, authorityHash: c.authorityHash, instanceId: instanceId.toString("hex"), tier: AVF_EVIDENCE_TIER,
               hostExcluded: true, revocation: { checked: true, fetchedAt: rev.fetchedAt, listSha256: rev.listSha256 } };
    } catch (e) { return no(String(e.message || e)); }
  }
  return { verify, tier: AVF_EVIDENCE_TIER, synthetic };
}
