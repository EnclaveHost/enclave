// Finding 2, the upload's network boundary, with two REAL local HTTP servers and the REAL fetch: a gateway that
// redirects the token, upload or CAR request to a second server; the upload refuses the redirect and the second server
// receives nothing (a default-follow control shows it would have received the signature body and the x-upload-token
// header); the page reply and the disk journals hold no token or signature.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadMessage, runUpload, UploadRefusal } from "../site-upload.mjs";
import { wallet, FROZEN, hit, launch, fileJournals, gc, upload } from "./site-harness.mjs";
import { serve, json, redirect, pair, secretFree } from "./upload-servers.mjs";

test.afterEach(() => gc());   // each upload holds the 46 MB artifact: free it before the next test (site-harness.mjs)

test("control: with fetch's default redirect handling these servers WOULD forward the signature body and the x-upload-token header", async () => {
  const B = await serve((req, res) => json(res, 200, {}));
  const A = await serve((req, res) => redirect(res, 307, B.url + "/steal"));
  try {
    await fetch(A.url + "/v1/apps/upload-token", { method: "POST", headers: { "content-type": "application/json", "x-upload-token": "control-token" }, body: JSON.stringify({ signature: "0xcontrol" }) });
    assert.equal(B.hits.length, 1); assert.match(B.hits[0].body, /0xcontrol/); assert.equal(B.hits[0].headers["x-upload-token"], "control-token");
  } finally { await A.close(); await B.close(); }
});

test("redirects of the token, upload and CAR requests are refused by the real fetch; the second server receives nothing; no secret in the error", async () => {
  for (const [mode, re, aHits] of [["token", /^upload token: redirect refused$/, 1], ["add", /^upload: redirect refused$/, 2], ["car", /^CAR fetch: redirect refused$/, 3]]) {
    const p = await pair(mode);
    try {
      const now = Date.now(), auth = uploadMessage(p.fx.t, now), signature = await wallet.signMessage({ message: auth.message });
      const err = await upload({ t: p.fx.t, auth, signature, fetchFn: fetch, nowMs: now }).then(() => null, (e) => e);
      assert.ok(err instanceof UploadRefusal, mode + ": " + err); assert.match(err.message, re);
      assert.equal(p.B.hits.length, 0, mode + ": the redirect target was never contacted");
      assert.equal(p.A.hits.length, aHits);
      if (mode !== "token") assert.equal(p.A.hits[1].bytes, FROZEN.bytes.length, "the whole frozen file reached the gateway only");
      secretFree(err.message, signature); secretFree(err.stack, signature);
    } finally { await p.close(); gc(); }
  }
});

test("through the page: a redirected upload is refused with fixed text; the reply and the disk journals hold no token or signature", async () => {
  const p = await pair("add"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-net-"));
  const h = await launch(p.fx, { gw: { fetchFn: fetch, seen: {} }, journals: fileJournals(dir) });
  try {
    await hit(h.origin, "/start", { token: h.token });
    const prep = await hit(h.origin, "/upload/prepare", { token: h.token });
    const signature = await wallet.signMessage({ message: prep.json.message });
    const r = await hit(h.origin, "/upload/signature", { token: h.token, body: { signature } });
    assert.equal(r.status, 409); assert.equal(r.json.error, "upload: redirect refused"); assert.equal(p.B.hits.length, 0);
    const state = (await hit(h.origin, "/state", { method: "GET" })).json;
    assert.equal(state.upload.status, "ready"); assert.equal(state.next, "upload");
    const disk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    for (const text of [JSON.stringify(r.json), JSON.stringify(state), disk]) secretFree(text, signature);
  } finally { await h.close(); await p.close(); }
});
