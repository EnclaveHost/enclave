// Test-only world for independent pVM hosting (shielded/anchor/avf/runner/independent.mjs). FIXTURES, labelled as such:
//   - a synthetic AVF chain from a throwaway test CA (test/fixtures/avf-synthetic.mjs): evidence made here is verified by the
//     REAL verifier code under the TEST root pin, never under Google's roots -- it is not hardware evidence (the captured Pixel
//     chain is checked by test/avf-real-pixel10.test.mjs and test/pvm-app-evidence-v4.test.mjs);
//   - VMs with real Ed25519/P-256/secp256k1 keys made here: v4 evidence over the asker's nonce, and the sibling statement
//     signed by whichever proof key the VM holds;
//   - verifier-input sources on loopback (one can serve tampered bytes);
//   - a fetch guard: every request is recorded, and any name under enclave.host (or any host not allowed) is refused.
import http from "node:http";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeCa, issueLeaf, extension, tmpdir, haveOpenssl, CODE, AUTH } from "../fixtures/avf-synthetic.mjs";
import { bind3, instanceIdOf, instanceSigMessage, appKeyMessageV3, tlsKeyMessage, PVM_APP_EVIDENCE_FORMAT_V4 } from "../../relay/pvm-app-attest.mjs";
import { siblingDigest, SIBLING_FORMAT } from "../../relay/pvm-market.mjs";
import { verifierInputsBytes, VERIFIER_INPUTS_FORMAT } from "../../shielded/anchor/avf/runner/independent.mjs";

export { haveOpenssl, CODE, AUTH, tmpdir };
export const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
export const RID = createHash("sha256").update(PIXEL).digest("hex");
export const sha = (b) => createHash("sha256").update(b).digest("hex");

/** The test CA and the verifier inputs it roots (FIXTURE: test root pin, synthetic build/authority hashes). */
export function fixtureInputs(dir) {
  const ca = makeCa(dir);
  const doc = { format: VERIFIER_INPUTS_FORMAT, tier: "pvm-cpu", codeHashes: [CODE.toString("hex")], authorityHashes: [AUTH.toString("hex")], runtimeIds: [RID], rootPins: [ca.rootPin] };
  const bytes = verifierInputsBytes(doc);
  return { ca, doc, bytes, sha256: sha(bytes) };
}

/**
 * A VM: transport, instance, TLS keys; v4 evidence for (appId, nonce) and a sibling statement for (deployment, nonce) signed by
 * `proofKey()` (a viem account: the host's proof key once installed, else the VM's own). forge: "other-code" (another build
 * in the certificate), "other-tls" (a TLS signature over another key).
 */
export function fixtureVm(dir, ca, { forge = null } = {}) {
  const t = generateKeyPairSync("ed25519"), inst = generateKeyPairSync("ed25519"), app = generateKeyPairSync("x25519"), tls = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = t.publicKey.export({ format: "der", type: "spki" }), ispki = inst.publicKey.export({ format: "der", type: "spki" }), iid = instanceIdOf(ispki);
  const appKey = app.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const tlsSpki = tls.publicKey.export({ format: "der", type: "spki" });
  const code = forge === "other-code" ? createHash("sha256").update("another build").digest() : CODE;
  function evidence(appId, nonceHex) {
    const nonce = Buffer.from(nonceHex, "hex"), challenge = Buffer.concat([bind3(spki, nonce, Buffer.from(RID, "hex"), iid), Buffer.from(appId, "hex")]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge, code, auth: AUTH }) }).leaf;
    const signedTls = forge === "other-tls" ? generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }) : tlsSpki;
    return { format: PVM_APP_EVIDENCE_FORMAT_V4, nonce: nonceHex, app: appId, spki: spki.toString("hex"), instanceKey: ispki.toString("hex"),
      instanceSig: edSign(null, instanceSigMessage(challenge), inst.privateKey).toString("hex"), appKey,
      appKeySig: edSign(null, appKeyMessageV3(nonce, appId, iid, appKey), t.privateKey).toString("hex"),
      tlsSpki: tlsSpki.toString("hex"), tlsKeySig: edSign(null, tlsKeyMessage(nonce, appId, iid, signedTls), t.privateKey).toString("hex"),
      appSha256: appId, transportKey: tlsSpki.toString("base64"), identity: PIXEL, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self",
      chain: [leaf, ca.inter, ca.root].map((c) => c.toString("base64")) };
  }
  async function sibling(deployment, nonceHex, proofKey) {
    const st = { format: SIBLING_FORMAT, nonce: nonceHex, deployment, instanceId: iid.toString("hex"), transportSpki: spki.toString("hex") };
    return { ...st, proofKey: proofKey.address.toLowerCase(), sig: (await proofKey.sign({ hash: "0x" + siblingDigest(st).toString("hex") })).slice(2) };
  }
  return { evidence, sibling, instanceId: iid.toString("hex"), transportSpki: spki.toString("hex"), tlsSpkiSha256: sha(tlsSpki) };
}

