// M4 on the NucBox hv node (windows/node/hvcert.mjs): the node relays an isolated partition's certificate request to the
// platform certificate service and installs the chain back into the partition, which alone holds the key. Driven end to
// end through the REAL pieces: the manager (server.mjs) over HTTP with the node's own client (isolation-client.mjs), the
// manager's data plane (node-bridge dataPlaneFor), routeFor/openSplice, supervisor-guestcert's ensureGuestCert,
// judge-hv, and apptls.requestCert's real request. Faked: the partition's front (a TLS server holding its own key,
// serving a launcher-signed ABI/2 report, its CSR and the install route), and the certificate service (an HTTP server
// that checks the operator's signature and the CSR's key the way relay/certs.js does, then signs with a throwaway CA;
// its "does this box serve that deployment's owner" answer stands in for B's predicate).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { Manager, startManager, createServer } from "../windows/vbslike/manager/server.mjs";
import { derive } from "../windows/vbslike/manager/derive.mjs";
import { judgeRunning } from "../windows/vbslike/manager/ready.mjs";
import { dataPlaneFor } from "../windows/vbslike/datapath/node-bridge.mjs";
import { canonical, SIGN_DOMAIN } from "../windows/vbslike/verify/judge-hv.mjs";
import { runtimeId, bind2, ABI2 } from "../isolation/contract/runtime.mjs";
import { IsolationManagerClient } from "../windows/node/isolation-client.mjs";
import { createHvCertPass, hvJudge } from "../windows/node/hvcert.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_RS = fs.readFileSync(path.join(HERE, "../windows/vbslike/host/src/contract.rs"), "utf8");
const FORMAT = CONTRACT_RS.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1];
const TIER = CONTRACT_RS.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1];
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
// the production runtime identity (ccadb38a…), so the record, the manager and the node all pin the real id
const RT = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64",
             cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const PIN = Buffer.from(runtimeId(RT)).toString("hex");
const RECORD = { ...v.ok[0].mapping.record, runtimeId: PIN };
const APP = derive({ record: RECORD, component }).appId;
const DEP = "0x" + "4e62e60d" + "c3".repeat(28);
const NAME = `${DEP.slice(2, 10)}.app.enclave.host`;
const VMID = "3f1c0f6e-7a2b-4c3d-8e9f-0a1b2c3d4e5f";
const IMAGE = "ab".repeat(32);
// the self-test a v43+ front states (the monitor's scan at each attestation), and a v42 front's start-time one
const ATTEST_TIME = `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 seccomp=${"d4".repeat(32)} scope=cgroup:/dom1`;
const LEGACY_ST = "exec_pages=allowed wx=clean maps=3 scope=cgroup:/dom1";
const V42 = "0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---- keys: the partition's own, a stranger's, a throwaway CA ------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvcert-"));
const o = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
   "-subj", "/CN=hvcert test CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
