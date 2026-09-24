// The relay's carrier for a pVM DEPLOYMENT (relay/pvm-serving.mjs; shielded/anchor/avf/RELAY-SERVING.md; a LAB module, not
// wired into api-relay.js): the BUILT client 0.4.x selects a deployment from its signed table and talks to
// https://<relay>/x/<id>/pvm; the module resolves <id> by the (fake) ledger's runner, splices into that runner's pVM tunnel
// (a fake hub bridging to fake VMs), and carries bytes. The review's cases: routing by the runner only, no fallback, a
// plain status the client reports as "no evidence", rates, bounds, sizes-only logging, a runner change judged from zero,
// and -- on the Pixel's REAL evidence -- the stated limit: a relay routing deployment D to another genuine instance of the
// same app is NOT detected (asserted, so the limit stays visible).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { createPvmServing, windowLimiter } from "../relay/pvm-serving.mjs";
import { initialState } from "../shielded/anchor/avf/client/src/trust.js";
import { connect } from "../shielded/anchor/avf/client/src/client.js";
import { FileStore } from "../shielded/anchor/avf/client/src/store-file.js";
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";

const CLI = new URL("../shielded/anchor/avf/client/dist/pvm-client.mjs", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"); return { k, pub, fp: sha(Buffer.from(pub, "hex")) }; };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = "6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990";
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32), D4 = "0x" + "d4".repeat(32);
const PIXEL_RID = sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}');
const policy = (P, over = {}, now = Date.now()) => {
  const t = JSON.stringify({ type: "enclave-pvm-client-policy", key: P.pub, serial: 1, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3), codeHashes: [CODE],
    authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
    runtimeIds: [PIXEL_RID], appIds: [APP], googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"],
    sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null,
    deployments: [D1, D2, D3, D4].map((id) => ({ id, app: APP })), ...over });
  return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), P.k.privateKey).toString("hex") };
};
// a stand-in for tunnel.js spliceRaw: named pVM tunnels bridged to fake VMs' raw ports; sealed only where the "hub verified
// the app" (as spliceRaw requires t.pvmApp); pauses the socket until the upstream is open, like the real one
function fakeHub(tunnels) {
  return { spliceRaw(name, socket, kind) {
    const t = tunnels[name];
    if (!t || (kind === "pvm-app-sealed" && !t.appVerified) || (kind !== "pvm-evidence" && kind !== "pvm-app-sealed")) { socket.destroy(); return false; }
    socket.pause();
    const up = net.connect(kind === "pvm-evidence" ? t.vm.evidencePort : t.vm.sealedPort, "127.0.0.1", () => { socket.on("data", (d) => up.write(d)); socket.resume(); });
    up.on("data", (d) => socket.write(d)); up.on("close", () => socket.destroy()); up.on("error", () => socket.destroy());
    socket.on("close", () => up.destroy());
    return true;
  } };
}
const cli = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args]); let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("close", (code) => resolve({ code, result: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse().find((l) => l.result)?.result }));
});
const raw = (port, method, p, body = "") => new Promise((resolve) => {
  const q = http.request({ host: "127.0.0.1", port, method, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b })); });
  q.on("error", () => resolve({ status: 0 })); q.end(body);
});

