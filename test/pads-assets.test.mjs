// Prevent a daemon's wrong model default from contaminating another model's
// immutable pad bank, even when both invocations use the same calibration.
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
import { deriveSeed } from "../relay/pads.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loop = path.join(repo, "shielded/dealer/dealer-loop.py");
const hash = (alg, data) => createHash(alg).update(data).digest().subarray(0, 32).toString("hex");

test("asset mismatch refuses every bank mutation and mint in named and all-consumer modes", async t => {
  for (const mode of ["named", "all"]) for (const variant of ["model", "calib", "missing", "partial", "malformed", "missing-allowed", "model-allowed", "valid"]) {
    await t.test(`${mode}: ${variant}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-assets-"));
      let server;
      try {
        const model = path.join(dir, "model.gguf"), calib = path.join(dir, "model.calib"), bank = path.join(dir, "bank");
        fs.mkdirSync(bank); fs.writeFileSync(model, "selected model"); fs.writeFileSync(calib, "same calibration");
        const master = "33".repeat(32), keyFp = "aa".repeat(32);
        const { seed_id } = deriveSeed(Buffer.from(master, "hex"), keyFp);
        const consumer = {name: "phone", keyFp, padKey: "11".repeat(32), seed_id, epoch: 1, issued: true, mark: 64, ack_floor: 64,
          model_digest: hash("sha256", "selected model"), calib_digest: hash("sha512", "same calibration")};
        if (variant.startsWith("model")) consumer.model_digest = hash("sha256", "different model");
        if (variant === "calib") consumer.calib_digest = hash("sha512", "different calibration");
        if (variant.startsWith("missing")) { delete consumer.model_digest; delete consumer.calib_digest; }
        if (variant === "partial") delete consumer.calib_digest;
        if (variant === "malformed") consumer.model_digest = "AB".repeat(32);
        const spent = `${seed_id}-0-64.pads`, pending = `${seed_id}-64-64.pads`;
        fs.writeFileSync(path.join(bank, spent), "spent"); fs.writeFileSync(path.join(bank, pending), "pending");
        const calls = [];
        server = http.createServer((req, res) => {
          const u = new URL(req.url, "http://fixture"); calls.push(`${req.method} ${u.pathname}`);
          res.setHeader("content-type", "application/json");
          if (req.method === "GET" && u.pathname === "/v1/pads/consumers") return res.end(JSON.stringify({consumers: [consumer]}));
          if (req.method === "GET" && u.pathname === "/v1/pads/pvm") return res.end(JSON.stringify(consumer));
          if (req.method === "GET" && u.pathname === "/v1/pads/shipments") return res.end(JSON.stringify({shipments: [{name: spent, index0: 0, count: 64, bytes: 5}]}));
          if (req.method === "PUT") {
            let bytes = 0; req.on("data", b => { bytes += b.length; });
            req.on("end", () => res.end(JSON.stringify({stored: true, bytes}))); return;
          }
          if (req.method === "DELETE") return res.end("{}");
          res.statusCode = 404; res.end("{}");
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const args = [loop, "--once", "--push", "--relay", `http://127.0.0.1:${server.address().port}`, "--master", master,
          ...(mode === "all" ? ["--all"] : ["--name", "phone"]), "--model", model, "--calib", calib, "--out", bank,
          "--ahead", "128", "--chunk", "64", ...(variant.endsWith("-allowed") ? ["--allow-unbound-consumer"] : [])];
        let result, code = 0;
        try { result = await exec("python3", args, {timeout: 10000, env: {...process.env,
          DEALER: path.join(repo, "test/fixtures/fake-dealer.sh"), PADS_DEALER_TOKEN: "fixture-token"}}); }
        catch (e) { result = e; code = e.code; }
        const permitted = variant === "valid" || variant === "missing-allowed";
        assert.equal(code, permitted ? 0 : 1, result.stderr + result.stdout);
        if (permitted) {
          assert.ok(calls.some(c => c.startsWith("PUT ")), "permitted bank uploads");
          assert.ok(calls.some(c => c.startsWith("DELETE ")), "permitted bank prunes");
          assert.ok(fs.existsSync(path.join(bank, `${seed_id}-128-64.pads`)), "permitted bank mints a missing shipment");
        } else {
          assert.match(result.stdout, /REFUSED/);
          assert.equal(calls.length, 1, "refusal precedes even the shipment listing");
          assert.deepEqual(fs.readdirSync(bank).sort(), [".dealer-loop.lock", spent, pending].sort(), "no mint or local pruning");
          assert.equal(fs.readFileSync(path.join(bank, pending), "utf8"), "pending");
        }
      } finally {
        if (server) { server.closeAllConnections(); server.close(); server.unref(); }
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });
  }
});

test("asset cache notices replacement and in-place edits; missing and empty inputs refuse", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-identity-"));
  try {
    await exec("python3", ["-c", `
import importlib.util, pathlib, os, sys
spec = importlib.util.spec_from_file_location('dealer_loop', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
p = pathlib.Path(sys.argv[2]); model = p/'model'; calib = p/'calib'
model.write_bytes(b'first model'); calib.write_bytes(b'calibration')
a = mod.AssetIdentity(str(model), str(calib))
c = {'model_digest': a.digest(str(model), 'sha256'), 'calib_digest': a.digest(str(calib), 'sha512')}
assert a.mismatch(c) is None
assert a.mismatch(c) is None
replacement = p/'replacement'; replacement.write_bytes(b'other model'); replacement.replace(model)
assert 'model SHA256' in a.mismatch(c)
c['model_digest'] = a.digest(str(model), 'sha256')
assert a.mismatch(c) is None
calib.write_bytes(b'CALIBRATION')
assert 'calibration SHA512/256' in a.mismatch(c)
model.write_bytes(b'')
assert 'empty' in a.mismatch(c)
model.unlink()
assert 'cannot identify local assets' in a.mismatch(c)
` , loop, dir], {timeout: 10000});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
