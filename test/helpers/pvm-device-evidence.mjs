// test/helpers/pvm-device-evidence.mjs: offline re-verification of RECORDED device evidence exchanges through the exact
// pinned adapter (verifier/pvm-evidence.mjs importing the owner's verifyPvmAppEvidence at the pinned commit) and this
// branch's gate (verifier/admission.mjs). An exchange is the pair the lab carrier wrote as received:
// evidence-NNN.request ("EVIDENCE <64-hex nonce>\n", the client's line) and evidence-NNN.json (the VM's answer). The
// expectations are never read from the envelope: they come from the policy the client had COMMITTED before the exchange
// (its appIds, runtimeIds, codeHashes, authorityHashes, googleRootPins, formats) and the nonce from the request.
import fs from "node:fs";
import path from "node:path";
import { verifyPvmEvidence } from "../../verifier/pvm-evidence.mjs";
import { admit, RELEASE } from "../../verifier/admission.mjs";

/** Read every recorded exchange in `dir`, in arrival order: [{ n, nonce, envelope, requestText, envelopeText }]. */
export function readExchanges(dir) {
  const names = fs.readdirSync(dir).filter((f) => /^evidence-\d{3}\.json$/.test(f)).sort();
  return names.map((f) => {
    const n = f.slice(9, 12), requestText = fs.readFileSync(path.join(dir, `evidence-${n}.request`), "latin1"), envelopeText = fs.readFileSync(path.join(dir, f), "utf8");
    const m = /^EVIDENCE(3)? ([0-9a-f]{64})\n$/.exec(requestText);   // "EVIDENCE3" asks for v3 (instance binding), "EVIDENCE" for v1/v2
    let envelope = null, parseError = null;
    try { const ls = envelopeText.split("\n").filter(Boolean); if (ls.length !== 1) throw new Error(`${ls.length} lines`); envelope = JSON.parse(ls[0]); } catch (e) { parseError = e.message; }
    return { n, nonce: m ? m[2] : null, asked: m ? (m[1] ? 3 : 2) : null, requestText, envelope, envelopeText, parseError };
  });
}

/** The client's expectations for one exchange, from the committed policy body and the request's nonce. */
export function expectFromPolicy(policyBody, nonceHex, { instanceIds } = {}) {
  return { nonce: Buffer.from(nonceHex, "hex"), appId: Buffer.from(policyBody.appIds[0], "hex"), allowedRuntimeIds: policyBody.runtimeIds, allowedCodeHashes: policyBody.codeHashes,
           allowedAuthorityHashes: policyBody.authorityHashes, rootPins: policyBody.googleRootPins, formats: policyBody.formats,
           // a deployment bound to instances (type-2 policy): the instance expectation, as expectationsForSelection would produce it
           ...(instanceIds ? { instanceIds: [...instanceIds], formats: policyBody.formats.filter((f) => f === "enclave-pvm-app-evidence/v3") } : {}) };
}

/**
 * Re-verify one exchange as the client would have: the verdict from the pinned adapter, the browser-kind gate decision
 * (the installed CLI gates as a browser-kind client on the v2 app key), and the prefixes the client's own result summary
 * carries (key = last 16 hex of the transport SPKI, appKey = first 16 hex, nonce = first 16 hex), for correlation.
 */
export async function reverifyExchange(ex, policyBody, { now, instanceIds = undefined }) {
  if (!ex.nonce) return { ok: false, why: `request is not "EVIDENCE <nonce>" or "EVIDENCE3 <nonce>": ${JSON.stringify(ex.requestText.slice(0, 40))}` };
  if (!ex.envelope) return { ok: false, why: `envelope unreadable: ${ex.parseError}` };
  const expect = expectFromPolicy(policyBody, ex.nonce, { instanceIds });
  const verdict = await verifyPvmEvidence(ex.envelope, expect, { now });
  if (verdict.status !== "verified") return { ok: false, why: `verdict ${verdict.status}: ${verdict.reasons.join(" | ")}`, verdict };
  if (verdict.admissionSafe !== true || verdict.omissions.length) return { ok: false, why: "verified but not admission-safe or with omissions", verdict };
  const gate = admit(verdict, expect, { clientKind: "browser" });
  if (gate.decision !== RELEASE) return { ok: false, why: `gate held: ${gate.reasons.join(" | ")}`, verdict, gate };
  const c = verdict.claims;
  return { ok: true, verdict, gate, summary: { format: c.format, app: c.appId, runtime: c.runtimeId, codeHash: c.measurement, key: c.transportSpki.slice(-16), appKey: c.appKey.slice(0, 16), nonce: c.nonce.slice(0, 16) }, sealed: gate.pinned.sealed };
}
