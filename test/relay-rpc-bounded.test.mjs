// The agreeing-RPC reads are BOUNDED (enclave-87, 09-26): a 60 s /v1/expected-guest at 07:34Z was most likely the confirmed
// ledger read - two providers, 6 s each, viem's default 3 retries (~25 s per read) - with nothing logging which step was slow.
// Now one retry (a read is ~12 s at most per provider) and a step over 5 s names itself in the journal. The relay itself runs
// here, with its catalog RPCs pointed at two local HTTPS providers that accept every request and NEVER answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { bootApiRelay } from "./helpers/daemon.mjs";

const RELAY_DIR = path.resolve(import.meta.dirname, "../relay");
let haveOpenssl = true; try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { haveOpenssl = false; }

// a provider that completes TLS, reads the JSON-RPC request and never answers (a stalled or rate-limiting RPC)
async function silentProvider(dir, n) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(dir, `k${n}.pem`), "-out", path.join(dir, `c${n}.pem`)], { stdio: "ignore" });
  const hits = []; const held = new Set();
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, `k${n}.pem`)), cert: fs.readFileSync(path.join(dir, `c${n}.pem`)) },
    (req, res) => { hits.push(Date.now()); held.add(res); req.resume(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `https://127.0.0.1:${srv.address().port}`, ca: path.join(dir, `c${n}.pem`), hits,
           close: () => { for (const r of held) { try { r.socket.destroy(); } catch {} } srv.close(); } };
}

test("a confirmed ledger read against providers that never answer is BOUNDED (one retry: ~12 s, not ~25 s), refused 503 ledger_unconfirmed, and the slow step is named in the journal",
     { skip: !haveOpenssl && "openssl not installed", timeout: 90_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-bounded-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = await silentProvider(dir, 1), b = await silentProvider(dir, 2); t.after(() => { a.close(); b.close(); });
  fs.writeFileSync(path.join(dir, "ca.pem"), fs.readFileSync(a.ca) + fs.readFileSync(b.ca));
  const REL = "ab".repeat(32), ID = "0x" + "cd".repeat(32);
  // the predictor CONFIGURED (its checks are about configuration; nothing here can run it) so the request reaches the ledger read
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: path.join(dir, "ca.pem"), ENCLAVES: "http://127.0.0.1:1", API_RELAY_BIND: "127.0.0.1",
    BASE_RPC: "http://127.0.0.1:1", RPC_FALLBACKS: "0", REGISTRY_ADDRESS: "0x" + "11".repeat(20), DEPLOYMENTS_ADDRESS: "0x" + "22".repeat(20),
    FEATURED_VIEWS_FILE: path.join(dir, "views.json"), AVAIL_POLL_SEC: "3600", RELEASE_PREWARM_SEC: "0",
    SECRETS_RELEASE_CATALOG_RPCS: `${a.url},${b.url}`, SECRETS_RELEASE_PREDICT_COMMIT: "0".repeat(40), SECRETS_RELEASE_PREDICT_REPO: path.join(dir, "no-repo"),
    SECRETS_RELEASE_PREDICT_GATEWAY: "https://127.0.0.1:1", SECRETS_RELEASE_SEV_SNP_MEASURE: path.join(dir, "no-tool"), SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256: "0".repeat(64),
    SECRETS_RELEASE_PREDICT_WORK: path.join(dir, "work"), SECRETS_RELEASE_PREDICT_RELEASES: `${REL}=${path.join(dir, "no-release")}`, SECRETS_RELEASE_DOMAIN_RELEASES: REL };
  const boot = await bootApiRelay((port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], { env: { ...env, API_RELAY_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] }));
  t.after(() => boot.child.kill("SIGKILL"));
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${boot.port}/v1/expected-guest?id=${ID}`, { signal: AbortSignal.timeout(60_000) });
  const ms = Date.now() - t0, body = await r.json();
  assert.equal(r.status, 503, JSON.stringify(body)); assert.equal(body.error, "ledger_unconfirmed");
  assert.ok(ms >= 11_000 && ms < 16_000, `bounded at one retry: 2 attempts x 6 s (took ${ms} ms; viem's default 4 attempts would be ~25 s)`);
  assert.equal(a.hits.length, 2, "each provider was asked exactly twice (one retry)"); assert.equal(b.hits.length, 2);
  await new Promise((res) => setTimeout(res, 300));
  const slow = boot.log().match(/\[secrets-release\] slow expected-guest 0xcdcdcdcd: the confirmed ledger read took \d+\.\d s/g) || [];
  assert.equal(slow.length, 1, `the slow step named once in the journal:\n${boot.log().slice(-800)}`);
});
