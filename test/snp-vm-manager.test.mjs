// rpc/snp/vm-manager.mjs: the host manager that lets a fleet host's supervisor run a whole-VM SEV-SNP app (catalog
// runtime "sev-snp-vm", Enclave RPC) like any other app, over guestd's /vms contract and guestd-control/1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SnpVmManager, idFor, parsePlan, launchConfigFor, validateConfig, serve, appNameFor, operatorSigner } from "../rpc/snp/vm-manager.mjs";
import { issueMessage } from "../relay/certs.js";
import { recoverOp } from "../relay/fleet-auth.js";
import { GuestdControl } from "../isolation/m4/guestd/control-client.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const DEP = "0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f";
const M = "220e5ec0" + "ab".repeat(44);
const CMDLINE = "root=/dev/mapper/vroot ro enclave.roothash=" + "3d".repeat(32) + " console=ttyS0";
const OVMF = Buffer.from("ovmf bytes");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snpvm-"));
  const image = path.join(dir, "image");
  fs.mkdirSync(image);
  fs.writeFileSync(path.join(image, "IMAGE.json"), JSON.stringify({ rootHash: "3d".repeat(32), cmdline: CMDLINE }));
  fs.writeFileSync(path.join(dir, "ovmf.fd"), OVMF);
  const cfg = { listen: "127.0.0.1:0", stateDir: path.join(dir, "state"), bindings: { [DEP]: {
    image, run: path.join(dir, "run"), unit: "enclave-rpc-snp-guest", cpus: 8, ovmf: path.join(dir, "ovmf.fd"),
    attestOrigin: "https://127.0.0.1:18443", hostfwd: [[18443, 8443]],
    disks: [{ path: path.join(dir, "l1.qcow2"), serial: "RPC-l1", discard: true }, { path: path.join(dir, "base.qcow2"), serial: "RPC-base", cache: "writeback", discard: true }] } } };
  return { dir, cfg };
}
const plan = (over = {}) => ({ appRef: "catalog://0x0f62858500000000000000000000000000000000000000000000000000ebb537/3", vcpus: 8, memMiB: 65536,
  measurements: [M], vcpuType: "EPYC-v4", image: { rootHash: "3d".repeat(32), ovmfSha256: sha(OVMF), cmdlineSha256: sha(Buffer.from(CMDLINE)) }, ...over });

function fakeHost() {
  const active = new Set(), calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "systemctl" && args[1] === "is-active") return { code: active.has(args[3]) ? 0 : 3, stdout: "", stderr: "" };
    if (cmd === "systemctl" && args[1] === "stop") { active.delete(args[2]); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "systemd-run") { active.add(args.find((a) => a.startsWith("--unit=")).slice(7) + ".service"); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { active, calls, exec };
}

test("plan: strict fields, measured vCPU type, 48-byte measurements", () => {
  assert.equal(parsePlan(plan()).vcpus, 8);
  assert.throws(() => parsePlan({ ...plan(), extra: 1 }), /unknown snpVm plan field/);
  assert.throws(() => parsePlan(plan({ vcpuType: "host" })), /EPYC-v4/);
  assert.throws(() => parsePlan(plan({ measurements: ["ab"] })), /48-byte/);
  assert.throws(() => parsePlan(plan({ image: { rootHash: "x" } })), /rootHash/);
});

test("the bound image must match the version's root hash, cmdline, OVMF and vCPUs", () => {
  const { cfg } = fixture();
  const b = cfg.bindings[DEP];
  const c = launchConfigFor(DEP, b, parsePlan(plan()));
  assert.deepEqual([c.cpus, c.memoryMiB, c.hostData, c.hostfwd], [8, 65536, DEP.slice(2), [[18443, 8443]]]);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, rootHash: "ee".repeat(32) } }))), /root hash/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, cmdlineSha256: "ee".repeat(32) } }))), /cmdline/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, ovmfSha256: "ee".repeat(32) } }))), /OVMF/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ vcpus: 4 }))), /vCPUs/);
});

