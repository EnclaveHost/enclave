// The REAL custodian daemon's startup (custody/v2/daemon.mjs main, bundled as the image bundles it, with the production
// measured config of the original vault) against a host /state server this test controls. Only the chip is stubbed: the
// /opt/custodian/snpkey call returns a test-only key, and every fetch other than the host's is refused (no network).
// Each case is a fresh daemon process. A host answer other than an explicit 404 must never create a new identity or
// write over the stored state; a 404 creates one and seals it with the chip key before anything else.
//   run: node --test test/custody-v2-daemon-startup.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, stop as stopEsbuild } from "esbuild";
import { custodianMeasured, measuredModule, bundleOptions } from "../custody/v2/build-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = randomBytes(32);                                  // test-only stand-in for the chip-derived sealing key
const AAD = Buffer.from("enclave-custody-v2 state");          // daemon.mjs seal/unseal
const seal = (obj, key = KEY) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(AAD);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); };
const unseal = (blob) => { const d = createDecipheriv("aes-256-gcm", KEY, blob.subarray(0, 12)); d.setAAD(AAD); d.setAuthTag(blob.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8")); };

async function bundleDaemon(dir) {
  const hp = JSON.parse(fs.readFileSync(path.join(ROOT, "release/host-policy-production.json"), "utf8"));
  const { measured } = custodianMeasured({ vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5", hostOwnership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7",
    transport: "direct", book: "0xab214342d5a490150a4a977063a2f88e21f80907", hostPolicy: hp });
  const options = bundleOptions(measuredModule(measured), { root: ROOT });
  const stub = path.join(dir, "child-process-stub.mjs");
  fs.writeFileSync(stub, `import { createRequire } from "node:module";
const real = createRequire(import.meta.url)("child_process");
export const { spawn, spawnSync, exec, execFile, execSync, fork } = real;
export function execFileSync(cmd, args, o) {
  if (cmd === "/opt/custodian/snpkey" && args && args[0] === "derive") return process.env.TEST_SNPKEY_HEX + "\\n";
  throw new Error("test: unexpected execFileSync " + cmd);
}
export default { ...real, execFileSync };
`);
  const out = await build({ ...options, entryPoints: [path.join(ROOT, "custody/v2/daemon.mjs")],
    plugins: [...options.plugins, { name: "chip-stub", setup(b) { b.onResolve({ filter: /^(node:)?child_process$/ }, (a) => (a.importer === stub ? undefined : { path: stub })); } }] });
  stopEsbuild();                                              // as the image builder does: no resident esbuild service
  const file = path.join(dir, "custodian.mjs");
  fs.writeFileSync(file, out.outputFiles[0].contents);
  return file;
}

// one daemon process against the host; resolves when it exits (startup always ends: after the state step the next
// step reads the SNP report, which this host has no configfs for, or the chain, which the fetch guard refuses)
function runDaemon(daemon, dir, hostUrl) {
  const cfg = path.join(dir, `host-config-${randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ endpoint: "https://custody.test.example", registryId: "0x" + "ab".repeat(32), hostUrl, genesis: false }));
  const guard = path.join(dir, "fetch-guard.mjs");
  fs.writeFileSync(guard, `const real = globalThis.fetch, allow = process.env.TEST_HOST_URL;
globalThis.fetch = (u, o) => { const s = String(u && u.url ? u.url : u); return s.startsWith(allow + "/") ? real(u, o) : Promise.reject(new Error("test: network refused " + s)); };
`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", guard, daemon], { env: { PATH: process.env.PATH, CUSTODY_HOST_CONFIG: cfg, TEST_HOST_URL: hostUrl, TEST_SNPKEY_HEX: KEY.toString("hex") },
      stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("exit", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

test("the real daemon startup: only an explicit 404 creates an identity; any other host answer leaves the stored state untouched", { timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-daemon-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const daemon = await bundleDaemon(dir);
  const stored = { identityKey: "0x" + "11".repeat(32), encPrivate: "22".repeat(32), member: { epochs: { [`0x${"cd".repeat(32)}:1`]: [{ k: 1, x: "33".repeat(32) }] }, pending: {}, hostSig: null, candidates: {} } };
  let disk = seal(stored), mode = "stored", puts = 0, gets = 0, putFails = false;
  const srv = http.createServer((req, res) => {
    if (req.url === "/state" && req.method === "PUT") {
      const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
        puts++;
        if (putFails) { res.writeHead(500); return res.end(); }
        disk = Buffer.concat(chunks); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
      }); return;
    }
    if (req.url !== "/state" || req.method !== "GET") { res.writeHead(404); return res.end(); }
    gets++;
    if (mode === "disconnect") return req.socket.destroy();
    if (mode === "stall") return;                                         // never answers: the daemon's read deadline
    if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); return res.end(); }
    if (mode === "missing") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"none"}'); }
    if (/^\d{3}$/.test(mode)) { res.writeHead(Number(mode)); return res.end(); }
    if (mode === "empty") { res.writeHead(200); return res.end(); }
    if (mode === "truncated") { res.writeHead(200); return res.end(disk.subarray(0, 27)); }
    if (mode === "foreign") { res.writeHead(200); return res.end(seal(stored, randomBytes(32))); }   // another chip's/build's blob
    if (mode === "tampered") { const b = Buffer.from(disk); b[b.length - 1] ^= 1; res.writeHead(200); return res.end(b); }
    if (mode === "oversize") { res.writeHead(200); return res.end(Buffer.alloc((4 << 20) + 1, 7)); }
    res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(disk);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });
  const hostUrl = `http://127.0.0.1:${srv.address().port}`;
  const original = Buffer.from(disk);

  // the stored state opens; nothing is written
  let r = await runDaemon(daemon, dir, hostUrl);
  assert.match(r.out, /sealed state opened/, r.out);
  assert.doesNotMatch(r.out, /new custodian identity/);
  assert.equal(puts, 0);

  for (mode of ["503", "500", "403", "401", "disconnect", "redirect", "empty", "truncated", "foreign", "tampered", "oversize", "stall"]) {
    const g = gets;
    r = await runDaemon(daemon, dir, hostUrl);
    assert.ok(gets > g, `${mode}: the daemon asked the host for its state`);
    assert.notEqual(r.code, 0, `${mode}: the daemon must not start`);
    assert.match(r.out, /FATAL/, `${mode}: ${r.out}`);
    assert.doesNotMatch(r.out, /new custodian identity|sealed state opened/, `${mode}: ${r.out}`);
    assert.equal(puts, 0, `${mode}: no identity was written over the stored state`);
    assert.deepEqual(disk, original, `${mode}: the stored state is untouched`);
  }

  // recovery: the same stored state opens again
  mode = "stored";
  r = await runDaemon(daemon, dir, hostUrl);
  assert.match(r.out, /sealed state opened/); assert.equal(puts, 0);

  // an explicit 404 whose first write fails: nothing is used, nothing logged as sealed
  mode = "missing"; putFails = true;
  r = await runDaemon(daemon, dir, hostUrl);
  assert.equal(puts, 1); assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /new custodian identity sealed/);
  assert.deepEqual(disk, original);

  // an explicit 404: a fresh identity, sealed with the chip key, written before anything else
  putFails = false;
  r = await runDaemon(daemon, dir, hostUrl);
  assert.equal(puts, 2);
  assert.match(r.out, /new custodian identity sealed/, r.out);
  const fresh = unseal(disk);
  assert.match(fresh.identityKey, /^0x[0-9a-f]{64}$/); assert.match(fresh.encPrivate, /^[0-9a-f]{64}$/); assert.equal(fresh.member, null);
  assert.notEqual(fresh.identityKey, stored.identityKey);
});
