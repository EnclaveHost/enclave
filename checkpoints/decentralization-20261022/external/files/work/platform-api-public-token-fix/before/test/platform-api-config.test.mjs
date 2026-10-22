// The platformApi member of the measured control guest (metal/guest/measured-control.mjs): strict, canonical, bound like
// every other field; absent, NOTHING changes (config bytes, digest, statement, services); the launch, the statement's
// handoff key, and the front's host and prefix routes.
//   run: node --test --test-concurrency=1 test/platform-api-config.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import * as MC from "../metal/guest/measured-control.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-config-"));
const servers = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
const BASE = () => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189"], storagePlan: null },
  identity: { publicUrl: "https://host-1.example.org", repo: "owner/enclave", operator: a(0xb1) },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444 });
const PA = () => ({ apiPort: 8098, peerPort: 8099, hostname: "api.enclave.host",
  members: [0, 1, 2].map((i) => ({ operator: a(0xb0 + i), publicUrl: `https://host-${i}.example.org`, controlUrl: `https://198.51.100.${10 + i}:8444` })),
  measurements: ["77".repeat(48)], minTcb: null, admins: [a(0xad)], recovery: ["11".repeat(32)], archives: ["https://archive.example"], archiveMs: 30000,
  relayEnv: { ADDRESS_BOOK_ADDRESS: "0xab214342d5a490150a4a977063a2f88e21f80907", SIWE_DOMAIN: "enclave.host", SIWE_URI: "https://enclave.host" }, leaseMs: 10000 });

test("absent: a config without platformApi keeps its exact canonical bytes and digest, and plans no role", async () => {
  const c = MC.canonicalDirectConfig(BASE());
  assert.equal(Object.hasOwn(c, "platformApi"), false);
  assert.equal(MC.configDigest(c), MC.configDigest(MC.canonicalDirectConfig(JSON.parse(JSON.stringify(BASE())))));
  assert.equal(MC.directPlatformApiLaunch(c), null);
  const withPa = MC.canonicalDirectConfig({ ...BASE(), platformApi: PA() });
  assert.notEqual(MC.configDigest(withPa), MC.configDigest(c), "the member is bound: HOST_DATA changes with it");
});

test("strict: every field required, 3-7 distinct members, secret-shaped relayEnv names refused, role-owned names refused, ports checked", () => {
  const refuse = (mut, re) => { const pa = PA(); mut(pa); assert.throws(() => MC.canonicalDirectConfig({ ...BASE(), platformApi: pa }), re); };
  refuse((p) => { delete p.leaseMs; }, /missing: leaseMs/);
  refuse((p) => { p.extra = 1; }, /unknown field/);
  refuse((p) => { p.members = p.members.slice(0, 2); }, /3 to 7 hosts/);
  refuse((p) => { p.members[1].operator = p.members[0].operator; }, /repeat a operator/);
  refuse((p) => { p.members[0].controlUrl = "http://198.51.100.10:8444"; }, /https origin/);
  for (const name of ["STRIPE_SECRET_KEY", "SECRETS_KEY", "SESSIONS_RELAYER_KEY", "BILLING_ADMIN_TOKEN", "ACME_EAB_HMAC", "SECRETS_RELEASE_PREDICT_SEED", "PROVISIONER_PRIVATE_KEY"])
    refuse((p) => { p.relayEnv[name] = "x"; }, /looks like a secret/);
  for (const name of ["AUTH_DATA_DIR", "API_RELAY_PORT", "NODE_OPTIONS"]) refuse((p) => { p.relayEnv[name] = "x"; }, /set by the role/);
  refuse((p) => { p.apiPort = 8443; }, /another guest service/);
  refuse((p) => { p.peerPort = p.apiPort; }, /must differ/);
  refuse((p) => { p.measurements = ["77"]; }, /96-hex/);
  refuse((p) => { p.admins = []; }, /1 to 5 nonzero addresses/);
  refuse((p) => { p.archives = ["http://archive.example"]; }, /literal IPv4/);
  refuse((p) => { p.hostname = "API.example"; }, /lowercase DNS name/);
  // a non-secret name that merely contains "KEY" inside a word passes (PASSKEY is not KEY)
  const ok = PA(); ok.relayEnv.PASSKEY_RP_NAME = "Enclave";
  assert.equal(MC.canonicalDirectConfig({ ...BASE(), platformApi: ok }).platformApi.relayEnv.PASSKEY_RP_NAME, "Enclave");
});

