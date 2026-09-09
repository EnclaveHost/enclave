import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("late dealer retries reserved but undelivered files, uses remote coverage, and waits when listing fails", async t => {
  const bank = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-delivery-")), seed = "ab".repeat(16);
  t.after(() => fs.rmSync(bank, { recursive: true, force: true }));
  // Consumer-bound minting authenticates both assets even with a fake dealer.
  const model = path.join(bank, "fixture.gguf"), calib = path.join(bank, "fixture.calib");
  fs.writeFileSync(model, "delivery model fixture\n"); fs.writeFileSync(calib, "delivery calibration fixture\n");
  const modelDigest = createHash("sha256").update(fs.readFileSync(model)).digest("hex");
  const calibDigest = createHash("sha512").update(fs.readFileSync(calib)).digest().subarray(0, 32).toString("hex");
  const remote = new Map([[`${seed}-64-64.pads`, Buffer.alloc(1000, 9)]]), puts = [], deletes = [];
  let failPut = true, failList = false, info = null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), name = u.pathname.split("/").at(-1);
    if (u.pathname === "/v1/pads/pvm" && info) { res.end(JSON.stringify(info)); return; }
    if (req.method === "GET" && u.pathname === "/v1/pads/shipments") {
      if (failList) { res.statusCode = 503; res.end("{}"); return; }
      res.end(JSON.stringify({ shipments: [...remote].map(([name, b]) => {
        const parts = name.split("-"); return { name, index0: Number(parts[1]), count: Number(parts[2].slice(0,-5)), bytes: b.length };
      }) })); return;
    }
    if (req.method === "PUT") {
      const chunks = []; for await (const c of req) chunks.push(c);
      puts.push(name);
      if (failPut) { res.statusCode = 503; res.end("{}"); return; }
      const body = Buffer.concat(chunks); remote.set(name, body);
      res.end(JSON.stringify({ bytes: body.length, sha256: u.searchParams.get("sha256") })); return;
    }
    if (req.method === "DELETE") { deletes.push(name); remote.delete(name); res.end("{}"); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (mark, floor = 0, extra = []) => exec("python3", [path.join(root,"shielded/dealer/dealer-loop.py"), "--once", "--push", "--relay", base,
    "--seed", "00".repeat(32), "--seed-id", seed, "--pk", "11".repeat(32), "--mark", String(mark), "--ack-floor", String(floor),
    "--ahead", "64", "--chunk", "64", "--out", bank, "--model", model, "--calib", calib, ...extra],
    { env: { ...process.env, DEALER: path.join(root,"test/fixtures/fake-dealer.sh"), PADS_DEALER_TOKEN: "fixture" }, timeout: 10000 });
  await run(64);
  const pending = path.join(bank, `${seed}-0-64.pads`), original = fs.readFileSync(pending);
  assert.equal(fs.existsSync(path.join(bank, `${seed}-64-64.pads`)), false, "remote shipment prevents unnecessary mint");
  assert.ok(puts.length > 0 && puts.every(n => n === `${seed}-0-64.pads`));
  assert.deepEqual(deletes, []);
  failPut = false; await run(128);
  assert.deepEqual(remote.get(`${seed}-0-64.pads`), original, "failed ciphertext is retried even though the mark passed it");
  assert.ok(remote.has(`${seed}-128-64.pads`)); assert.deepEqual(deletes, []);
  const before = fs.readdirSync(bank).sort(), putCount = puts.length;
  failList = true; const result = await run(192, 128);
  assert.match(result.stdout, /no mint, prune or upload/);
  assert.deepEqual(fs.readdirSync(bank).sort(), before); assert.equal(puts.length, putCount); assert.deepEqual(deletes, []);
  failList = false; await run(128, 128);
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(deletes.sort(), [`${seed}-0-64.pads`, `${seed}-64-64.pads`]);
  // Even after both caches are wiped, an out-of-order acknowledgment remains
  // authoritative; a finalized v2 seed must never launch another mint.
  for (const n of fs.readdirSync(bank).filter(n => n.endsWith(".pads"))) fs.unlinkSync(path.join(bank,n));
  remote.clear(); puts.length = 0;
  info = { seed_id: seed, padKey: "11".repeat(32), issued: true, mark: 128, ack_floor: 0, acked: [[64,128]], finalized: false,
    model_digest: modelDigest, calib_digest: calibDigest };
  await run(128, 0, ["--name", "phone1"]);
  assert.deepEqual(puts.sort(), [`${seed}-0-64.pads`, `${seed}-128-64.pads`]);
  info.finalized = true; puts.length = 0;
  assert.match((await run(256, 0, ["--name", "phone1"])).stdout, /finalized; no further mint/);
  assert.deepEqual(puts, []);
});