for (const k of ["guest", "other"]) {
  o(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${k}.key`]);
  o(["req", "-x509", "-key", `${k}.key`, "-out", `${k}.self.pem`, "-subj", "/CN=self-signed carrier", "-days", "2"]);
  o(["req", "-new", "-key", `${k}.key`, "-out", `${k}.csr`, "-subj", `/CN=${NAME}`, "-addext", `subjectAltName=DNS:${NAME}`]);
}
const rd = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const GUEST = { key: rd("guest.key"), self: rd("guest.self.pem"), csr: rd("guest.csr") };
const GUEST_SPKI = new crypto.X509Certificate(GUEST.self).publicKey.export({ type: "spki", format: "der" });
const OTHER_CSR = rd("other.csr");
function caSign(csrPem, name = NAME) {
  const f = path.join(dir, `r${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(`${f}.csr`, csrPem); fs.writeFileSync(`${f}.ext`, `subjectAltName=DNS:${name}\n`);
  o(["x509", "-req", "-in", `${f}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", `${f}.ext`, "-out", `${f}.pem`]);
  return fs.readFileSync(`${f}.pem`, "utf8") + rd("ca.pem");
}

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });
const listen = async (s) => { await new Promise((r) => s.listen(0, "127.0.0.1", r)); servers.push(s); return s.address().port; };

// ---- the partition's front: its own key, a launcher-signed ABI/2 report, its CSR, and the install route --------------
const launcher = crypto.generateKeyPairSync("ed25519");
const LAUNCHER_KEY = launcher.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
async function front({ csr = GUEST.csr, runtime = RT, selfTest = ATTEST_TIME, image = IMAGE, partition = "hcs-child" } = {}) {
  const f = { installed: null, csrAsked: 0, installs: 0, tamper: false };
  const ctxSelf = tls.createSecureContext({ key: GUEST.key, cert: GUEST.self });
  const s = https.createServer({ key: GUEST.key, cert: GUEST.self,
    SNICallback: (sn, cb) => cb(null, sn === NAME && f.installed ? tls.createSecureContext({ key: GUEST.key, cert: f.installed }) : ctxSelf) },
  (req, res) => {
    const u = new URL(req.url, "https://x");
    const json = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (u.pathname === "/.well-known/enclave-ready") return json(200, { ready: true, appId: APP });
    if (u.pathname === "/.well-known/enclave-attestation") {
      const nonce = Buffer.from(u.searchParams.get("nonce") || "", "hex");
      const report = { format: FORMAT, tier: TIER,
        reportData: Buffer.concat([bind2(GUEST_SPKI, nonce, runtimeId(runtime)), Buffer.from(APP, "hex")]).toString("hex"),
        domain: { appSha256: APP }, partition: { vmId: VMID, guestImageSha256: image }, launcher: { key: LAUNCHER_KEY },
        platform: { hostExcluded: false, partition }, boundary: `tier=T0-hv partition=${partition} host_excluded=no` };
      const signed = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), launcher.privateKey);
      if (f.tamper) signed[0] ^= 1;                              // a report the launcher key does not verify
      const sig = signed.toString("base64");
      return json(200, { format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP, abi: ABI2, runtime,
        runtimeSelfTest: selfTest,
        report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") });
    }
    if (u.pathname === "/.well-known/enclave-csr") { f.csrAsked++; res.writeHead(200, { "content-type": "application/x-pem-file" }); return res.end(csr); }
    if (u.pathname === "/.well-known/enclave-cert" && req.method === "POST") {
      const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
        const chain = Buffer.concat(chunks).toString();
        const leaf = new crypto.X509Certificate(chain);        // the front's F2 rules: its key, its name
        if (sha(leaf.publicKey.export({ type: "spki", format: "der" })) !== sha(GUEST_SPKI) || !leaf.checkHost(NAME)) return json(400, { error: "not ours" });
        f.installed = chain; f.installs++; json(200, { installed: true });
      });
      return;
    }
    json(404, {});
  });
  f.port = await listen(s);
  return f;
}

// ---- the manager, over HTTP, whose backend's domain relay is that front; and its data plane --------------------------
async function managerFor(f) {
  const backend = { supports: {}, backend: "hv", boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
    preflight: async () => ({ ok: true, checks: [] }),
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false,
      boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false }, domainId: 1, guestPort: 40001,
      tcpPort: f.port, image: IMAGE, launcherKey: LAUNCHER_KEY, launcherVmId: VMID }),
    stop: async () => {} };
  const m = new Manager({ runtime: RT, fetchComponent: async () => component, backend,
    judgeReady: (a) => judgeRunning({ ...a, deadlineMs: 10_000, attemptTimeoutMs: 3_000 }) });
  await startManager(m);
  const port = await listen(createServer(m));
  const dp = dataPlaneFor(m);
  const dataPort = await listen(dp.server);
  const r = await m.spawn({ derive: RECORD, name: DEP, isPublic: true, hasSecrets: false });
  await m.judging.get(r.id);
  assert.equal(m.get(r.id).status, "running", m.get(r.id).reason);
  return { m, instance: r.id, client: new IsolationManagerClient({ base: `http://127.0.0.1:${port}`, timeoutMs: 5_000 }),
           dataAddr: `127.0.0.1:${dataPort}` };
}

// ---- the certificate service: the operator's signature, the CSR's key, then B's owner predicate --------------------
const operator = privateKeyToAccount(generatePrivateKey());
const ENDPOINT = "https://api.enclave.host/t/nucbox-k11";
async function certsService({ serves = true, leafName = NAME } = {}) {
  const svc = { asked: 0, issued: 0 };
  const s = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
      const json = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      svc.asked++;
      const b = JSON.parse(Buffer.concat(chunks).toString());
      // the request as relay/certs.js parses it: the CSR's key, the message over what IT parsed, the operator
      const spkiHash = sha(crypto.createPublicKey(Buffer.from(execFileSync("openssl", ["req", "-pubkey", "-noout"], { input: b.csr }))).export({ type: "spki", format: "der" }));
      const msg = `enclave-certs-issue:${b.name}:${b.endpoint}:${spkiHash}:${b.ts}`;
      if (!(await verifyMessage({ address: operator.address, message: msg, signature: b.opSig }))) return json(401, { error: "bad_signature", message: "not the operator's" });
      if (b.endpoint !== ENDPOINT || b.name !== NAME) return json(403, { error: "not_authorized", message: "another name or endpoint" });
      if (!serves) return json(403, { error: "not_authorized", message: "this row does not serve the deployment's owner (B)" });
      svc.issued++;
      json(200, { certPem: caSign(b.csr, leafName), notAfter: new Date(Date.now() + 2 * 86400e3).toISOString(), ca: "test" });
    });
  });
  svc.base = `http://127.0.0.1:${await listen(s)}`;
  return svc;
}

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const records = (instance, over = {}) => new Map([[DEP, { status: "running", isPublic: true, owner: OWNER, isolation: { instance, appId: APP }, ...over }]]);
const passFor = (box, svc, over = {}) => createHvCertPass({ client: box.client, dataAddr: box.dataAddr, runtimeId: PIN, endpoint: ENDPOINT,
  sign: (message) => operator.signMessage({ message }), base: svc.base, served: (o) => o === OWNER, ...over });