test("the relay module routes a deployment by its ledger runner to that runner's pVM tunnel, and refuses everything else with a plain status", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const cadir = tmpdir("pvm-rs-ca-"), ca = makeCa(cadir);
  const vm1 = await startFakeVm({ dir: cadir, ca, code: Buffer.from(CODE, "hex"), appId: APP });
  const vm2 = await startFakeVm({ dir: cadir, ca, code: Buffer.from(CODE, "hex"), appId: APP });
  const ledger = { [D1]: "tunnel://pvm-a", [D2]: "https://enclave.example", [D4]: "tunnel://pvm-noapp" };   // D3: no live runner
  const logs = [];
  const handle = createPvmServing({ resolve: async (id) => ledger[id] || null, emit: (o) => logs.push(o), perDeployment: windowLimiter({ max: 4, ms: 60000 }),
    hub: fakeHub({ "pvm-a": { vm: vm1, appVerified: true }, "pvm-b": { vm: vm2, appVerified: true }, "pvm-noapp": { vm: vm1, appVerified: false } }) });
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, base = `http://127.0.0.1:${port}`;
  const dir = tmp("pvm-rs-"), st = path.join(dir, "state"), P = key(), R = key(), pf = path.join(dir, "p.json");
  fs.writeFileSync(pf, JSON.stringify(policy(P)));
  const ev = (vm) => vm.log.filter((l) => l.evidence).length;
  const run = (dep) => cli(["run", "--state", st, "--policy", pf, "--relay", `${base}/x/${dep}/pvm`, "--deployment", dep]);
  try {
    assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    // D1: its runner's tunnel -- the VM's evidence is fetched (the fake VM's chain is not Google's: refused there)
    const r1 = (await run(D1)).result;
    assert.equal(r1.step, "verify", JSON.stringify(r1)); assert.deepEqual(r1.deployment, { id: D1, app: APP }); assert.equal(ev(vm1), 1);
    // D2: a runner that is not a tunnel; D3: no live runner -- a plain 404, reported as "no evidence", nothing reached a VM
    for (const d of [D2, D3]) {
      const r = (await run(d)).result;
      assert.equal(r.step, "evidence"); assert.match(r.refused, /no evidence: the carrier answered 404/); assert.equal(r.sent, false);
    }
    assert.equal(ev(vm1) + ev(vm2), 1, "no fallback: neither refused deployment reached any VM");
    // the runner changes on the ledger between two exchanges: the next exchange goes to the new runner, fresh, from zero
    ledger[D1] = "tunnel://pvm-b";
    const r2 = (await run(D1)).result;
    assert.equal(r2.step, "verify"); assert.equal(ev(vm2), 1, "the new runner's VM answered the fresh nonce"); assert.equal(ev(vm1), 1);
    // raw HTTP: a prefix id, another method, an oversized evidence request, sealed to a tunnel whose app the hub did not verify
    assert.equal((await raw(port, "POST", "/x/0xd1d1d1d1/pvm/evidence", "EVIDENCE x\n")).status, 404, "a prefix never resolves");
    assert.equal((await raw(port, "GET", `/x/${D1}/pvm/evidence`)).status, 405);
    assert.equal((await raw(port, "POST", `/x/${D1}/pvm/evidence`, "E".repeat(300))).status, 413);
    const noapp = await raw(port, "POST", `/x/${D4}/pvm/sealed`, "x");
    assert.equal(noapp.status, 404); assert.equal(noapp.body, "", "a plain status, no body a client could mistake for an envelope");
    // the per-deployment rate (4 a minute here): D1 has used 3 -- two runs and the oversized request (the rate is checked
    // before the body is read; the 405 is refused before the rate) -- so one more passes and the next is 429
    await raw(port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE " + "ab".repeat(32) + "\n"); await raw(port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE " + "cd".repeat(32) + "\n");
    const limited = (await run(D1)).result;
    // the lab web carrier (cpu/web-carrier.mjs) answers an oversized request with its status too, not a reset
    const { createWebCarrier } = await import("../shielded/anchor/avf/cpu/web-carrier.mjs");
    const wc = createWebCarrier({ port: 0, evidencePort: vm1.evidencePort, sealedPort: vm1.sealedPort });
    await new Promise((r) => wc.on("listening", r));
    assert.equal((await raw(wc.address().port, "POST", "/evidence", "E".repeat(300))).status, 413); wc.close();
    assert.equal(limited.step, "evidence"); assert.match(limited.refused, /the carrier answered 429/); assert.equal(limited.verified, undefined, "a rate refusal never yields a verified result");
    // (h) sizes only: no log line carries a nonce, an envelope or a byte of the exchange
    const text = JSON.stringify(logs);
    for (const leak of ["EVIDENCE", "format", "nonce", "spki", "ab".repeat(8)]) assert.ok(!text.includes(leak), `the relay log carries ${leak}`);
    assert.ok(logs.some((l) => l.bytesIn > 0 && l.bytesOut > 0 && l.tunnel === "pvm-a"), "sizes and the tunnel are logged");
  } finally { srv.close(); vm1.close(); vm2.close(); }
});

