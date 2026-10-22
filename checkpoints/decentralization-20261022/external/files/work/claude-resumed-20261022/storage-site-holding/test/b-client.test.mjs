// hold-site.mjs against a LOOPBACK stand-in of the adapter's HTTP surface (/api/status, /api/files, /api/upload with
// X-Api-Key, /ipfs/<cid>?format=raw|car, the bafkqaaa probe), whose index is the line-mapped adapter model over what was
// uploaded. A small release is made with the accepted prepareRelease. The stand-in is not the adapter: it proves the client
// and the verification (complete CAR via the accepted fetchRelease, byte-identical derived release), and that every injected
// fault fails it. Offline: 127.0.0.1 only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { adapterIndex, cidString } from "../tools/adapter-model.mjs";
import { plan, upload, verify, announceConfig } from "../tools/hold-site.mjs";

const TOOLS = process.env.SITE_RELEASE_TOOLS || "/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/site-release-stage/src/scripts/site-release";
const { prepareRelease } = await import(path.join(TOOLS, "release.mjs"));
const { writeCar } = await import(path.join(TOOLS, "car.mjs"));
const { cidParse } = await import(path.join(TOOLS, "unixfs.mjs"));
const sha = (b) => createHash("sha256").update(b).digest();
const rawCid = (c) => cidString(Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), sha(c)]));
// one CAR section removed from a complete CAR: a gateway that silently lacks a block
function dropSection(car) {
  const rd = (i) => { let n = 0, mul = 1, b; do { b = car[i++]; n += (b & 127) * mul; mul *= 128; } while (b & 128); return [n, i]; };
  let [h, i] = rd(0); i += h; const secs = [];
  while (i < car.length) { const [len, j] = rd(i); secs.push([i, j + len, car[j + 1]]); i = j + len; }
  const [s0, e0] = secs.find(([, , codec]) => codec === 0x55);
  return Buffer.concat([car.subarray(0, s0), car.subarray(e0)]);
}
const KEY = "test-key-" + "x".repeat(20);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hold-client-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a small real release: nested dirs, a dotfile dir, a multi-chunk file
const dist = path.join(tmp, "dist"), inst = path.join(tmp, "inst");
for (const [p, b] of [["index.html", "<!doctype html><p>hi</p>"], ["css/site.css", "p{}"], ["js/chunks/a-AAAA.js", "export const a=1;"],
  [".well-known/security.txt", "Contact: x"], ["assets/big.bin", Buffer.alloc(600000, 7)], ["_redirects", "/x /index.html 200\n"],
  ["csp-script-src.txt", "script-src 'self';\n"]]) { fs.mkdirSync(path.dirname(path.join(dist, p)), { recursive: true }); fs.writeFileSync(path.join(dist, p), b); }
fs.mkdirSync(inst); for (const n of ["install.sh", "install.ps1", "host.ps1"]) fs.writeFileSync(path.join(inst, n), "# " + n);
const rel = prepareRelease({ dist, installers: inst, out: path.join(tmp, "rel"), noBase: true, source: { commit: "00000000", dirty: false } });
const manifestFile = path.join(tmp, "manifest.json");

function stub(faults = {}) {
  const bucket = { "pins/bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e": Buffer.from("pinned") }, seen = [];
  const index = () => adapterIndex(bucket, "");
  const leaves = () => { const out = new Map();
    for (const b of Object.values(bucket)) for (let off = 0; off < b.length || off === 0; off += 262144) { const c = b.subarray(off, off + 262144); out.set(rawCid(c), c); if (!b.length) break; }
    return out; };
  const blockOf = (idx, cid) => idx.nodes.get(cid) ?? leaves().get(cid) ?? null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), body = await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
    seen.push({ method: req.method, path: u.pathname, key: req.headers["x-api-key"] === KEY });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const idx = index();
    if (u.pathname === "/api/status") return json(200, { app: "stub", state: "ready", truncated: !!faults.truncated, error: null, files: idx.files.length });
    if (u.pathname === "/api/files") return json(200, idx.files.map((f) => ({ path: f.rel, size: f.size, cid: faults.wrongCid && f.rel.endsWith("site.css") ? idx.files[0].cid : f.cid })));
    if (u.pathname === "/api/upload" && req.method === "POST") {
      if (req.headers["x-api-key"] !== KEY) return json(403, { error: "bad key" });
      bucket[u.searchParams.get("path")] = body; return json(200, { ok: true });
    }
    const m = /^\/ipfs\/([a-z2-7]+)$/.exec(u.pathname);
    if (m && m[1] === "bafkqaaa") { res.writeHead(faults.probe ?? 200, { "content-type": "application/vnd.ipld.raw" }); return res.end(); }
    if (m && u.searchParams.get("format") === "raw") { const b = blockOf(idx, m[1]); if (!b) return json(404, { error: "not in this gateway's index" }); res.writeHead(200); return res.end(b); }
    if (m && u.searchParams.get("format") === "car") {
      const blocks = new Map([...idx.nodes, ...leaves()]);
      const f = path.join(tmp, `car-${process.hrtime.bigint()}`);
      try { writeCar(f, m[1], blocks); } catch { return json(404, { error: "no such DAG" }); }
      const car = fs.readFileSync(f); fs.rmSync(f);
      res.writeHead(200, { "content-type": "application/vnd.ipld.car; version=1" }); return res.end(faults.dropBlock ? dropSection(car) : car);
    }
    json(404, { error: "no route" });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, bucket, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("plan: the manifest names every file and the model gives the prefix the release CID", () => {
  const mf = plan({ release: rel.dir, out: manifestFile });
  assert.equal(mf.cid, rel.cid); assert.equal(mf.prefix, `sites/${rel.cid}/`);
  assert.equal(mf.files.length, rel.manifest.files.length);
});

