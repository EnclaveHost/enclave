// Main's lease-relay HOST ROLE (network/host-services/lease-relay-host.mjs, unchanged) holding a MOVED key, as
// warden-activate.sh leaves it: relay.key + relay-send.json copied in, relay.address written by root.
//   - render-host-relay-config.mjs: the template + a relay.env -> a configuration the role's own validation accepts;
//   - the template's registered endpoint is metal0's registry id (the gate judges THAT host);
//   - `init` KEEPS a moved key when relay.address is present (and refuses to guess when it is absent); the plan hands the
//     relay the moved journal and key as paths;
//   - REAL: the package built from main (../package, pinned) run by runHostRelay (stub gate: admit) on a local anvil behind
//     https RPC proxies answers /v1/info as the MOVED key's address - and still does when relay.address names another
//     address, which is why warden-activate.sh checks the running relay, not the label. Fixture keys only.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), WS = path.resolve(HERE, ".."), MAIN = path.resolve(WS, "../enclave");
const imp = (p) => import(pathToFileURL(path.join(MAIN, p)).href);
const { initRelayKey, planHostRelay, runHostRelay, validateHostRelayConfig } = await imp("network/host-services/lease-relay-host.mjs");
const { hostIdOfEndpoint } = await imp("network/host-service-gate.mjs");
const { startWorld, haveAnvil } = await imp("test/helpers/lease-gas-world.mjs");
const { privateKeyToAccount } = await imp("node_modules/viem/_esm/accounts/index.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const T = { skip: !haveAnvil && "needs anvil", timeout: 240_000 };
const PKG = path.join(WS, "package"), PIN = "sha256:" + sha(fs.readFileSync(path.join(PKG, "lease-relay.package.json")));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eu-host-role-"));
const servers = [];
let W, rpcs, ca, record, digest;
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } W?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function tlsProxy(target) {
  const server = https.createServer({ key: fs.readFileSync(path.join(tmp, "leaf.key")), cert: fs.readFileSync(path.join(tmp, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const up = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(chunks)); }); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); servers.push(server);
  return `https://127.0.0.1:${server.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const stubGate = () => ({ check: async () => {}, serviceRefusal: () => null, start() {}, stop() {}, status: () => ({ platformHostPolicy: "stub: admitted" }) });
async function info(port) {
  const end = Date.now() + 60_000;
  for (;;) { try { const r = await fetch(`http://127.0.0.1:${port}/v1/info`); if (r.ok) return await r.json(); } catch {} if (Date.now() > end) throw new Error("the relay never answered"); await new Promise((ok) => setTimeout(ok, 200)); }
}

before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(tmp, "ca.key"), "-out", path.join(tmp, "ca.pem"), "-days", "2", "-subj", "/CN=eu-host-role-test-ca"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(tmp, "leaf.key"), "-out", path.join(tmp, "leaf.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(tmp, "leaf.csr"), "-CA", path.join(tmp, "ca.pem"), "-CAkey", path.join(tmp, "ca.key"), "-CAcreateserial", "-out", path.join(tmp, "leaf.pem"), "-days", "2", "-extfile", path.join(tmp, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(tmp, "ca.pem");
  rpcs = [await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl)];
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  record = path.join(tmp, "deployment.json"); fs.writeFileSync(record, bytes); digest = "sha256:" + sha(bytes);
  await W.fund(ADDR, 10n ** 16n);
});

const template = () => JSON.parse(fs.readFileSync(path.join(WS, "config/host-relay.template.json"), "utf8"));
function render(envText, { sha: pinned } = {}) {
  const envFile = path.join(tmp, `relay-${Math.random()}.env`), out = path.join(tmp, `host-relay-${Math.random()}.json`);
  fs.writeFileSync(envFile, envText);
  const r = spawnSync(process.execPath, [path.join(WS, "root/render-host-relay-config.mjs"), envFile, out, "--repo", MAIN], { encoding: "utf8",
    env: { PATH: process.env.PATH, RENDER_TEST_ENV_SHA256: pinned ?? sha(Buffer.from(envText)) } });
  return { code: r.status, out: r.stdout + r.stderr, file: out };
}
const ENV = ["LEASE_RELAY_RECORD=/etc/enclave-lease-relay/deployment.json", `LEASE_RELAY_DIGEST=${template().relay.digest}`,
  "LEASE_RELAY_RPCS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example", "LEASE_RELAY_QUORUM=2",
  "LEASE_RELAY_MAX_FLOAT_ETH=0.002", "LEASE_RELAY_MIN_FLOAT_ETH=0.0002", "LEASE_RELAY_LISTEN=127.0.0.1:8549", ""].join("\n");