// ---- the path ----------------------------------------------------------------------------------------------------
test("a running partition's CSR is issued for ITS key under the operator's signature and installed; it then serves the CA leaf for its name", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService();
  const view = await box.client.get(box.instance);
  assert.equal(view.launcherKey, LAUNCHER_KEY, "the node's client carries the launcher key");
  assert.equal(view.launcherVmId, VMID, "and the partition it signs for");
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  const st = p.state(DEP);
  assert.ok(st && st.serial, `installed: ${JSON.stringify(st)}`);
  assert.equal(st.key, sha(GUEST_SPKI)); assert.equal(st.verdict, "monitor-signed"); assert.equal(st.name, NAME);
  assert.equal(svc.issued, 1); assert.equal(f.installs, 1);
  // what a browser now gets from the partition for the name: the CA leaf, on the partition's own key
  const leaf = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: f.port, servername: NAME, ca: rd("ca.pem") }, () => { resolve(s.getPeerX509Certificate()); s.end(); });
    s.on("error", reject);
  });
  assert.ok(leaf.checkHost(NAME)); assert.equal(sha(leaf.publicKey.export({ type: "spki", format: "der" })), sha(GUEST_SPKI));
  // installed and fresh: the next pass asks nothing
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 1, "nothing is asked again before the renewal point");
});

// ---- the refusals ---------------------------------------------------------------------------------------------------
test("a CSR whose key is not the partition's is refused before anything is issued", async () => {
  const f = await front({ csr: OTHER_CSR }), box = await managerFor(f), svc = await certsService();
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 0, "the service was never asked"); assert.equal(f.installs, 0);
  assert.match(p.state(DEP).why, /CSR is not for the guest's verified key; nothing issued/);
  assert.ok(p.state(DEP).backoffUntil > Date.now());
});

test("nothing is issued while the service's owner predicate (B) does not hold: the stranger's name stays uncertified", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService({ serves: false });
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 1); assert.equal(svc.issued, 0); assert.equal(f.installs, 0);
  assert.match(p.state(DEP).why, /refused .*does not serve the deployment's owner \(B\)/);
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 1, "backed off: not asked again at once");
});