test("upload (dry run, then executed, then resumed) and verify: exact hold, complete CAR, byte-identical release; the key never printed", async () => {
  const s = await stub(), lines = [], log = (x) => lines.push(String(x));
  try {
    const dry = await upload({ adapter: s.url, apiKeyEnv: "HOLD_KEY", manifest: manifestFile, release: rel.dir, env: { HOLD_KEY: KEY }, log });
    assert.equal(dry.dryRun, true); assert.equal(s.seen.filter((x) => x.method === "POST").length, 0);
    const r = await upload({ adapter: s.url, apiKeyEnv: "HOLD_KEY", manifest: manifestFile, release: rel.dir, execute: true, env: { HOLD_KEY: KEY }, log });
    assert.equal(r.uploaded, rel.manifest.files.length);
    assert.ok(s.seen.filter((x) => x.method === "POST").every((x) => x.key));
    const again = await upload({ adapter: s.url, apiKeyEnv: "HOLD_KEY", manifest: manifestFile, release: rel.dir, execute: true, env: { HOLD_KEY: KEY }, log });
    assert.equal(again.uploaded, 0, "a re-run uploads nothing");
    const v = await verify({ adapter: s.url, manifest: manifestFile, release: rel.dir, out: path.join(tmp, "fetched-ok") });
    assert.deepEqual(v.failures, []); assert.equal(v.ok, true);
    assert.ok(!lines.join("\n").includes(KEY) && !JSON.stringify(v).includes(KEY));
  } finally { s.server.close(); }
});

test("faults fail: wrong key, foreign object under the prefix, truncated index, wrong CID, probe 400, a block missing from the CAR", async () => {
  const s = await stub();
  try {
    await assert.rejects(upload({ adapter: s.url, apiKeyEnv: "HOLD_KEY", manifest: manifestFile, release: rel.dir, execute: true, env: { HOLD_KEY: "wrong" }, log: () => {} }), /HTTP 403/);
    s.bucket[`sites/${rel.cid}/stray.txt`] = Buffer.from("x");
    await assert.rejects(upload({ adapter: s.url, apiKeyEnv: "HOLD_KEY", manifest: manifestFile, release: rel.dir, execute: true, env: { HOLD_KEY: KEY }, log: () => {} }), /not this release's/);
  } finally { s.server.close(); }
  for (const [fault, re] of [["truncated", /truncated/], ["wrongCid", /index under the prefix differs/], ["probe", /bafkqaaa/], ["dropBlock", /complete CAR from the adapter/]]) {
    const t = await stub(fault === "probe" ? { probe: 400 } : { [fault]: true });
    try {
      const mf = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      for (const f of mf.files) t.bucket[mf.prefix + f.path] = fs.readFileSync(path.join(rel.dir, "site", f.path));
      const v = await verify({ adapter: t.url, manifest: manifestFile, release: rel.dir, out: path.join(tmp, `fetched-${fault}`) });
      assert.equal(v.ok, false, fault); assert.ok(v.failures.some((x) => re.test(x)), `${fault}: ${v.failures}`);
    } finally { t.server.close(); }
  }
});

test("announce-config: only value, ipni.gatewayUrl (and announceAllBlocks) change; identity references stay; refusals hold", () => {
  const id = "0x" + "d9".repeat(32);
  const shown = { id, config: { ipnsKey: "$IPNS_ED25519_SK", api_key: "$API_KEY", value: "/ipfs/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou", ttlSecs: 300,
    ipni: { gatewayUrl: "https://ipfs.enclave.host", publisherUrl: "https://d9798e4c.app.enclave.host", indexers: ["https://cid.contact"], announceAllBlocks: false } } };
  const sf = path.join(tmp, "shown.json"); fs.writeFileSync(sf, JSON.stringify(shown));
  const r = announceConfig({ shown: sf, release: rel.dir, deployment: id, gateway: "https://adapter.example.org", out: path.join(tmp, "ann"), allBlocks: true });
  assert.deepEqual(r.changed, ["ipni.announceAllBlocks", "ipni.gatewayUrl", "value"]);
  const cfg = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.equal(cfg.ipnsKey, "$IPNS_ED25519_SK"); assert.equal(cfg.ipni.publisherUrl, shown.config.ipni.publisherUrl); assert.equal(cfg.value, `/ipfs/${rel.cid}`);
  const noIpni = path.join(tmp, "shown2.json"); fs.writeFileSync(noIpni, JSON.stringify({ id, config: { ...shown.config, ipni: undefined } }));
  assert.throws(() => announceConfig({ shown: noIpni, release: rel.dir, deployment: id, gateway: "https://adapter.example.org", out: path.join(tmp, "ann2") }), /no ipni block/);
  const keyish = path.join(tmp, "shown3.json"); fs.writeFileSync(keyish, JSON.stringify({ id, config: { ...shown.config, ipnsKey: "a".repeat(64) } }));
  assert.throws(() => announceConfig({ shown: keyish, release: rel.dir, deployment: id, gateway: "https://adapter.example.org", out: path.join(tmp, "ann3") }), /ipnsKey must be a \$NAME/);
  assert.throws(() => announceConfig({ shown: sf, release: rel.dir, deployment: id, gateway: "http://adapter.example.org", out: path.join(tmp, "ann4") }), /https origin/);
});