test("config: a disk bound to two deployments is refused", () => {
  const { cfg } = fixture();
  const other = "0x" + "11".repeat(32);
  cfg.bindings[other] = { ...cfg.bindings[DEP], unit: "other" };
  assert.throws(() => validateConfig(cfg), /more than one deployment/);
});

test("spawn: unbound deployments and busy disks start nothing; a bound one starts through launch.py", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  let busy = ["4242"];
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => busy, launcher: "/opt/launch.py" });
  assert.equal((await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: "0x" + "22".repeat(32), snpVm: plan() }) })).status, 403);
  const refused = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /open in another process/);
  assert.ok(!h.calls.some((c) => c[0] === "systemd-run"));
  busy = [];
  const r = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, idFor(DEP));
  const run = h.calls.find((c) => c[0] === "systemd-run");
  assert.ok(run.includes("--unit=enclave-rpc-snp-guest") && run.includes("/opt/launch.py"));
  const launch = JSON.parse(fs.readFileSync(run.at(-1), "utf8"));
  assert.equal(launch.hostData, DEP.slice(2));
  assert.equal(launch.disks.length, 2);
});

test("status: starting until attested, running after, failed when the unit ends; a 409 names the instance to adopt", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  let attested = false;
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => { if (!attested) throw new Error("front not up"); return true; }, diskUsers: () => [] });
  const id = (await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).body.id;
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "starting");
  attested = true;
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "running");
  const again = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.deepEqual([again.status, again.body.id], [409, id]);
  assert.equal((await m.handle({ method: "GET", path: "/vms" })).body.vms.length, 1);
  h.active.clear();
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "failed");
});

test("recover: a running bound unit is listed after a manager restart, and re-launch adopts it", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  h.active.add("enclave-rpc-snp-guest.service");
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => [] });
  await m.recover();
  const id = idFor(DEP);
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "starting");   // plan unknown until re-launch
  assert.equal((await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).status, 409);
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "running");
  assert.equal((await m.handle({ method: "DELETE", path: `/vms/${id}` })).status, 200);
  assert.ok(h.calls.some((c) => c[0] === "systemctl" && c[2] === "stop"));
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).status, 404);
});

test("the supervisor's own guestd-control/1 client reaches it, and an unauthenticated caller does not", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  const key = Buffer.from("ab".repeat(32), "hex");
  const srv = serve(new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => [] }), key);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const c = new GuestdControl(base, key);
    const health = await c.request("GET", "/health");
    assert.equal(health.body.backend, "snp-vm");
    const r = await c.request("POST", "/vms", { name: DEP, snpVm: plan() }, { idempotent: false });
    assert.equal(r.status, 201);
    const raw = await fetch(base + "/vms");
    assert.equal(raw.status, 401);
  } finally { await new Promise((r) => srv.close(r)); }
});

// ---- the app-zone certificate: requested by the guest, asked for by the host operator, verified by the guest ----
const APP = "5ff56a4d.app.enclave.host";
const ENDPOINT = "https://api.enclave.host/t/metal0";
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"]); return true; } catch { return false; } })();

