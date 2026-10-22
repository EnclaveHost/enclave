// `enclave attest` (cli/enclave.mjs) end to end through the real CLI process, against a stand-in relay on localhost: the CLI
// draws its own nonce, asks the relay for a FRESH document of the box (GET /v1/enclaves/<box>/attestation?nonce=), and judges
// it with this repository's verifier (verifier/consumer.mjs verifyMetalBox). The stand-in's box signs with the SYNTHETIC
// AMD-shaped chain (test/helpers/snp-synth.mjs), so AMD's pinned root refuses it at the chain: what is asserted here is the
// CLI's plumbing (our nonce reaches the relay and the verdict, a deployment resolves to its box, a Shield host is
// unsupported, an unreachable box is unavailable, every non-pass exits non-zero). The verdict rules themselves are
// test/verifier-metal-box.test.mjs's and the SNP suites'; the live run against metal0 is the production check.
//   run: node --test test/cli-attest-verifier.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { ADVERTISED_RAD_PATH } from "../relay/attestation-paths.mjs";

const REPO = new URL("..", import.meta.url).pathname, CLI = path.join(REPO, "cli", "enclave.mjs");
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
const S = synthChain({}), SP = randomBytes(91), MEAS = "77".repeat(48);
// AMD collateral for the synthetic chain from a directory (verifier/collateral.mjs fileCollateral's layout), so no KDS call
const COL = fs.mkdtempSync(path.join(os.tmpdir(), "cli-col-"));
fs.mkdirSync(path.join(COL, "amd")); fs.mkdirSync(path.join(COL, "vcek"));
fs.writeFileSync(path.join(COL, "amd", "Genoa-cert_chain.pem"), S.chainPem); fs.writeFileSync(path.join(COL, "amd", "Genoa-crl.der"), S.crlDer);
{ const r = synthReport(S, { reportData: Buffer.alloc(64) }); fs.writeFileSync(path.join(COL, "vcek", `Genoa-${r.subarray(0x1a0, 0x1e0).toString("hex")}-${r.subarray(0x180, 0x188).toString("hex")}.der`), S.vcekDer); }

const seen = [];
let api, base;
test.before(async () => {
  api = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); seen.push(u.pathname + u.search);
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/enclaves") return send(200, { enclaves: [{ name: "box1", mode: "snp" }, { name: "phone", mode: "avf" }] });
    const m = /^\/v1\/enclaves\/([A-Za-z0-9_-]+)\/attestation$/.exec(u.pathname);
    if (m && m[1] === "box1") {
      const nonce = Buffer.from(u.searchParams.get("nonce") || "", "hex");
      const body = synthReport(S, { reportData: Buffer.concat([sha(SP, nonce), Buffer.alloc(32)]) }).toString("base64");
      return send(200, { name: "box1", nonce: nonce.toString("hex"), document: { format: "sev-snp-guest-metal-v1", body, transportKey: SP.toString("base64"), name: "box1" }, operatorAllowlist: { source: "test", admittedAtAttach: MEAS, measurements: [MEAS] } });
    }
    if (m) return send(404, { error: "no_box", message: `no attested SEV-SNP box named ${m[1]}` });
    if (u.pathname === "/v1/deployments/dep_metal/attestation") return send(200, { verification: { attestationEndpoint: `${base}/t/box1${ADVERTISED_RAD_PATH}` } });
    if (u.pathname === "/v1/deployments/dep_gone/attestation") return send(200, { verification: { attestationEndpoint: `${base}/t/nobox${ADVERTISED_RAD_PATH}` } });
    if (u.pathname === "/v1/deployments/dep_shield/attestation") return send(409, { error: "shield_tls_only" });
    send(404, { error: "not_found" });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${api.address().port}`;
});
test.after(async () => { await new Promise((r) => api.close(() => r())); fs.rmSync(COL, { recursive: true, force: true }); });
// spawn, not spawnSync: the server the CLI talks to lives in THIS process, and a synchronous wait would never let it answer
const cli = (args, { json = true } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, "attest", ...(json ? ["--json"] : []), "--base", base, "--collateral-dir", COL, ...args], { env: { ...env, ENCLAVE_KEY: "" } });
  let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => c.kill("SIGKILL"), 60000);
  c.on("close", (status) => { clearTimeout(t); let out = null; const i = stdout.indexOf("{"); try { out = i >= 0 ? JSON.parse(stdout.slice(i)) : null; } catch {} resolve({ status, stdout, stderr, json: out }); });
});

test("no id: every attested SEV-SNP box is challenged with OUR nonce; a chain to a root that is not AMD's pin is REJECTED and the command exits 1", async () => {
  seen.length = 0;
  const r = await cli([]);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.ok(r.json, r.stdout + r.stderr);
  assert.equal(r.json.boxes.length, 1, "only the snp box, not the avf one");
  const b = r.json.boxes[0];
  assert.equal(b.subject.name, "box1"); assert.equal(b.status, "rejected", JSON.stringify(b.reasons)); assert.deepEqual(b.failedChecks, ["chain"]);
  const asked = seen.find((p) => p.startsWith("/v1/enclaves/box1/attestation?nonce="));
  assert.ok(asked, seen.join(", ")); assert.equal(new URL(asked, "http://x").searchParams.get("nonce"), b.nonce, "the nonce the relay saw is the verdict's");
  assert.equal(b.transportKeySha256, sha(SP).toString("hex"));
  assert.equal(b.expected.source, "operator allowlist (the relay's METAL_ALLOWED_MEASUREMENTS)");
});
test("--expect pins the measurement (a malformed pin is refused), and the plain output never says PASS for a refused box", async () => {
  const r = await cli(["--expect", MEAS]);
  assert.equal(r.status, 1); assert.equal(r.json.boxes[0].expected.source, "--expect");
  const bad = await cli(["--expect", "abc"]);
  assert.notEqual(bad.status, 0); assert.match(bad.stdout + bad.stderr, /96 hex characters/);
  const t = await cli([], { json: false });
  assert.equal(t.status, 1); assert.match(t.stdout, /REJECTED/); assert.doesNotMatch(t.stdout, /verdict +PASS/);
});
test("a deployment resolves to the box it runs on; a Shield host is UNSUPPORTED and a vanished box UNAVAILABLE, both exit non-zero", async () => {
  seen.length = 0;
  const m = await cli(["dep_metal"]);
  assert.equal(m.status, 1); assert.equal(m.json.box, "box1"); assert.equal(m.json.status, "rejected");
  assert.ok(seen.some((p) => p.startsWith("/v1/enclaves/box1/attestation?nonce=")));
  const s = await cli(["dep_shield"]);
  assert.equal(s.status, 1); assert.equal(s.json.status, "unsupported"); assert.match(s.json.reason, /Enclave Shield/);
  const g = await cli(["dep_gone"]);
  assert.equal(g.status, 1); assert.equal(g.json.status, "unavailable"); assert.match(g.json.reasons[0], /HTTP 404/);
});