/** A loopback HTTP server answering GET path -> body (a function or a fixed Buffer/string); { origin, url(p), hits, close }. */
export async function serveStatic(routes) {
  const hits = [];
  const srv = http.createServer(async (req, res) => {
    hits.push(req.url);
    const r = routes[req.url.split("?")[0]];
    if (r === undefined) { res.writeHead(404); return res.end(); }
    const body = typeof r === "function" ? await r(req) : r;
    if (body && body.status) { res.writeHead(body.status); return res.end(body.body || ""); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  return { origin, url: (p) => origin + p, hits, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

/**
 * The network guard: a fetch that records every URL and REFUSES any name under enclave.host and any host not in `allow`
 * (hosts as "127.0.0.1:port" or names). install() also replaces globalThis.fetch (a hidden call through the global is caught
 * too); restore() puts it back. -> { fetch, calls, refused, install, restore }
 */
export function networkGuard(allow = []) {
  const calls = [], refused = [];
  const real = globalThis.fetch;
  const fetch = async (url, init) => {
    const u = new URL(typeof url === "string" ? url : url.url);
    calls.push(u.href);
    if (/(^|\.)enclave\.host$/i.test(u.hostname) || !allow.some((a) => a === u.host || a === u.hostname)) {
      refused.push(u.href);
      throw new Error(`network guard: ${u.host} is blocked in this test (independent hosting must not need it)`);
    }
    return real(url, init);
  };
  return { fetch, calls, refused, allow, install: () => { globalThis.fetch = fetch; }, restore: () => { globalThis.fetch = real; } };
}

// ---- the platform host policy world's clients (copied from test/native-policy.test.mjs, the root's in-process pattern) ----
import https from "node:https";
import fs from "node:fs";
import { Readable } from "node:stream";
/** A mirror fetch that trusts the policy world's test CA (a real TLS connection). */
export const caFetch = (caFile) => async (url, init = {}) => {
  const u = new URL(url), ca = fs.readFileSync(caFile);
  return new Promise((resolve, reject) => {
    const req = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", ca, headers: init.headers || {}, signal: init.signal }, (res) =>
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: Object.entries(res.headers).filter(([, v]) => typeof v === "string") })));
    req.once("error", reject); req.end();
  });
};
/** The world fabricates block timestamps from the clock; this JSON-RPC pass-through pins each block's first timestamp (a real chain's). */
export async function stableChain(t, rpcs, fetchImpl) {
  const seen = new Map();
  const pin = (b) => { if (b && typeof b === "object" && b.hash) { if (!seen.has(b.hash)) seen.set(b.hash, b.timestamp); b.timestamp = seen.get(b.hash); } return b; };
  return Promise.all(rpcs.map(async (upstream) => {
    const server = http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", async () => {
      try {
        const body = Buffer.concat(c), r = await fetchImpl(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
        const text = await r.text(); if (!r.ok) { res.writeHead(r.status); return res.end(text); }
        const j = JSON.parse(text), q = JSON.parse(body), fix = (a, qq) => { if (/^eth_getBlockBy/.test(qq?.method)) pin(a.result); return a; };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(j) ? j.map((a, i) => fix(a, q[i])) : fix(j, q)));
      } catch { res.writeHead(502); res.end(); }
    }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => { server.closeAllConnections(); server.close(); });
    return "http://127.0.0.1:" + server.address().port;
  }));
}
/**
 * An OPAQUE carrier: forwards every request to `target` byte for byte (a generic relay used as a pipe). It interprets
 * nothing; replay(true) answers every request with the FIRST response it carried (a replaying carrier).
 */
export async function opaquePipe(target) {
  let replaying = false, first = null; const carried = [];
  const srv = http.createServer((req, res) => {
    if (replaying && first) { carried.push({ url: req.url, replayed: true }); res.writeHead(first.status, { "content-type": "application/json" }); return res.end(first.body); }
    const up = http.request(new URL(req.url, target), { method: req.method, headers: req.headers }, (r) => {
      const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => { const body = Buffer.concat(c); carried.push({ url: req.url, status: r.statusCode });
        if (!first) first = { status: r.statusCode, body }; res.writeHead(r.statusCode, r.headers); res.end(body); });
    });
    up.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, carried, replay: (v) => { replaying = !!v; }, reset: () => { first = null; }, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