test("the stated limit, on the Pixel's REAL evidence: a relay routing two deployments of the SAME app to one genuine instance is NOT detected; a different app would be", async () => {
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json", import.meta.url)));
  const at = Date.parse("2026-09-24T07:26:36Z"), P = key();
  const store = new FileStore(path.join(tmp("pvm-rs-real-"), "state.d"));
  store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: key().fp }), staged: null, active: null });
  let sealed = 0;
  // a hostile relay: whatever deployment is asked for, the same one genuine VM answers
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    if (q.url.endsWith("/evidence")) return s.end(JSON.stringify(env) + "\n");
    sealed++; s.writeHead(502); s.end(); }); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const orig = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (a) => { if (a.length === 32) { a.set(Buffer.from(env.nonce, "hex")); return a; } return orig(a); };
  try {
    const pol = policy(P, { appIds: [env.app, "ee".repeat(32)], deployments: [{ id: D1, app: env.app }, { id: D2, app: env.app }, { id: D3, app: "ee".repeat(32) }] }, at);
    const a = await connect({ relay: `${base}/x/${D1}/pvm`, policyEnv: pol, store, deployment: D1, path: "/", usedNonces: new Set(), now: at });
    const b = await connect({ relay: `${base}/x/${D2}/pvm`, policyEnv: pol, store, deployment: D2, path: "/", usedNonces: new Set(), now: at });
    assert.equal(a.result.step, "sealed"); assert.equal(b.result.step, "sealed");
    assert.deepEqual([a.result.deployment.id, b.result.deployment.id], [D1, D2]);
    assert.equal(a.result.verified.key, b.result.verified.key, "the SAME instance answered both deployments -- and the client cannot tell: the evidence names no deployment");
    assert.equal(sealed, 2);
    const c = await connect({ relay: `${base}/x/${D3}/pvm`, policyEnv: pol, store, deployment: D3, path: "/", usedNonces: new Set(), now: at });
    assert.equal(c.result.step, "verify", "a deployment the table maps to ANOTHER app: the same VM is refused"); assert.equal(sealed, 2);
  } finally { crypto.getRandomValues = orig; srv.close(); }
});

