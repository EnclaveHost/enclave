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
import { sealRequest, openResponse, openStream, httpStream, httpRequest, parseHttpResponse } from "./pvm-sealed.js";

// the verifier's expectations: single pins (the lab page) or a verified policy's lists (the installed client, client/);
// pins.instanceIds (a deployment the signed policy binds to instances, INSTANCE-BINDING.md): only v3 evidence for one of them
const expectOf = (pins, nonce, now) => ({ nonce, appId: pins.app,
  allowedRuntimeIds: pins.allowedRuntimeIds || [pins.runtimeId], allowedCodeHashes: pins.allowedCodeHashes || [pins.codeHash],
  allowedAuthorityHashes: pins.allowedAuthorityHashes || [pins.authority], ...(pins.rootPins ? { rootPins: pins.rootPins } : {}), ...(now ? { now } : {}),
  ...(pins.instanceIds ? { instanceIds: pins.instanceIds } : {}) });
// the evidence request: v3 (`EVIDENCE3`, bound to the VM instance) when asked, else v2 -- one line, never a fallback
const evidenceLine = (v3, nonce) => `${v3 ? "EVIDENCE3" : "EVIDENCE"} ${toHex(nonce)}\n`;
// the VM's own refusal is one JSON line, {"error": "..."} (payload evidence_answer: a malformed request, its 2 s pace, its
// budget, an old build that does not know EVIDENCE3): no evidence, named as the VM's words -- never judged as a format
const vmError = (env) => (env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).join() === "error" && typeof env.error === "string"
  ? `the VM answered with an error, not evidence: ${JSON.stringify(env.error.slice(0, 200))}` : null);

async function post(url, body, type) {
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": type }, cache: "no-store", credentials: "omit" });
  if (!r.ok) throw new Error(`the carrier answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** pins: { app, codeHash, authority, runtimeId, rootPins? } -- the page's own, never the relay's. */
export async function fetchVerified({ relay, pins, method = "GET", path = "/", body = null, label = "ok", now, gate, v3 = false }) {
  const t0 = performance.now();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const out = (o) => ({ label, ...o });
  let env;
  try {
    const bytes = await post(`${relay}/evidence`, evidenceLine(v3, nonce), "text/plain");
    const line = new TextDecoder().decode(bytes).split("\n")[0];
    env = JSON.parse(line);
  } catch (e) { return out({ step: "evidence", refused: `no evidence: ${e.message}`, sent: false }); }
  if (vmError(env)) return out({ step: "evidence", refused: vmError(env), sent: false });
  const v = await verifyPvmAppEvidence(env, expectOf(pins, nonce, now));
  const verifyMs = Math.round(performance.now() - t0);
  if (!v.ok) return out({ step: "verify", refused: v.reasons.at(-1), sent: false, verifyMs });
  if (!v.appKey) return out({ step: "verify", refused: "the evidence carries no app key (v1): a page cannot pin a TLS key, so nothing is sent", sent: false, verifyMs });
  if (gate) { const why = await gate(v, env, toHex(nonce)); if (why) return out({ step: "gate", refused: why, sent: false, verifyMs }); }
  const verified = { format: env.format, app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, key: v.transportSpki.slice(-16), appKey: v.appKey.slice(0, 16), nonce: toHex(nonce).slice(0, 16), instance: v.instanceId };
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

/**
 * The same, with the answer STREAMED (SEALED-STREAMING.md): each NDJSON line of the app's response reaches `onLine` as
 * soon as its chunk's tag verifies; `complete` is true only after the authenticated FIN. `cancelAfter` (lab) aborts the
 * fetch after that many token lines -- the cancel reaches the VM as a closed connection. `trace` (lab) returns this
 * request's opening context (enc, the exported value, the nonce) so a recorded stream can be re-opened offline.
 */
export async function fetchVerifiedStream({ relay, pins, path = "/", label = "ok", onLine = () => {}, cancelAfter = 0, trace = false, now, gate, v3 = false }) {
  const t0 = performance.now();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const out = (o) => ({ label, mode: "stream", ...o });
  let env;
  try { env = JSON.parse(new TextDecoder().decode(await post(`${relay}/evidence`, evidenceLine(v3, nonce), "text/plain")).split("\n")[0]); }
  catch (e) { return out({ step: "evidence", refused: `no evidence: ${e.message}`, sent: false }); }
  if (vmError(env)) return out({ step: "evidence", refused: vmError(env), sent: false });
  const v = await verifyPvmAppEvidence(env, expectOf(pins, nonce, now));
  const verifyMs = Math.round(performance.now() - t0);
  if (!v.ok) return out({ step: "verify", refused: v.reasons.at(-1), sent: false, verifyMs });
  if (!v.appKey) return out({ step: "verify", refused: "the evidence carries no app key (v1): a page cannot pin a TLS key, so nothing is sent", sent: false, verifyMs });
  if (gate) { const why = await gate(v, env, toHex(nonce)); if (why) return out({ step: "gate", refused: why, sent: false, verifyMs }); }
  const verified = { format: env.format, app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, key: v.transportSpki.slice(-16), appKey: v.appKey.slice(0, 16), nonce: toHex(nonce).slice(0, 16), instance: v.instanceId };
  const { frame, ctx } = await sealRequest({ appKey: v.appKey, appId: v.appId, runtimeId: v.runtimeId, nonce, request: httpRequest("GET", path), chunked: true });
  const traceCtx = trace ? { enc: toHex(ctx.enc), exported: toHex(ctx.secret), nonce: toHex(nonce) } : undefined;
  const ac = new AbortController();
  const lines = [], arrivals = [];
  let head = null, tokens = 0;
  const http = httpStream({ onHead: (h) => { head = h; }, onLine: (l) => {
    if (ac.signal.aborted) return;   // the page cancelled: later lines, even of a chunk already verified, are not consumed
    const text = l.trimEnd(); if (!text) return;
    lines.push(text); arrivals.push(Math.round(performance.now() - t0)); onLine(text);
    if (/"token":/.test(text)) { tokens++; if (cancelAfter && tokens >= cancelAfter) ac.abort(); }
  } });
  let res;
  try { res = await fetch(`${relay}/sealed`, { method: "POST", body: frame, headers: { "content-type": "application/octet-stream" }, cache: "no-store", credentials: "omit", signal: ac.signal }); }
  catch (e) { return out({ step: "sealed", refused: `no answer: ${e.message}`, sent: true, verified, verifyMs, trace: traceCtx }); }
  if (!res.ok) return out({ step: "sealed", refused: `the carrier answered ${res.status}`, sent: true, verified, verifyMs, trace: traceCtx });
  const reader = res.body.getReader();
  const source = (async function* () { for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } })();
  let httpError = null;
  const r = await openStream(ctx, source, { signal: ac.signal, onData: (d) => { try { http.push(d); } catch (e) { httpError = e.message; ac.abort(); } } });
  const httpEnd = http.end();
  const ms = Math.round(performance.now() - t0);
  const firstToken = arrivals[lines.findIndex((l) => /"token":/.test(l))] ?? null;
  const base = { sent: true, verified, verifyMs, ms, firstTokenMs: firstToken, arrivals, lines, tokens, status: head && head.status, trace: traceCtx };
  if (httpError) return out({ ...base, step: "sealed", refused: `the opened answer is not a valid HTTP stream: ${httpError}`, complete: false });
  if (!r.ok) return out({ ...base, step: "sealed", refused: r.detail, error: r.error, complete: false, chunks: r.chunks });
  return out({ ...base, complete: r.complete && httpEnd.complete, chunks: r.chunks });
}