test("render: the template + relay.env's four public settings -> a configuration main's validateHostRelayConfig accepts; create-only; refusals", () => {
  const r = render(ENV); assert.equal(r.code, 0, r.out); assert.match(r.out, /TEST: relay\.env pin overridden/);
  const cfg = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.deepEqual(cfg.relay.rpc, ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"]);
  assert.deepEqual([cfg.relay.quorum, cfg.relay.maxFloatEth, cfg.relay.minFloatEth, cfg.relay.package], [2, "0.002", "0.0002", PIN]);
  assert.doesNotThrow(() => validateHostRelayConfig(cfg));
  const { relay: _r, ...rest } = cfg, { relay: _t, ...trest } = template(); assert.deepEqual(rest, trest, "everything else is the template's");
  assert.equal(JSON.parse(r.out.trim().split("\n").at(-1)).sha256, sha(fs.readFileSync(r.file)));
  const envFile = path.join(tmp, "again.env"); fs.writeFileSync(envFile, ENV);
  const again = spawnSync(process.execPath, [path.join(WS, "root/render-host-relay-config.mjs"), envFile, r.file, "--repo", MAIN], { encoding: "utf8",
    env: { PATH: process.env.PATH, RENDER_TEST_ENV_SHA256: sha(Buffer.from(ENV)) } });
  assert.equal(again.status, 1); assert.match(again.stderr, /exists \(never overwritten\)/);
  assert.match(render(ENV, { sha: "00".repeat(32) }).out, /not the reviewed relay\.env/);
  assert.match(render(ENV.replace(/LEASE_RELAY_DIGEST=.*/, "LEASE_RELAY_DIGEST=sha256:" + "ab".repeat(32))).out, /not the template's reviewed record digest/);
  assert.match(render(ENV.replace("LEASE_RELAY_QUORUM=2", "LEASE_RELAY_QUORUM=1")).out, /quorum: a strict majority/);
  assert.match(render(ENV + "LEASE_RELAY_QUORUM=3\n").out, /exactly once/);
  // production pins the reviewed relay.env bytes (eu-central's, CAS-checked by eu-source-stop.sh)
  assert.match(fs.readFileSync(path.join(WS, "root/render-host-relay-config.mjs"), "utf8"), /const ENV_SHA = "7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769"/);
});

test("the template's registered endpoint IS metal0's registry id (the platform host policy gate judges that host)", () => {
  const enrollment = JSON.parse(fs.readFileSync(path.resolve(WS, "../../outputs/metal0-production-owner-enrollment/transactions.json"), "utf8"));
  assert.equal(template().host.endpoint, enrollment.observation.endpoint);
  assert.equal(hostIdOfEndpoint(template().host.endpoint), enrollment.observation.hostId.toLowerCase());
});

function movedState(name, { key, label, journal = "{}" }) {
  const t = template(), stateRoot = path.join(tmp, name), dir = path.join(stateRoot, "lease-relay");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (key) fs.writeFileSync(path.join(dir, "relay.key"), key.slice(2) + "\n", { mode: 0o600 });
  if (label) fs.writeFileSync(path.join(dir, "relay.address"), label + "\n");
  fs.writeFileSync(path.join(dir, "relay-send.json"), journal, { mode: 0o600 });
  return { dir, cfg: { ...t, platformHostPolicyCarriers: { importDir: path.join(tmp, "import") }, packagesDir: PKG, stateRoot,
    relay: { ...t.relay, record: record || path.join(WS, "config/lease-gas-deployment.json"), digest: digest || t.relay.digest, rpc: rpcs || ["https://rpc-a.example", "https://rpc-b.example"],
      quorum: 2, maxFloatEth: "0.02", minFloatEth: "0.001", ...(ca ? { extraCaFile: ca } : {}) } } };
}
const KEY = "0x" + "5a".repeat(32), ADDR = privateKeyToAccount(KEY).address;

test("init KEEPS a moved key when relay.address is present, refuses to guess without it; the plan hands the moved key and journal as paths", async () => {
  const pending = JSON.stringify({ nonce: 3, raw: "0x02f86b82210503", hash: "0x" + "ab".repeat(32) });
  const m = movedState("keep", { key: KEY, label: ADDR, journal: pending });
  const before = sha(fs.readFileSync(path.join(m.dir, "relay.key")));
  assert.deepEqual(await initRelayKey(m.cfg), { created: false, address: ADDR });
  assert.equal(sha(fs.readFileSync(path.join(m.dir, "relay.key"))), before, "the moved key is unchanged");
  const p = planHostRelay(m.cfg);
  assert.equal(p.env.LEASE_RELAY_KEY_FILE, path.join(m.dir, "relay.key")); assert.equal(p.env.LEASE_RELAY_STATE, path.join(m.dir, "relay-send.json"));
  assert.equal(fs.readFileSync(p.env.LEASE_RELAY_STATE, "utf8"), pending, "the moved journal is the one the relay gets");
  assert.equal(p.bundleSha256, JSON.parse(fs.readFileSync(path.join(PKG, "lease-relay.package.json"), "utf8")).bundleSha256);
  assert.ok(!Object.values(p.env).some((v) => String(v).includes("5a5a5a")), "the key reaches the relay only as a path");
  const bare = movedState("bare", { key: KEY });
  await assert.rejects(initRelayKey(bare.cfg), /exists without its public address file: settle by hand/);
  const empty = movedState("empty", {});
  const made = await initRelayKey(empty.cfg); assert.equal(made.created, true, "an EMPTY directory gets a fresh key: why the unit is not installed before the transfer");
});

test("REAL package from main: the role serves as the MOVED key's address; a wrong relay.address label does not change what it serves", T, async () => {
  for (const [name, label] of [["moved", ADDR], ["mislabelled", "0x" + "11".repeat(20)]]) {
    const m = movedState(name, { key: KEY, label });
    m.cfg.relay.port = await freePort();
    const logs = [];
    const running = await runHostRelay(m.cfg, { gate: stubGate(), log: (l) => logs.push(l), intervalMs: 1000 });
    try {
      const i = await info(m.cfg.relay.port).catch((e) => { throw new Error(`${e.message}\n${logs.join("\n")}`); });
      assert.equal(i.payee, ADDR, `${name}: /v1/info is the key's own address`);
      assert.deepEqual([i.chainId, i.reserve, i.executor], [8453, W.addr.reserve, W.addr.executor]);
      assert.equal(running.payee, label, `${name}: the supervisor's payee is only the relay.address label`);
      assert.ok(logs.some((l) => /\[lease-relay\] \[relay\] serving reserve/.test(l)), "the pinned package's relay is serving");
      assert.equal(fs.readFileSync(path.join(m.dir, "relay-send.json"), "utf8"), "{}", "the moved journal is the one in use");
    } finally { await running.stop(); }
  }
});
