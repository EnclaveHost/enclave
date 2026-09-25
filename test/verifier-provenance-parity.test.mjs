// The daily provenance parity check (verifier/provenance-parity.mjs) offline: local stand-ins for GitHub (the real signed
// indexes and release bundles of 2026-09-25), the relay mirror and the site, the legs run for real (the Node consumer, the
// browser module from source, this commit's bundle, and the bundle the stand-in site serves). What it must say: agree when
// every leg verifies the same publication; unknown-artifact when the site serves a bundle this repository never built (and
// it is then NOT executed); not-verified when the mirror serves a refused index or is down; mirror-behind within an hour of
// a newer GitHub publication, mirror-stale after.
//   run: node --test test/verifier-provenance-parity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RI = path.join(REPO, "test", "fixtures", "verifier", "release-index");
const MIRROR = JSON.parse(fs.readFileSync(path.join(RI, "mirror-2026-09-25.json"), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const GPU_IDX = Buffer.from(MIRROR.indexBytes, "base64");
const CPU_IDX = fs.readFileSync(path.join(RI, "v0.5.848-cpu", "release-index.json"));
const CPU_BUNDLE = JSON.parse(fs.readFileSync(path.join(RI, "v0.5.848-cpu", "attestation.json"), "utf8")).attestations[0].bundle;
const BUNDLE_847 = JSON.parse(fs.readFileSync(path.join(RI, "v0.5.847", "attestation.json"), "utf8")).attestations[0].bundle;
const VENDOR = fs.readFileSync(path.join(REPO, "site", "vendor", "enclave-verifier.js"));
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-test-")); test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const world = {};
const reset = (w = {}) => Object.assign(world, { mirror: MIRROR, mirrorStatus: 200, vendor: VENDOR, ghIndex: GPU_IDX, ghBundle: MIRROR.attestation.bundle }, w);
const srv = http.createServer((req, res) => {
  const u = req.url.split("?")[0]; const send = (c, b, t = "application/json") => { res.writeHead(c, { "content-type": t }); res.end(b); };
  if (u === "/v1/release-index") return send(world.mirrorStatus, world.mirrorStatus === 200 ? JSON.stringify(world.mirror) : "{}");
  if (u === "/vendor/enclave-verifier.js") return send(200, world.vendor, "text/javascript");
  if (u === "/EnclaveHost/enclave/releases/latest/download/release-index.json") return send(200, world.ghIndex, "application/octet-stream");
  let m = /^\/EnclaveHost\/enclave\/releases\/download\/([^/]+)\/tinfoil\.hash$/.exec(u);
  if (m) { const r = MIRROR.releases.find((x) => x.tag === m[1]); return r ? send(200, r.digest + "\n", "text/plain") : send(404, "Not Found", "text/plain"); }
  m = /^\/repos\/EnclaveHost\/enclave\/attestations\/sha256:([0-9a-f]{64})$/.exec(u);
  if (m) {
    if (m[1] === sha(world.ghIndex)) return send(200, JSON.stringify({ attestations: [{ bundle: world.ghBundle }] }));
    const r = MIRROR.releases.find((x) => x.digest === m[1]); return r ? send(200, JSON.stringify({ attestations: [{ bundle: r.attestation.bundle }] })) : send(404, "{}");
  }
  send(404, "Not Found", "text/plain");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());
const run = (extra = []) => new Promise((resolve) => {
  const out = fs.mkdtempSync(path.join(tmp, "out-"));
  const ch = spawn(process.execPath, [path.join(REPO, "verifier", "provenance-parity.mjs"), "--out", out, "--mirror", `${BASE}/v1/release-index`, "--site", BASE, "--api-base", BASE, "--download-base", BASE, ...extra], { env });
  let o = ""; ch.stdout.on("data", (d) => (o += d)); ch.stderr.on("data", (d) => (o += d));
  ch.on("close", (code) => { let report = null; try { report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); } catch {} resolve({ status: code, out: o, report }); });
});

test("every leg verifies the same signed publication: agree, exit 0; the served bundle is this commit's artifact and is executed; the digests, releases and floors are equal across legs", async () => {
  reset();
  const r = await run(["--now", "2026-09-25T04:00:00Z"]);
  assert.equal(r.status, 0, r.out); assert.equal(r.report.verdict, "agree");
  assert.deepEqual(Object.keys(r.report.legs), ["github", "mirror", "bundle", "deployed"]);
  for (const [k, v] of Object.entries(r.report.legs)) {
    assert.equal(v.index.status, "verified", k); assert.equal(v.index.digest, MIRROR.indexSha256, k); assert.deepEqual(v.index.publication, { runId: 36089632273, attempt: 1 }, k);
    assert.deepEqual(v.allowed.map((a) => a.tag), ["v0.5.848", "v0.5.848-cpu"], k); assert.equal(v.index.floorApplied, "v0.5.841", k); assert.equal(v.index.floorSource, "signed index", k);
  }
  assert.equal(r.report.deployed.known, "this commit"); assert.equal(r.report.deployed.sha256, sha(VENDOR));
  assert.deepEqual({ samePublication: r.report.comparison.samePublication, mirrorLegsAgree: r.report.comparison.mirrorLegsAgree, githubAgrees: r.report.comparison.githubAgrees }, { samePublication: true, mirrorLegsAgree: true, githubAgrees: true });
});

test("the site serves a bundle this repository never built (one byte changed): unknown-artifact, exit 1, and the bundle is NOT executed", async () => {
  const bad = Buffer.from(VENDOR); bad[bad.length - 2] ^= 0x01;
  reset({ vendor: bad });
  const r = await run(["--now", "2026-09-25T04:00:00Z"]);
  assert.equal(r.status, 1, r.out); assert.equal(r.report.verdict, "unknown-artifact"); assert.equal(r.report.deployed.known, "UNKNOWN");
  assert.match(r.report.legs.deployed.error, /not an artifact this repository built: not executed/); // with full history the tool knows earlier artifacts too; a SHALLOW checkout (the Test workflow's default fetch-depth 1)
  // knows only this commit's, and the report says so rather than passing that off as a foreign bundle
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" }).trim() === "true";
  assert.equal(r.report.deployed.historyShallow, shallow);
  assert.ok(r.report.deployed.knownArtifacts >= (shallow ? 1 : 2), shallow ? "at least this commit's artifact" : "the history holds earlier artifacts too");
  if (shallow) assert.match(r.report.reasons.join(" "), /checkout is shallow/);
});

test("the mirror serves a refused index (v0.5.847's signature over v0.5.848's bytes) or is down: not-verified, exit 1, naming the legs", async () => {
  reset({ mirror: { ...MIRROR, attestation: { bundle: BUNDLE_847 } } });
  let r = await run(["--now", "2026-09-25T04:00:00Z"]);
  assert.equal(r.status, 1, r.out); assert.equal(r.report.verdict, "not-verified"); assert.match(r.report.reasons.join(" "), /mirror: index refused/); assert.equal(r.report.legs.github.index.status, "verified");
  reset({ mirrorStatus: 503 });
  r = await run(["--now", "2026-09-25T04:00:00Z"]);
  assert.equal(r.status, 1); assert.equal(r.report.verdict, "not-verified"); assert.match(r.report.reasons.join(" "), /mirror: index unavailable/);
});

test("the mirror still serves the OLDER signed publication (the CPU run's index) while GitHub has the newer: mirror-behind within an hour of GitHub's (exit 0), mirror-stale after (exit 1); nothing is called a disagreement", async () => {
  // the mirror carries the CPU run's index (run 36089622272) with its own bundle; GitHub serves the GPU run's (36089632273)
  reset({ mirror: { ...MIRROR, indexBytes: CPU_IDX.toString("base64"), indexSha256: sha(CPU_IDX), attestation: { bundle: CPU_BUNDLE } } });
  const a = await run(["--now", "2026-09-25T03:40:00Z"]);
  assert.equal(a.status, 0, a.out); assert.equal(a.report.verdict, "mirror-behind"); assert.equal(a.report.comparison.samePublication, false); assert.equal(a.report.comparison.mirrorLegsAgree, true);
  assert.deepEqual(a.report.legs.mirror.index.publication, { runId: 36089622272, attempt: 1 }); assert.deepEqual(a.report.legs.github.index.publication, { runId: 36089632273, attempt: 1 });
  const b = await run(["--now", "2026-09-25T05:30:00Z"]);
  assert.equal(b.status, 1); assert.equal(b.report.verdict, "mirror-stale"); assert.match(b.report.reasons.join(" "), /GitHub's latest is 36089632273\/1/);
});