test("a leaf the service issued for another name is not installed", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService({ leafName: "ffffffff.app.enclave.host" });
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  assert.equal(f.installs, 0); assert.match(p.state(DEP).why, new RegExp(`not for ${NAME.replace(/\./g, "\\.")}; not installed`));
});

test("a domain stating another runtime than the node pins is refused; so is a node pinning another runtime than the manager serves", async () => {
  const f = await front({ runtime: { ...RT, version: "48.0.2" } }), svc = await certsService();
  // the manager's own readiness judge already refuses a domain whose runtime is not its pinned one: it never runs
  const backendRun = await managerFor(f).then(() => "running", (e) => e.message);
  assert.notEqual(backendRun, "running");
  const g = await front(), box = await managerFor(g);
  const p = passFor(box, svc, { runtimeId: "ee".repeat(32) });
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 0); assert.match(p.state(DEP).why, /manager serves runtime .* not the pinned/);
});

test("a report whose launcher signature does not verify ('unsigned') issues nothing, though the manager judged the domain running", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService();
  f.tamper = true;
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  assert.equal(svc.asked, 0); assert.equal(f.csrAsked, 0);
  assert.match(p.state(DEP).why, /did not verify \(unsigned: signature does not verify\)/);
});

test("hvJudge refuses a domain stating a runtime other than the pinned one, before judge-hv is asked", async () => {
  const f = await front({ runtime: { ...RT, version: "48.0.2" } }), nonce = crypto.randomBytes(32);
  const doc = await new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port: f.port, path: `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, rejectUnauthorized: false },
      (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve(JSON.parse(b))); }).on("error", reject);
  });
  const view = { launcherKey: LAUNCHER_KEY, launcherVmId: VMID, runtimeId: PIN, image: IMAGE, guestIdentity: null };
  const r = await hvJudge(view, PIN)(doc, GUEST_SPKI, nonce, { appSha: APP });
  assert.equal(r.verdict, "reject"); assert.match(r.reasons[0], /states runtime .* not the pinned/);
});

test("hvJudge: no launcher key, no partition for it, or another partition in the report -> no verdict that issues", async () => {
  const f = await front(), box = await managerFor(f);
  const view = await box.client.get(box.instance);
  const nonce = crypto.randomBytes(32);
  const doc = await new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port: f.port, path: `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, rejectUnauthorized: false },
      (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve(JSON.parse(b))); }).on("error", reject);
  });
  const want = { appSha: APP };
  assert.equal((await hvJudge(view, PIN)(doc, GUEST_SPKI, nonce, want)).verdict, "monitor-signed", "control");
  assert.match((await hvJudge({ ...view, launcherKey: null }, PIN)(doc, GUEST_SPKI, nonce, want)).reasons[0], /no launcher key/);
  assert.match((await hvJudge({ ...view, launcherVmId: null }, PIN)(doc, GUEST_SPKI, nonce, want)).reasons[0], /names no partition/);
  assert.equal((await hvJudge({ ...view, launcherVmId: "9b2d4e6f-1a3c-4e5f-8a9b-0c1d2e3f4a5b" }, PIN)(doc, GUEST_SPKI, nonce, want)).verdict, "reject");
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
  assert.notEqual((await hvJudge({ ...view, launcherKey: other }, PIN)(doc, GUEST_SPKI, nonce, want)).verdict, "monitor-signed", "another launcher key");
});

test("a deployment whose owner this box does NOT serve (a transfer the sweep has not stopped yet) asks nothing; no owner set asks nothing", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService();
  await passFor(box, svc).pass(records(box.instance, { owner: "0x" + "11".repeat(20) }));
  await passFor(box, svc).pass(records(box.instance, { owner: undefined }));
  await passFor(box, svc, { served: undefined }).pass(records(box.instance));
  assert.equal(svc.asked, 0); assert.equal(f.csrAsked, 0, "not even the partition was asked");
  await passFor(box, svc).pass(records(box.instance));
  assert.equal(svc.issued, 1, "control: the served owner's deployment is certified");
});

