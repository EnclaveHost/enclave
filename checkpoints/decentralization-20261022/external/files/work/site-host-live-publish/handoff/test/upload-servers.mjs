// Two REAL loopback HTTP servers for the upload-boundary tests: gateway A (redirects to B, or echoes secrets, per mode) and
// destination B (records anything it receives), with a fixture trust whose upload URLs point at A.
import http from "node:http";
import assert from "node:assert/strict";
import { ADMIN, fixture } from "./site-harness.mjs";

export const TOKEN = "tok-" + "q".repeat(40);
/** A loopback HTTP server recording every request (body length, and the body itself when small). */
export async function serve(handler) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    let n = 0; const parts = [];
    for await (const c of req) { n += c.length; if (n <= 65536) parts.push(c); }
    const body = n <= 65536 ? Buffer.concat(parts).toString("utf8") : null;
    hits.push({ method: req.method, url: req.url, headers: req.headers, bytes: n, body });
    await handler(req, res, body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: "http://127.0.0.1:" + server.address().port, hits, close: () => { server.closeAllConnections(); return new Promise((ok) => server.close(ok)); } };
}
export const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
export const redirect = (res, code, to) => { res.writeHead(code, { location: to }); res.end(); };

/** Gateway A (mode: where it redirects or what it echoes) and destination B, with a trust pointing at A. */
export async function pair(mode) {
  const B = await serve((req, res) => json(res, 200, { cid: "bafy-from-B" }));
  let signature = null;
  const A = await serve((req, res, body) => {
    if (req.url === "/v1/apps/upload-token") {
      if (mode === "token") return redirect(res, 307, B.url + "/steal-token");
      signature = JSON.parse(body).signature;
      if (mode === "token-echo") return json(res, 500, { error: "bad signature " + signature });
      return json(res, 200, { token: TOKEN, address: ADMIN, expiry: JSON.parse(body).expiry });
    }
    if (req.url === "/add-wasm") {
      if (mode === "add") return redirect(res, 307, B.url + "/steal-upload");
      if (mode === "add-echo") return json(res, 200, { cid: TOKEN + " " + signature });
      return json(res, 200, { cid: fx.t.expectedCid, wasi: "0.2" });
    }
    if (req.url.startsWith("/ipfs/")) return mode === "car" ? redirect(res, 302, B.url + "/steal-car") : json(res, 404, {});
    json(res, 404, {});
  });
  const fx = fixture();
  fx.t = { ...fx.t, upload: { ...fx.t.upload, tokenUrl: A.url + "/v1/apps/upload-token", addUrl: A.url + "/add-wasm", carUrl: (cid) => `${A.url}/ipfs/${cid}?format=car&dag-scope=all` } };
  return { A, B, fx, close: async () => { await A.close(); await B.close(); } };
}
export const secretFree = (text, signature) => { for (const s of [TOKEN, signature, signature.slice(2), signature.slice(2, 40)]) assert.ok(!String(text).includes(s), "a secret leaked: " + String(text).slice(0, 200)); };
