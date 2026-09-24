// client.js -- one request from the INSTALLED pVM client (client/DESIGN.md; LAB, not production). The same code runs in
// the CLI and in the browser extension; it never loads code, and every expectation comes from the signed policy.
//   connect({ relay, policyEnv, state, appId, path, stream, cancelAfter, onLine, usedNonces, now })
//     -> { state (the client's memory after this policy), result }
// 1. the policy (from whatever carrier) is verified under the install anchor (trust.js); nothing runs without it;
// 2. the app must be one the policy admits, the mode one it allows;
// 3. the VM's evidence is verified against the policy's pins (pvm-verify.js), then held to the release rule (gate.js --
//    the Enclave verifier session's admission rule) and to the policy's formats and sealed window; only a release seals
//    and sends the request (pvm-sealed.js), and the nonce is spent.
import { verifyPolicy, CLIENT_VERSION } from "./trust.js";
import { admit, verdictOf } from "./gate.js";
import { fetchVerified, fetchVerifiedStream } from "../../web/pvm-client.js";

export { CLIENT_VERSION };

export async function connect({ relay, policyEnv, state, appId, path = "/", stream = true, cancelAfter = 0, onLine = () => {}, usedNonces = new Set(), now, label = "client" }) {
  const pol = await verifyPolicy(policyEnv, { state, now: now ?? Date.now() });
  if (!pol.ok) return { state, result: { label, step: "policy", refused: pol.reasons[0], sent: false } };
  const p = pol.policy;
  if (!p.appIds.includes(appId)) return { state: pol.state, result: { label, step: "policy", refused: "the policy does not admit this app", sent: false } };
  const mode = stream ? "chunked" : "whole";
  if (!p.sealedModes.includes(mode)) return { state: pol.state, result: { label, step: "policy", refused: `the policy does not allow ${mode} answers`, sent: false } };
  const pins = { app: appId, ...pol.pins };
  const gate = async (v, env, nonceHex) => {
    if (!p.formats.includes(env.format)) return `the evidence format ${env.format} is not one the policy allows`;
    const d = await admit(await verdictOf(v, env, nonceHex), { nonce: nonceHex, appId, ...pol.pins },
                          { clientKind: "browser", usedNonces: [...usedNonces] });
    if (d.decision !== "release") return d.reason;
    if (d.pinned.sealed.windowSeconds !== p.sealedWindow.seconds || d.pinned.sealed.maxRequests !== p.sealedWindow.maxRequests)
      return `the VM's sealed window (${d.pinned.sealed.windowSeconds} s, ${d.pinned.sealed.maxRequests}) is not the policy's (${p.sealedWindow.seconds} s, ${p.sealedWindow.maxRequests})`;
    usedNonces.add(nonceHex);
    return null;
  };
  const args = { relay, pins, path, label, gate, ...(now ? { now } : {}) };
  const result = stream ? await fetchVerifiedStream({ ...args, onLine, cancelAfter }) : await fetchVerified(args);
  return { state: pol.state, result: { ...result, policySerial: p.serial, clientVersion: CLIENT_VERSION } };
}