/** A guest stand-in: its own P-256 key, the request front.py makes for the app name, and a CA that issues for it. */
function guest(dir, name = APP) {
  const f = (n) => path.join(dir, n), ossl = (...a) => execFileSync("openssl", a, { stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(f("csr.cnf"), `[req]\ndistinguished_name=dn\nreq_extensions=ext\nprompt=no\n[dn]\nCN=${name}\n[ext]\nsubjectAltName=DNS:${name}\n`);
  ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("guest.key"));
  ossl("req", "-new", "-key", f("guest.key"), "-config", f("csr.cnf"), "-sha256", "-out", f("guest.csr"));
  ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "90", "-subj", "/CN=Test CA", "-keyout", f("ca.key"), "-out", f("ca.pem"));
  ossl("x509", "-req", "-in", f("guest.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "90", "-out", f("leaf.pem"));
  const csr = fs.readFileSync(f("guest.csr"), "utf8"), certPem = fs.readFileSync(f("leaf.pem"), "utf8");
  const spki = sha(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }));
  const posted = [];
  const channel = { spki: () => spki, fetch: async (url, opts = {}) => {
    const p = new URL(url).pathname;
    if (p === "/.well-known/enclave-csr") return new Response(csr, { status: 200 });
    if (p === "/.well-known/enclave-cert") { posted.push(opts); return new Response(JSON.stringify({ installed: true, notAfter: 1 }), { status: 200 }); }
    return new Response("{}", { status: 404 });
  } };
  return { csr, certPem, spki, channel, posted };
}

function certHost(over = {}) {
  const { dir, cfg } = fixture();
  fs.writeFileSync(path.join(dir, "operator.key"), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  cfg.certs = { relay: "https://relay.test", endpoint: ENDPOINT, operatorKeyFile: path.join(dir, "operator.key") };
  const g = guest(dir, over.name), h = fakeHost(), asks = [];
  let clock = Date.parse("2026-11-12T12:00:00Z");
  const answers = over.answers || [{ status: 202, body: { retryAfterSec: 30 } }, { status: 200, body: { certPem: g.certPem } }];
  const fetch = async (url, opts) => { asks.push({ url, body: JSON.parse(opts.body) }); const a = answers[Math.min(asks.length, answers.length) - 1]; return new Response(JSON.stringify(a.body), { status: a.status }); };
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => over.channel || g.channel, diskUsers: () => [], fetch, now: () => clock });
  const launch = async () => { const id = (await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).body.id; await m.get(id); return m.instances.get(id); };
  const poll = async (inst, ms) => { clock += ms; await m.get(inst.id); await inst.cert.pass; };
  return { dir, cfg, g, m, asks, launch, poll };
}

test("certs config: https URLs with no trailing slash, and exactly one operator key source", () => {
  const { cfg } = fixture();
  const certs = { relay: "https://api.enclave.host", endpoint: ENDPOINT, operatorConfigFile: "/x/config.json" };
  assert.ok(validateConfig({ ...cfg, certs }));
  assert.throws(() => validateConfig({ ...cfg, certs: { ...certs, endpoint: ENDPOINT + "/" } }), /trailing slash/);
  assert.throws(() => validateConfig({ ...cfg, certs: { ...certs, relay: "http://relay" } }), /https/);
  assert.throws(() => validateConfig({ ...cfg, certs: { ...certs, operatorKeyFile: "/x/key" } }), /exactly one/);
  assert.equal(appNameFor(DEP), APP);
});

