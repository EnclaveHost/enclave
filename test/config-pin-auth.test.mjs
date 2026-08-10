// scripts/ipfs-add-gateway.py — /add-json is the APP-CONFIG pin route, and it
// is wallet-signed.
//
// Catalog rev 7 moved large app configs off-chain: a version stores a CID and
// the JSON is pinned here, which raised this route's cap from 256 KB to 1 MB.
// It used to carry no upload token at all — its own source called the per-IP
// bucket "the only thing standing between the internet and unbounded pinned
// storage on the Kubo node". That was a defensible trade at 256 KB and is not
// at 1 MB: IP addresses are cheap, and a wallet with a per-address daily byte
// budget is not. So the route now takes the same HMAC token /add-wasm does,
// bound to sha256 of the exact bytes.
//
// This suite runs the gateway with auth ON (UPLOAD_KEY set), which the sibling
// image-gateway suite deliberately does not.
//
//   run: node --test test/config-pin-auth.test.mjs   (needs python3 on PATH)

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ipfs-add-gateway.py");
const UPLOAD_KEY = "test-upload-key";
const ADDR = "0x00000000000000000000000000000000000000a1";

let kubo, gwProc, gwPort, added = [];

const freePort = () => new Promise((res) => {
  const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

before(async () => {
  kubo = http.createServer((req, res) => {
    let n = 0;
    req.on("data", (c) => (n += c.length));
    req.on("end", () => {
      added.push(n);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Hash: "bafyconfigpinnedaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    });
  });
  await new Promise((r) => kubo.listen(0, "127.0.0.1", r));

  for (let attempt = 0; attempt < 3; attempt++) {
    gwPort = await freePort();
    gwProc = spawn("python3", [GW], {
      env: { ...process.env, PORT: String(gwPort), UPLOAD_KEY,
             KUBO_API: `http://127.0.0.1:${kubo.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 100 && gwProc.exitCode == null; i++) {
      try { const r = await fetch(`http://127.0.0.1:${gwPort}/healthz`); if (r.ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    try { gwProc.kill("SIGKILL"); } catch {}
  }
  throw new Error("gateway did not start");
});

after(() => { try { gwProc.kill("SIGKILL"); } catch {} kubo.close(); });

// mint the token the api-relay would mint for these exact bytes
function sign(body, { expiry = Math.floor(Date.now() / 1000) + 300, address = ADDR } = {}) {
  const h = crypto.createHash("sha256").update(body).digest("hex");
  const token = crypto.createHmac("sha256", UPLOAD_KEY).update(`${address}:${h}:${expiry}`).digest("hex");
  return { "x-upload-address": address, "x-upload-expiry": String(expiry), "x-upload-token": token };
}

const pin = (body, headers = {}) => fetch(`http://127.0.0.1:${gwPort}/add-json`, {
  method: "POST", body, headers: { "content-type": "application/json", ...headers } });

test("an unsigned config pin is refused", async () => {
  const before = added.length;
  const r = await pin(JSON.stringify({ hello: "world" }));
  assert.equal(r.status, 401);
  assert.equal(added.length, before, "nothing may reach Kubo");
});

test("a correctly signed config pin is accepted", async () => {
  const body = JSON.stringify({ hello: "world" });
  const r = await pin(body, sign(body));
  const text = await r.text();                 // read ONCE: a Response body is single-use
  assert.equal(r.status, 200, text);
  assert.equal(JSON.parse(text).cid, "bafyconfigpinnedaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a token minted for OTHER bytes does not authorize these", async () => {
  // the token commits to sha256(body): swapping the payload must not validate,
  // or one signature would be a standing pin credential
  const before = added.length;
  const r = await pin(JSON.stringify({ hello: "evil" }), sign(JSON.stringify({ hello: "world" })));
  assert.equal(r.status, 403);
  assert.equal(added.length, before, "nothing may reach Kubo");
});

test("an expired authorization is refused", async () => {
  const body = JSON.stringify({ a: 1 });
  const r = await pin(body, sign(body, { expiry: Math.floor(Date.now() / 1000) - 1 }));
  assert.equal(r.status, 401);
});

test("the cap is 1 MB — the ceiling a version's config may actually reach", async () => {
  // Lockstep with wasm_manager CONFIG_MAX_BYTES: a config this pins but the
  // runner refuses is a version that publishes and then fails every launch.
  const body = JSON.stringify({ big: "x".repeat(1024 * 1024) });
  const before = added.length;
  let refused = false;
  try { refused = (await pin(body, sign(body))).status === 413; } catch { refused = true; }
  assert.ok(refused, "an over-cap config must be refused");
  assert.equal(added.length, before, "nothing may reach Kubo");

  // …and something comfortably under it still goes through
  const ok = JSON.stringify({ big: "x".repeat(512 * 1024) });
  const r2 = await pin(ok, sign(ok));
  assert.equal(r2.status, 200, await r2.text());
});

test("a non-object payload is refused even when correctly signed", async () => {
  const body = JSON.stringify(["not", "an", "object"]);
  const r = await pin(body, sign(body));
  assert.equal(r.status, 415);
});
