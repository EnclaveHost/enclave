// Finding 2, in its own process: a hostile gateway echoing the token or the signature, a raw network exception, a raw or
// signature-quoting runUpload exception, and a malformed request body never put either secret into an error, a page
// reply or a journal (real fetch against two local HTTP servers where a network is involved).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { uploadMessage, runUpload, UploadRefusal } from "../site-upload.mjs";
import { wallet, fixture, hit, launch, fileJournals, gc, upload } from "./site-harness.mjs";
import { TOKEN, pair, secretFree } from "./upload-servers.mjs";

test.afterEach(() => gc());   // each upload holds the 46 MB artifact: free it before the next test (site-harness.mjs)

test("a hostile gateway echoing the token or the signature, a raw network exception and a raw runUpload exception never surface either", async () => {
  for (const [mode, re] of [["token-echo", /^upload token: HTTP 500$/], ["add-echo", /^upload: the gateway returned a CID other than the expected bafy/]]) {
    const p = await pair(mode);
    try {
      const now = Date.now(), auth = uploadMessage(p.fx.t, now), signature = await wallet.signMessage({ message: auth.message });
      const err = await upload({ t: p.fx.t, auth, signature, fetchFn: fetch, nowMs: now }).then(() => null, (e) => e);
      assert.ok(err instanceof UploadRefusal); assert.match(err.message, re); secretFree(err.message, signature);
    } finally { await p.close(); gc(); }
  }
  const fx = fixture(), now = Date.now(), auth = uploadMessage(fx.t, now), signature = await wallet.signMessage({ message: auth.message });
  const loud = async (url, init) => { throw new Error("socket closed while sending " + init.body + " " + JSON.stringify(init.headers)); };
  const err = await upload({ t: fx.t, auth, signature, fetchFn: loud, nowMs: now }).then(() => null, (e) => e);
  assert.equal(err.message, "upload token: request failed"); secretFree(err.message, signature);
  // the page shows only fixed refusal texts: any other exception is withheld, and a refusal quoting the signature too
  for (const thrown of [(sig) => new Error(`raw ${sig} ${TOKEN}`), (sig) => new UploadRefusal(`quoted ${sig}`)]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-net-"));
    const h = await launch(fx, { journals: fileJournals(dir), runUploadFn: async ({ signature: sig }) => { throw thrown(sig); } });
    try {
      await hit(h.origin, "/start", { token: h.token });
      const prep = await hit(h.origin, "/upload/prepare", { token: h.token });
      const sig = await wallet.signMessage({ message: prep.json.message });
      const r = await hit(h.origin, "/upload/signature", { token: h.token, body: { signature: sig } });
      assert.equal(r.status, 409); assert.match(r.json.error, /details withheld/);
      const disk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      for (const text of [JSON.stringify(r.json), disk]) secretFree(text, sig);
    } finally { await h.close(); }
  }
  // a malformed request body is refused without quoting it
  const h = await launch(fx);
  try {
    const u = new URL(h.origin);
    const r = await new Promise((ok, fail) => { const q = http.request({ host: u.hostname, port: u.port, path: "/upload/signature", method: "POST", headers: { host: u.host, origin: h.origin, "x-signing-token": h.token } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode, body: b })); }); q.on("error", fail); q.end(`{"signature":"${signature}"`); });
    assert.equal(r.status, 400); assert.equal(JSON.parse(r.body).error, "request is not JSON"); secretFree(r.body, signature);
  } finally { await h.close(); }
});