test("only PUBLIC deployments this box RUNS as a partition are considered: held, private, or no partition asks nothing", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService();
  const p = passFor(box, svc);
  for (const over of [{ status: "held" }, { isPublic: false }, { isolation: null }, { status: "failed" }]) await p.pass(records(box.instance, over));
  assert.equal(svc.asked, 0); assert.equal(f.csrAsked, 0);
});

test("a RELAUNCHED partition (another instance, another key) is not skipped as installed; a deployment gone from the box is forgotten", async () => {
  const f = await front(), box = await managerFor(f), svc = await certsService();
  const p = passFor(box, svc);
  await p.pass(records(box.instance));
  assert.equal(svc.issued, 1); assert.ok(p.state(DEP).renewAt > Date.now());
  // the record now names another instance: the installed state was for the old one, so this pass tries again (and here,
  // where the manager has no such instance, fails closed with nothing asked of the service)
  await p.pass(records("hv" + "0".repeat(32)));
  assert.equal(p.state(DEP).instanceId, "hv" + "0".repeat(32)); assert.ok(p.state(DEP).backoffUntil > Date.now());
  assert.equal(svc.asked, 1);
  await p.pass(new Map());
  assert.equal(p.state(DEP), null);
});

// The runtime's W^X per guest image at the certificate pass (judge-hv LEGACY_WX_IMAGES; enclave-87's v43 ruling): a
// partition of an image the table does not list gets no certificate unless its front states the attest-time scan; v42's
// image, named by the manager's view with its launcher statement, is certified on the legacy form only as UNMEASURED.
test("hvJudge per image: the legacy self-test is certified only for v42's image (as unmeasured), never for another", async () => {
  const { BOOT_STATEMENTS } = await import("../windows/vbslike/verify/boot-statements.mjs");
  const LD = BOOT_STATEMENTS["linux-direct"];
  const docOf = async (f, nonce) => new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port: f.port, path: `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, rejectUnauthorized: false },
      (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve(JSON.parse(b))); }).on("error", reject);
  });
  const want = { appSha: APP }, base = { launcherKey: LAUNCHER_KEY, launcherVmId: VMID, runtimeId: PIN };
  // an unlisted image with no statement (the HCS lab's view): the legacy form is refused
  const f1 = await front({ selfTest: LEGACY_ST }), n1 = crypto.randomBytes(32);
  const r1 = await hvJudge({ ...base, image: IMAGE, guestIdentity: null }, PIN)(await docOf(f1, n1), GUEST_SPKI, n1, want);
  assert.equal(r1.verdict, "reject"); assert.match(r1.reasons.join("; "), /names no runtime coverage/);
  // v42's image under its statement: certified, and said to be unmeasured
  const stated = { partition: LD.partition, guestImageKind: LD.guestImageKind };
  const f2 = await front({ selfTest: LEGACY_ST, image: V42, partition: LD.partition }), n2 = crypto.randomBytes(32);
  const r2 = await hvJudge({ ...base, image: V42, guestIdentity: stated }, PIN)(await docOf(f2, n2), GUEST_SPKI, n2, want);
  assert.equal(r2.verdict, "monitor-signed", r2.reasons.join("; ")); assert.equal(r2.wxCoverage, "runtime-unmeasured");
  // a v43 image under the same statement: refused on the legacy form, certified on the attest-time one
  const f3 = await front({ selfTest: LEGACY_ST, image: IMAGE, partition: LD.partition }), n3 = crypto.randomBytes(32);
  assert.equal((await hvJudge({ ...base, image: IMAGE, guestIdentity: stated }, PIN)(await docOf(f3, n3), GUEST_SPKI, n3, want)).verdict, "reject");
  const f4 = await front({ image: IMAGE, partition: LD.partition }), n4 = crypto.randomBytes(32);
  const r4 = await hvJudge({ ...base, image: IMAGE, guestIdentity: stated }, PIN)(await docOf(f4, n4), GUEST_SPKI, n4, want);
  assert.equal(r4.verdict, "monitor-signed", r4.reasons.join("; ")); assert.equal(r4.wxCoverage, "runtime-covered");
});
