// enroll.js -- how a policy SIGNER learns which VM instance to bind a deployment to (INSTANCE-BINDING.md "The trusted
// source of the binding"; since 0.5.0, agreed with the verifier session). The signer's own installed client fetches v3
// evidence under its OWN fresh nonce and verifies it fully under the policy's pins, with the expected app taken from the
// deployment's entry in the verified table -- so evidence for another app is refused before any certificate. Nothing is
// sealed or sent to the app. What it returns is what the signer puts in the entry's `instances`; the record keeps the
// nonce, the envelope and the whole verification it enrolled under. A relay's published InstanceID is at most a hint for
// where to look; it is never the source.
//   enrollInstance({ relay, policyEnv, store, deployment, now }) -> { ok, record } | { ok: false, step, refused }
import { acceptPolicy } from "./client.js";
import { selectDeployment } from "./trust.js";
import { verifyPvmAppEvidence, toHex, PVM_APP_EVIDENCE_FORMAT_V3 } from "../../web/pvm-verify.js";

export async function enrollInstance({ relay, policyEnv, store, deployment, now }) {
  const pol = await acceptPolicy(store, policyEnv, { now: now ?? Date.now() });
  if (!pol.ok) return { ok: false, step: pol.commitFailed ? "commit" : "policy", refused: pol.reason };
  const p = pol.policy;
  const sel = selectDeployment(p, { deployment });
  if (!sel.ok) return { ok: false, step: "select", refused: sel.reason };
  if (!p.formats.includes(PVM_APP_EVIDENCE_FORMAT_V3))
    return { ok: false, step: "policy", refused: `the policy does not allow ${PVM_APP_EVIDENCE_FORMAT_V3}: an instance cannot be enrolled under it` };
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  let env;
  try {
    const r = await fetch(`${relay}/evidence`, { method: "POST", body: `EVIDENCE3 ${toHex(nonce)}\n`, headers: { "content-type": "text/plain" }, cache: "no-store", credentials: "omit" });
    if (!r.ok) throw new Error(`the carrier answered ${r.status}`);
    env = JSON.parse(new TextDecoder().decode(new Uint8Array(await r.arrayBuffer())).split("\n")[0]);
  } catch (e) { return { ok: false, step: "evidence", refused: `no evidence: ${e.message}` }; }
  if (env && typeof env === "object" && Object.keys(env).join() === "error" && typeof env.error === "string")   // the VM's own refusal (its pace, budget, an old build)
    return { ok: false, step: "evidence", refused: `the VM answered with an error, not evidence: ${JSON.stringify(env.error.slice(0, 200))}` };
  if (!env || env.format !== PVM_APP_EVIDENCE_FORMAT_V3)
    return { ok: false, step: "verify", refused: `${JSON.stringify(env && env.format)} names no instance: only ${PVM_APP_EVIDENCE_FORMAT_V3} can be enrolled` };
  const v = await verifyPvmAppEvidence(env, { nonce, appId: sel.app, ...pol.pins, ...(now ? { now } : {}) });
  if (!v.ok) return { ok: false, step: "verify", refused: v.reasons.at(-1) };
  return { ok: true, record: {
    type: "enclave-pvm-instance-enrollment/1", deployment, app: sel.app, instanceId: v.instanceId, instanceKey: v.instanceKey,
    alreadyBound: !!(sel.instances && sel.instances.includes(v.instanceId)),
    runtimeId: v.runtimeId, codeHash: v.measurement, transportSpki: v.transportSpki, nonce: toHex(nonce),
    policySerial: p.serial, at: new Date(now ?? Date.now()).toISOString(), reasons: v.reasons, envelope: env } };
}
