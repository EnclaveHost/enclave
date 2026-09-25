// `enclave attest` with --verifier tinfoil|enclave|both (cli/enclave.mjs), end to end through the real CLI process: a local
// API (http) that answers /v1/attestation with a pinned repo and an attestation endpoint on a local TLS "enclave" that
// serves the authentic Genoa document, the CLI's own TLS connection to it (NODE_EXTRA_CA_CERTS carries the run's CA, so
// nothing turns validation off), release provenance from the v0.5.841 fixture bundles (--release-bundle, offline), and
// AMD collateral from the fixtures through --collateral-dir (KDS rate-limits). The default mode is unchanged:
// Tinfoil alone, no Enclave verdict in the output.
//   run: node --test test/cli-attest-verifier.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { mintLocalCa, serveTls } from "./helpers/local-tls.mjs";
import os from "node:os";
import { RAD_PATH, reportOf } from "../verifier/consumer.mjs";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier");
const CLI = path.join(REPO, "cli", "enclave.mjs");
const rad = JSON.parse(fs.readFileSync(path.join(F, "genoa-tinfoil", "rad.json"), "utf8"));
const BUNDLES = ["v0.5.841", "v0.5.841-cpu"].map((t) => path.join(F, "release", `${t}.attestation.json`)).join(",");
const DIGESTS = ["v0.5.841", "v0.5.841-cpu"].map((t) => fs.readFileSync(path.join(F, "release", `${t}.tinfoil.hash`), "utf8").trim()).join(",");
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
// AMD collateral offline, in the directory layout verifier/collateral.mjs fileCollateral reads (KDS answers 429 after a few requests)
const COL = fs.mkdtempSync(path.join(os.tmpdir(), "cli-col-"));
{ const rep = reportOf(rad); fs.mkdirSync(path.join(COL, "amd")); fs.mkdirSync(path.join(COL, "vcek"));
  fs.copyFileSync(path.join(REPO, "test", "fixtures", "amd", "Genoa-cert_chain.pem"), path.join(COL, "amd", "Genoa-cert_chain.pem"));
  fs.copyFileSync(path.join(F, "amd", "Genoa-crl.der"), path.join(COL, "amd", "Genoa-crl.der"));
  fs.copyFileSync(path.join(F, "genoa-tinfoil", "vcek-kds-amd.der"), path.join(COL, "vcek", `Genoa-${rep.chipHex}-${rep.tcbHex}.der`)); }

let ca, enclave, api, apiPort;
test.before(async () => {
  ca = mintLocalCa();
  enclave = await serveTls(ca, (req, res) => { if (req.url === RAD_PATH) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rad)); } else { res.writeHead(404); res.end(); } });
  api = http.createServer((req, res) => {
    if (req.url === "/v1/attestation") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ verification: { repo: "EnclaveHost/enclave", attestationEndpoint: `https://localhost:${enclave.port}${RAD_PATH}` } })); }
    else if (req.url === "/v1/attestation-other-repo") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ verification: { repo: "Someone/else", attestationEndpoint: `https://localhost:${enclave.port}${RAD_PATH}` } })); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r)); apiPort = api.address().port;
});
test.after(async () => { await enclave.close(); await new Promise((r) => api.close(() => r())); ca.cleanup(); fs.rmSync(COL, { recursive: true, force: true }); });
// spawn, not spawnSync: the servers the CLI talks to live in THIS process, and a synchronous wait would never let them answer
// --json has always exited 0 with the verdict in `pass` (unchanged here); the plain output exits 1 on a failed verdict
const cli = (args, { timeoutMs = 90000, json = true } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, "attest", ...(json ? ["--json"] : []), ...args], { env: { ...env, NODE_EXTRA_CA_CERTS: ca.caFile, ENCLAVE_KEY: "" } });
  let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
  c.on("close", (status, signal) => { clearTimeout(t); let json = null; const i = stdout.indexOf("{"); try { json = i >= 0 ? JSON.parse(stdout.slice(i)) : null; } catch {} resolve({ status, signal, stdout, stderr, json }); });
});
const run = (...args) => cli(["--base", `http://127.0.0.1:${apiPort}`, "--release-bundle", BUNDLES, "--release-digest", DIGESTS, "--collateral-dir", COL, ...args]);
const runText = (...args) => cli(["--base", `http://127.0.0.1:${apiPort}`, "--release-bundle", BUNDLES, "--release-digest", DIGESTS, "--collateral-dir", COL, ...args], { json: false });

