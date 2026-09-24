// pvm-client.js -- a PAGE's whole request to a pVM app (PVM-CPU.md, "The browser channel"; LAB, not production). The
// relay is a carrier of bytes and nothing else: the page verifies the VM itself and only then encrypts a request that only
// that VM can read.
//   1. its own fresh 32-byte nonce -> relay POST /evidence -> the VM's envelope (enclave-pvm-app-evidence/v2);
//   2. pvm-verify.js with the PAGE's pins (Google's roots, the build's code hash, the signing authority, the runtime, the
//      app): the chain, the challenge over the page's nonce and app, the app key signed by the attested transport key;
//      v1 evidence (no app key) is refused -- a page cannot pin a TLS key, so it has nothing to send to;
//   3. the request sealed to that app key (pvm-sealed.js: HPKE, the app, runtime and nonce bound) -> relay POST /sealed ->
//      the VM's sealed answer, opened with this request's keys.
// Every outcome is one object; refusals say which step refused and whether anything left the page.
import { verifyPvmAppEvidence, toHex } from "./pvm-verify.js";
import { sealRequest, openResponse, httpRequest, parseHttpResponse } from "./pvm-sealed.js";

async function post(url, body, type) {
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": type }, cache: "no-store", credentials: "omit" });
  if (!r.ok) throw new Error(`the carrier answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** pins: { app, codeHash, authority, runtimeId, rootPins? } -- the page's own, never the relay's. */
export async function fetchVerified({ relay, pins, method = "GET", path = "/", body = null, label = "ok", now }) {
  const t0 = performance.now();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const out = (o) => ({ label, ...o });
  let env;
  try {
    const bytes = await post(`${relay}/evidence`, `EVIDENCE ${toHex(nonce)}\n`, "text/plain");
    const line = new TextDecoder().decode(bytes).split("\n")[0];
    env = JSON.parse(line);
  } catch (e) { return out({ step: "evidence", refused: `no evidence: ${e.message}`, sent: false }); }
  const v = await verifyPvmAppEvidence(env, { nonce, appId: pins.app, allowedRuntimeIds: [pins.runtimeId], allowedCodeHashes: [pins.codeHash],
                                              allowedAuthorityHashes: [pins.authority], ...(pins.rootPins ? { rootPins: pins.rootPins } : {}), ...(now ? { now } : {}) });
  const verifyMs = Math.round(performance.now() - t0);
  if (!v.ok) return out({ step: "verify", refused: v.reasons.at(-1), sent: false, verifyMs });
  if (!v.appKey) return out({ step: "verify", refused: "the evidence carries no app key (v1): a page cannot pin a TLS key, so nothing is sent", sent: false, verifyMs });
  const verified = { format: env.format, app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, key: v.transportSpki.slice(-16), appKey: v.appKey.slice(0, 16), nonce: toHex(nonce).slice(0, 16) };
  const { frame, ctx } = await sealRequest({ appKey: v.appKey, appId: v.appId, runtimeId: v.runtimeId, nonce, request: httpRequest(method, path, body) });
  let answer;
  try { answer = await post(`${relay}/sealed`, frame, "application/octet-stream"); }
  catch (e) { return out({ step: "sealed", refused: `no answer: ${e.message}`, sent: true, verified, verifyMs }); }
  const o = await openResponse(ctx, answer);
  const ms = Math.round(performance.now() - t0);
  if (!o.ok) return out({ step: "sealed", refused: o.refused, sent: true, verified, verifyMs, ms });
  try { const r = parseHttpResponse(o.response); return out({ sent: true, verified, verifyMs, ms, status: r.status, body: r.body }); }
  catch (e) { return out({ step: "sealed", refused: `the opened answer is not HTTP: ${e.message}`, sent: true, verified, verifyMs, ms }); }
}