test("certificate: the operator signs the relay's own text for the guest's key; the chain goes to the guest; the route cue is written", { skip: !hasOpenssl }, async () => {
  const t = certHost();
  const inst = await t.launch();
  await inst.cert.pass;
  assert.equal(inst.cert.state, "ordered");                       // 202: the CA order is in flight
  assert.equal(t.g.posted.length, 0);
  await t.poll(inst, 5_000);
  assert.equal(t.asks.length, 1, "not asked again before retryAfterSec");
  await t.poll(inst, 30_000);
  assert.equal(inst.cert.state, "installed");
  const ask = t.asks[1].body;
  assert.equal(t.asks[1].url, "https://relay.test/v1/certs/issue");
  assert.deepEqual([ask.name, ask.endpoint, ask.csr], [APP, ENDPOINT, t.g.csr]);
  const signer = await recoverOp(issueMessage(APP, ENDPOINT, t.g.spki, ask.ts), ask.opSig);
  const expected = await recoverOp("x", await operatorSigner(t.cfg.certs, { readFile: fs.readFileSync })("x"));
  assert.equal(signer, expected, "the ask is signed by the host operator over exactly what the relay checks");
  assert.equal(t.g.posted.length, 1);
  assert.equal(t.g.posted[0].body, t.g.certPem);
  assert.equal(t.g.posted[0].headers["content-length"], String(Buffer.byteLength(t.g.certPem)));
  const route = JSON.parse(fs.readFileSync(path.join(t.cfg.stateDir, DEP + ".route.json"), "utf8"));
  assert.deepEqual([route.deploymentId, route.name, route.port, route.rootHash, route.measurements], [DEP, APP, 18443, "3d".repeat(32), [M]]);
  assert.equal((await t.m.get(inst.id)).certificate.state, "installed");
  const again = await t.m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan({ appRef: plan().appRef.replace(/\d+$/, "9") }) }) });
  assert.equal(again.status, 409);
  assert.equal(again.body.id, undefined, "a record for another version cannot adopt this VM");
  await t.poll(inst, 20 * 86400_000);                             // well short of 2/3 of 90 days: nothing is asked
  assert.equal(t.asks.length, 2);
  await t.poll(inst, 45 * 86400_000);                             // past it: renewed
  assert.equal(t.asks.length, 3);
  assert.ok(!JSON.stringify(t.asks).includes(fs.readFileSync(t.cfg.certs.operatorKeyFile, "utf8").trim()), "the operator key never leaves the signer");
  assert.equal((await t.m.handle({ method: "DELETE", path: "/vms/" + inst.id })).status, 200);
  assert.ok(!fs.existsSync(path.join(t.cfg.stateDir, DEP + ".route.json")), "a stopped VM leaves no route cue");
});

test("certificate: a request that is not for the attested key, or not for this deployment's name, never reaches the relay", { skip: !hasOpenssl }, async () => {
  const wrongKey = certHost(); wrongKey.g.channel.spki = () => "ee".repeat(32);
  const a = await wrongKey.launch(); await a.cert.pass;
  assert.match(a.cert.error, /not for its attested key/);
  assert.equal(wrongKey.asks.length, 0);
  const wrongName = certHost({ name: "deadbeef.app.enclave.host" });
  const b = await wrongName.launch(); await b.cert.pass;
  assert.ok(b.cert.error);
  assert.equal(wrongName.asks.length, 0);
  assert.ok(!fs.existsSync(path.join(wrongName.cfg.stateDir, DEP + ".route.json")));
});

test("certificate: a relay refusal is recorded and backed off; an image with no request is left alone; no certs config, no pass", { skip: !hasOpenssl }, async () => {
  const refused = certHost({ answers: [{ status: 403, body: { code: "not_lease_holder" } }] });
  const a = await refused.launch(); await a.cert.pass;
  assert.match(a.cert.error, /403 \(not_lease_holder\)/);
  assert.equal(refused.g.posted.length, 0);
  await refused.poll(a, 30_000);
  assert.equal(refused.asks.length, 1, "backed off");
  await refused.poll(a, 60_000);
  assert.equal(refused.asks.length, 2);
  assert.equal((await refused.m.get(a.id)).status, "running", "a certificate problem never demotes a running VM");
  const old = certHost(); old.g.channel.fetch = async () => new Response("{}", { status: 404 });
  const b = await old.launch(); await b.cert.pass;
  assert.match(b.cert.error, /asks for no certificate/);
  let looked = 0; old.g.channel.fetch = async () => { looked += 1; return new Response("{}", { status: 404 }); };
  await old.poll(b, 30 * 60_000);
  assert.equal(looked, 0, "not asked again for an hour");
  assert.equal(old.asks.length, 0);
  const { cfg } = fixture();
  const h = fakeHost();
  const untouched = { fetch: async () => { throw new Error("must not be called"); }, spki: () => "" };
  const plain = new SnpVmManager(cfg, { exec: h.exec, attest: async () => untouched, diskUsers: () => [] });
  const id = (await plain.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).body.id;
  assert.equal((await plain.get(id)).certificate, undefined);
});
