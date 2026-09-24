// client.js -- one request from the INSTALLED pVM client (client/DESIGN.md; LAB, not production). The same code runs in
// the CLI and in the browser extension; it never loads code, and every expectation comes from the signed policy.
//   connect({ relay, policyEnv, store, appId, deployment, path, stream, cancelAfter, onLine, onCommitted, usedNonces, now })
//     -> { result }
// 1. the policy (from whatever carrier) is verified under the install anchor AND durably committed as the client's new
//    monotonic memory (acceptPolicy: store.update -- a cross-process compare-and-swap in the CLI, a browser-wide lock in
//    the extension) BEFORE anything else happens: a crash, a stalled carrier or a concurrent older policy after this
//    point cannot bring the floor back; if the commit cannot be made durable, nothing is sent;
// 2. the app: selected by deployment (its expected app from the signed policy's table, refused at step "select" if the
//    table does not name it, or names another app than the one also given) or directly; one the policy admits, in a mode
//    it allows;
//    A deployment the (type-2) policy binds to VM INSTANCES (INSTANCE-BINDING.md; since 0.5.0) is served v3 only: the
//    client asks EVIDENCE3 and releases only for one of the listed instances; v1/v2 are refused as a downgrade. Any other
//    selection keeps the 0.4 rule (v2 where the policy allows it) and its result says instance: null -- not bound.
// 3. the VM's evidence is verified against the policy's pins (pvm-verify.js), then held to the release rule (gate.js --
//    the Enclave verifier session's admission rule) and to the policy's formats and sealed window; last, the committed
//    state is read again: if a newer policy was committed meanwhile (another tab or process, while this one waited on its
//    carrier), this request is refused, never sent under the superseded policy. Only a release seals and sends the
//    request (pvm-sealed.js), and the nonce is spent.
import { verifyPolicy, selectDeployment, CLIENT_VERSION } from "./trust.js";
import { admit, verdictOf } from "./gate.js";
import { fetchVerified, fetchVerifiedStream } from "../../web/pvm-client.js";

export { CLIENT_VERSION };

/** Verify the policy against the NEWEST committed state and commit the result: { ok, policy, pins, gen, serial } or { ok: false, reason }. */
// `hold` is for tests only (an in-process barrier between reading the state and committing); no client passes it.
export async function acceptPolicy(store, policyEnv, { now = Date.now(), clientVersion = CLIENT_VERSION, hold = null } = {}) {
  let accepted = null;
  let r;
  try {
    r = await store.update(async (state) => {
      if (hold) await hold(state);
      const v = await verifyPolicy(policyEnv, { state, now, clientVersion });
      if (!v.ok) { accepted = null; return { refuse: v.reasons[0] }; }
      accepted = v;
      return { state: v.state };
    });
  } catch (e) { return { ok: false, commitFailed: true, reason: `the client could not record the policy durably (${e.message}): nothing is sent` }; }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, policy: accepted.policy, pins: accepted.pins, gen: r.gen, serial: r.state.serial };
}

export async function connect({ relay, policyEnv, store, appId = null, deployment = null, path = "/", stream = true, cancelAfter = 0, onLine = () => {}, onCommitted = () => {}, usedNonces = new Set(), now, label = "client" }) {
  const pol = await acceptPolicy(store, policyEnv, { now: now ?? Date.now() });
  if (!pol.ok) return { result: { label, step: pol.commitFailed ? "commit" : "policy", refused: pol.reason, sent: false } };
  await onCommitted({ serial: pol.serial, gen: pol.gen });
  const p = pol.policy;
  let instances = null;
  if (deployment !== null) {   // the app a deployment runs comes from the signed table, never from a catalog or a relay
    const sel = selectDeployment(p, { deployment, app: appId });
    if (!sel.ok) return { result: { label, step: "select", refused: sel.reason, sent: false, policySerial: p.serial } };
    appId = sel.app; instances = sel.instances;
  }
  if (!appId) return { result: { label, step: "select", refused: "no app or deployment selected", sent: false, policySerial: p.serial } };
  if (!p.appIds.includes(appId)) return { result: { label, step: "policy", refused: "the policy does not admit this app", sent: false, policySerial: p.serial } };
  const mode = stream ? "chunked" : "whole";
  if (!p.sealedModes.includes(mode)) return { result: { label, step: "policy", refused: `the policy does not allow ${mode} answers`, sent: false, policySerial: p.serial } };
  // bound: v3 and the entry's instances; unbound: v2 where the policy allows it, else v3 (attested, but bound to nothing)
  const v3 = instances !== null || !p.formats.includes("enclave-pvm-app-evidence/v2");
  const pins = { app: appId, ...pol.pins, ...(instances ? { instanceIds: instances } : {}) };
  const gate = async (v, env, nonceHex) => {
    if (!p.formats.includes(env.format)) return `the evidence format ${env.format} is not one the policy allows`;
    const d = await admit(await verdictOf(v, env, nonceHex), { nonce: nonceHex, appId, ...pol.pins, ...(instances ? { instanceIds: instances } : {}) },
                          { clientKind: "browser", usedNonces: [...usedNonces] });
    if (d.decision !== "release") return d.reason;
    if (d.pinned.sealed.windowSeconds !== p.sealedWindow.seconds || d.pinned.sealed.maxRequests !== p.sealedWindow.maxRequests)
      return `the VM's sealed window (${d.pinned.sealed.windowSeconds} s, ${d.pinned.sealed.maxRequests}) is not the policy's (${p.sealedWindow.seconds} s, ${p.sealedWindow.maxRequests})`;
    let cur;
    try { cur = await store.latest(); } catch (e) { return `the committed state cannot be read (${e.message}): nothing is sent`; }
    if (!cur || cur.state.serial !== p.serial) return `policy serial ${p.serial} was superseded by serial ${cur && cur.state.serial} committed meanwhile: nothing is sent`;
    usedNonces.add(nonceHex);
    return null;
  };
  const args = { relay, pins, path, label, gate, v3, ...(now ? { now } : {}) };
  const result = stream ? await fetchVerifiedStream({ ...args, onLine, cancelAfter }) : await fetchVerified(args);
  const instance = instances && result.verified ? result.verified.instance : null;   // bound AND verified; null otherwise
  return { result: { ...result, policySerial: p.serial, stateGen: pol.gen, clientVersion: CLIENT_VERSION,
                     ...(deployment !== null ? { deployment: { id: deployment, app: appId, instance, bound: instances !== null } } : {}) } };
}