test("the wiring review's cases: a hung ledger answers 504 and caps pending lookups; an answer past the bound is never complete; two buyers each get only their own stream; a buyer leaving closes the VM's stream; X-Forwarded-For never mints a client", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const cadir = tmpdir("pvm-rs2-ca-"), ca = makeCa(cadir);
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from(CODE, "hex"), appId: APP });
  // a "VM" that answers one byte every 20 ms, forever -- to leave in the middle of
  let slowClosed = false;
  const slow = net.createServer((c) => { const t = setInterval(() => c.write("x"), 20); c.on("close", () => { clearInterval(t); slowClosed = true; }); c.on("error", () => {}); });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const hub = fakeHub({ "pvm-a": { vm, appVerified: true }, "pvm-slow": { vm: { evidencePort: slow.address().port, sealedPort: slow.address().port }, appVerified: true } });
  const serve = async (opts) => { const logs = []; const h = createPvmServing({ hub, emit: (o) => logs.push(o), ...opts });
    const srv = http.createServer((q, s) => { if (!h(q, s)) { s.writeHead(404); s.end(); } }); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); return { srv, port: srv.address().port, logs }; };
  const dir = tmp("pvm-rs2-"), st = path.join(dir, "state"), P = key(), R = key(), pf = path.join(dir, "p.json");
  fs.writeFileSync(pf, JSON.stringify(policy(P)));
  assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
  const run = (port, dep) => cli(["run", "--state", st, "--policy", pf, "--relay", `http://127.0.0.1:${port}/x/${dep}/pvm`, "--deployment", dep]);
  const servers = [];
  try {
    // a ledger that never answers: 504 after the bound, and a second lookup from the same client meanwhile is refused
    const hung = await serve({ resolve: () => new Promise(() => {}), resolveTimeoutMs: 300, maxPendingPerClient: 1 }); servers.push(hung.srv);
    const t0 = Date.now(), first = raw(hung.port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE x\n");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await raw(hung.port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE y\n")).status, 429, "one pending lookup per client here");
    const f = await first; assert.equal(f.status, 504); assert.equal(f.body, ""); assert.ok(Date.now() - t0 < 3000);
    // an answer past the bound: cut after the 200 went out -- the client never takes it for evidence
    const small = await serve({ resolve: async () => "tunnel://pvm-a", bounds: { evidence: [256, 100] } }); servers.push(small.srv);
    const cut = (await run(small.port, D1)).result;
    assert.equal(cut.step, "evidence", JSON.stringify(cut)); assert.match(cut.refused, /^no evidence/); assert.notEqual(cut.complete, true);
    // two buyers at once on one instance: each gets its own envelope (a crossed one would fail the nonce echo, not the root)
    const two = await serve({ resolve: async () => "tunnel://pvm-a" }); servers.push(two.srv);
    const [a, b] = await Promise.all([run(two.port, D1), run(two.port, D1)]);
    // the verifier compares the envelope's nonce echo with the caller's FIRST (web/pvm-verify.js), before any certificate:
    // a crossed envelope would be refused as "answers another nonce", so reaching the root refusal proves each buyer got
    // the envelope for its own nonce
    for (const r of [a.result, b.result]) {
      assert.equal(r.step, "verify", JSON.stringify(r)); assert.match(r.refused, /not a pinned Google attestation root/); assert.doesNotMatch(r.refused, /another nonce/);
    }
    assert.equal(two.logs.filter((l) => l.bytesOut > 0).length, 2, "two streams, each logged by size");
    // the buyer leaves in the middle of the answer: the stream to the VM closes, and its sizes are logged
    const gone = await serve({ resolve: async () => "tunnel://pvm-slow" }); servers.push(gone.srv);
    await new Promise((resolve) => {
      const q = http.request({ host: "127.0.0.1", port: gone.port, method: "POST", path: `/x/${D1}/pvm/evidence` }, (r) => { let n = 0; r.on("data", (d) => { n += d.length; if (n >= 5) q.destroy(); }); r.on("error", () => {}); });
      q.on("error", () => {}); q.on("close", resolve); q.end("EVIDENCE z\n");
    });
    for (let i = 0; i < 100 && !slowClosed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(slowClosed, true, "the VM side of the stream was closed when the buyer left");
    for (let i = 0; i < 100 && !gone.logs.some((l) => l.tunnel === "pvm-slow"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(gone.logs.some((l) => l.tunnel === "pvm-slow" && l.bytesOut >= 5), JSON.stringify(gone.logs));
    // the default client identity is the socket, never X-Forwarded-For: a new header value does not buy a new bucket
    const xff = await serve({ resolve: async () => null, perClient: windowLimiter({ max: 1, ms: 60000 }) }); servers.push(xff.srv);
    const withXff = (ip) => new Promise((resolve) => { const q = http.request({ host: "127.0.0.1", port: xff.port, method: "POST", path: `/x/${D1}/pvm/evidence`, headers: { "x-forwarded-for": ip } }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); }); q.end("EVIDENCE x\n"); });
    assert.equal(await withXff("198.51.100.1"), 404, "first request: through the rate, no runner");
    assert.equal(await withXff("198.51.100.2"), 429, "a new X-Forwarded-For is the same client: refused");
    // and the identity the wiring passes (here a test header) does key the buckets
    const byId = await serve({ resolve: async () => null, perClient: windowLimiter({ max: 1, ms: 60000 }), clientOf: (q) => q.headers["x-test-client"] || "?" }); servers.push(byId.srv);
    const asClient = (id) => new Promise((resolve) => { const q = http.request({ host: "127.0.0.1", port: byId.port, method: "POST", path: `/x/${D1}/pvm/evidence`, headers: { "x-test-client": id } }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); }); q.end("EVIDENCE x\n"); });
    assert.deepEqual([await asClient("a"), await asClient("b"), await asClient("a")], [404, 404, 429]);
  } finally { for (const s of servers) s.close(); vm.close(); slow.close(); }
});