test("launch: a member gets the role file, argv and routes; a host that is not a member is REFUSED at boot planning", async () => {
  const P = { ...MC.GUEST_PATHS, platformApiConfig: path.join(tmp, "pa.json"), platformApiDir: path.join(tmp, "pa"), statement: path.join(tmp, "st.json"), platformApiHandoffKey: path.join(tmp, "hk") };
  const c = MC.canonicalDirectConfig({ ...BASE(), platformApi: PA() });
  const l = MC.directPlatformApiLaunch(c, { paths: P });
  const role = JSON.parse(l.files[P.platformApiConfig]);
  assert.equal(role.self, 1); assert.equal(role.format, "enclave-platform-api-role/v1");
  assert.deepEqual(role.platformApi, c.platformApi);
  assert.deepEqual(l.argv, ["/usr/local/bin/node", MC.PLATFORM_API_BUNDLE, "--config", P.platformApiConfig]);
  assert.deepEqual(l.hostRoute, { host: "api.enclave.host", upstream: { host: "127.0.0.1", port: 8098 } });
  assert.deepEqual(l.prefixRoute, { prefix: "/platform-api/", upstream: { host: "127.0.0.1", port: 8099 } });
  const stranger = MC.canonicalDirectConfig({ ...BASE(), identity: { ...BASE().identity, operator: a(0xee) }, platformApi: PA() });
  assert.match(MC.directPlatformApiLaunch(stranger, { paths: P }).refused, /not one of the group's members/);
});

test("statement: the handoff key and bundle hash appear ONLY for a platformApi guest; other statements keep their exact bytes; the parser accepts both", () => {
  const P = { ...MC.GUEST_PATHS, sessionDir: path.join(tmp, "s"), tlsKey: path.join(tmp, "k.pem"), tlsCert: path.join(tmp, "c.pem"), platformApiHandoffKey: path.join(tmp, "hk2") };
  const keys = MC.mintControlKeys({ paths: P });
  const c = MC.canonicalDirectConfig(BASE()), d = MC.configDigest(c), h = MC.hostDataHex(d);
  const plain = MC.controlStatement({ config: c, digest: d, hostData: h, mode: "snp", keys, bootId: "aa".repeat(16) });
  assert.equal(plain.text.includes("platformApi"), false);
  MC.parseStatement(plain.text);
  const pub = MC.mintPlatformApiKey({ paths: P });
  assert.match(pub, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(P.platformApiHandoffKey).mode & 0o777, 0o600);
  const withKey = MC.controlStatement({ config: c, digest: d, hostData: h, mode: "snp", keys: { ...keys, platformApi: { publicKey: pub } }, runtime: { platformApiSha256: "cd".repeat(32) }, bootId: "aa".repeat(16) });
  const o = MC.parseStatement(withKey.text);
  assert.equal(o.keys.platformApi.publicKey, pub); assert.equal(o.runtime.platformApiSha256, "cd".repeat(32));
  const bad = JSON.parse(withKey.text); bad.keys.platformApi.publicKey = "zz";
  assert.throws(() => MC.parseStatement(MC.canonicalJson(bad)), /platform API key malformed/);
});

test("front: Host = the API name goes to the role's API port (upgrades too), /platform-api/* to its peer port, everything else to the supervisor; other upgrades refused", async () => {
  const P = { ...MC.GUEST_PATHS, sessionDir: path.join(tmp, "s2"), tlsKey: path.join(tmp, "k2.pem"), tlsCert: path.join(tmp, "c2.pem") };
  const keys = MC.mintControlKeys({ paths: P });
  const c = MC.canonicalDirectConfig(BASE()), d = MC.configDigest(c);
  const st = MC.controlStatement({ config: c, digest: d, hostData: MC.hostDataHex(d), mode: "dev", keys });
  const echo = (who) => { const s = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ who, path: req.url, host: req.headers.host })); });
    s.on("upgrade", (req, socket) => { socket.end(`HTTP/1.1 101 Switching Protocols\r\nx-who: ${who}\r\n\r\n`); });
    servers.push(s); return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port))); };
  const sup = await echo("supervisor"), api = await echo("api"), peer = await echo("peer");
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, "utf8"), certPem: keys.controlTls.certPem, reporter: null, mode: "dev",
    upstream: { host: "127.0.0.1", port: sup }, hostRoutes: [{ host: "api.enclave.host", upstream: { host: "127.0.0.1", port: api } }],
    prefixRoutes: [{ prefix: "/platform-api/", upstream: { host: "127.0.0.1", port: peer } }] });
  servers.push(front); await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const port = front.address().port;
  const get = (p, host) => new Promise((ok, no) => https.get({ host: "127.0.0.1", port, path: p, rejectUnauthorized: false, headers: host ? { host } : {} }, (res) => {
    const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => ok(JSON.parse(Buffer.concat(c).toString()))); }).on("error", no));
  assert.deepEqual(await get("/v1/account/me", "api.enclave.host"), { who: "api", path: "/v1/account/me", host: "api.enclave.host" });
  assert.equal((await get("/v1/account/me", "api.enclave.host:443")).who, "api", "a port in the Host header is not another name");
  assert.equal((await get("/platform-api/status")).who, "peer");
  assert.equal((await get("/v1/health")).who, "supervisor");
  assert.equal((await get("/platform-apix/status")).who, "supervisor", "a prefix is a whole path segment");
  const upgrade = (host) => new Promise((ok) => {
    const s = (net.connect(port, "127.0.0.1"));
    const tls = (require_tls()).connect({ socket: s, rejectUnauthorized: false }, () => tls.write(`GET /v1/fleet-tunnel HTTP/1.1\r\nhost: ${host}\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`));
    let b = ""; tls.on("data", (x) => { b += x; if (b.includes("\r\n\r\n")) { tls.destroy(); ok(b.split("\r\n")[0] + " " + (/x-who: (\w+)/.exec(b)?.[1] || "")); } });
    tls.on("error", () => ok("error"));
  });
  assert.equal(await upgrade("api.enclave.host"), "HTTP/1.1 101 Switching Protocols api");
  assert.match(await upgrade("other.example"), /^HTTP\/1.1 404/);
});
import tlsMod from "node:tls";
const require_tls = () => tlsMod;