test("--verifier enclave: the Enclave verifier alone decides; the Genoa document verifies as bytes but is not a release of ours, so the verdict is rejected on the measurement (pass false; the plain output exits 1), with the expected tags named and no Tinfoil leg run", async () => {
  const r = await run("--verifier", "enclave");
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(r.json, r.stdout);
  assert.equal(r.json.verifier, "enclave"); assert.equal(r.json.tinfoil, null); assert.equal(r.json.pass, false);
  const e = r.json.enclave; assert.equal(e.status, "rejected", JSON.stringify(e.reasons)); assert.deepEqual(e.failedChecks, ["measurement"]);
  assert.deepEqual(e.expected, ["v0.5.841.attestation.json", "v0.5.841-cpu.attestation.json"]); assert.equal(e.release, null); assert.match(e.measurement, /^[0-9a-f]{96}$/);
  assert.equal(e.checks.chain, true); assert.equal(e.checks.signature, true); assert.equal("binding" in e.checks, false, "the measurement refused first; under this policy the binding is never reached (the verifier stops at the first failed check)");
  assert.equal(e.certificate.subject.includes("localhost"), true);
  const t = await runText("--verifier", "enclave");
  assert.equal(t.status, 1, "the plain output exits 1 on a failed verdict"); assert.match(t.stdout, /verifier +enclave \(verifier\/consumer\.mjs\)/); assert.match(t.stdout, /verdict +REJECTED \(enclave\): do not send data/);
  assert.match(t.stdout, /failed +measurement/); assert.doesNotMatch(t.stdout, /verdict +PASS/);
});
test("--verifier both: both verdicts are in the output, the exit code follows Tinfoil's, and the agreement is stated", async () => {
  const r = await run("--verifier", "both");
  assert.equal(r.status, 0, r.stderr); assert.ok(r.json, r.stdout);
  assert.equal(r.json.verifier, "both"); assert.ok(r.json.tinfoil, "the Tinfoil leg ran"); assert.ok(r.json.enclave, "the Enclave leg ran");
  // @tinfoilsh/verifier builds its URL from the hostname alone, so a local enclave on another port is unreachable to it: its leg
  // fails ("Network error"), which is recorded, not fatal, in both mode
  assert.equal(r.json.tinfoil.pass, false); assert.match(r.json.tinfoil.error, /Network error|verifier produced no document/); assert.equal(r.json.enclave.status, "rejected");
  assert.equal(r.json.agreement, "agree-refuse"); assert.equal(r.json.pass, r.json.tinfoil.pass);
  const t = await runText("--verifier", "both");
  assert.equal(t.status, 1); assert.match(t.stdout, /verdict +FAIL: do not send data/); assert.match(t.stdout, /verdict +REJECTED \(enclave\)/); assert.match(t.stdout, /agreement +agree-refuse \(exit code follows the Tinfoil verdict\)/);
});
test("the default (no --verifier) is unchanged: Tinfoil alone, and its thrown verification still ends the command as before; no Enclave verdict anywhere in the output", async () => {
  const r = await run();
  assert.equal(r.status, 1); assert.equal(r.json, null, "the command died before any JSON, as it did before this change");
  assert.match(r.stderr, /verifier produced no document/); assert.doesNotMatch(r.stdout + r.stderr, /consumer\.mjs|\(enclave\)|agreement/);
});
test("--verifier with an unknown mode is refused before anything is fetched", async () => {
  const r = await run("--verifier", "bogus");
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /--verifier must be one of tinfoil, enclave, both/);
});
test("an attestation naming another repo is refused before either verifier runs (the pinned-repo rule is unchanged by the mode)", async () => {
  const other = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ verification: { repo: "Someone/else", attestationEndpoint: `https://localhost:${enclave.port}${RAD_PATH}` } })); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  try {
    for (const mode of ["both", "enclave"]) {
      const r = await cli(["--verifier", mode, "--base", `http://127.0.0.1:${other.address().port}`, "--collateral-dir", COL], { timeoutMs: 30000 });
      assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /only verifies against EnclaveHost\/enclave/);
    }
  } finally { await new Promise((r) => other.close(() => r())); }
});
test("--verifier enclave against an enclave that does not answer: status unavailable, pass false, never a pass", async () => {
  const dead = await serveTls(ca, (req, res) => { res.writeHead(503); res.end(); });
  const port = dead.port; await dead.close();
  const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ verification: { repo: "EnclaveHost/enclave", attestationEndpoint: `https://localhost:${port}${RAD_PATH}` } })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await cli(["--verifier", "enclave", "--base", `http://127.0.0.1:${srv.address().port}`, "--release-bundle", BUNDLES, "--release-digest", DIGESTS, "--collateral-dir", COL], { timeoutMs: 60000 });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.json.enclave.status, "unavailable"); assert.equal(r.json.pass, false); assert.match(r.json.enclave.reasons[0], /^capture: /);
  } finally { await new Promise((r) => srv.close(() => r())); }
});
