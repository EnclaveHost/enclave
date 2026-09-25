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
import { createPvmServing, windowLimiter, pvmServingFromEnv, carrierRoute } from "../relay/pvm-serving.mjs";
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
  const q = http.request({ host: "127.0.0.1", port, method, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b, headers: r.headers })); });
  q.on("error", () => resolve({ status: 0, headers: {} })); q.end(body);
});

test("carrierRoute: only the EXACT raw routes, POST, no query -- every round-2 variant (encoding, case, slashes, dot segments, trailing parts, a query, another method) is not the carrier's and falls through", () => {
  const D = "0x" + "d1".repeat(32);
  const ok = [[`/x/${D}/pvm/evidence`, { id: D, what: "evidence", tunnel: null }], [`/x/${D}/pvm/sealed`, { id: D, what: "sealed", tunnel: null }],
              ["/t/pixel-a/pvm/evidence", { id: null, what: "evidence", tunnel: "pixel-a" }]];
  for (const [url, want] of ok) assert.deepEqual(carrierRoute({ method: "POST", url }), want, url);
  const variants = [
    `/x/${D}/pvm/evidence/`, `/x/${D}/pvm/evidence/x`, `/x/${D}/pvm/evidence?`, `/x/${D}/pvm/evidence?a=1`, `/x/${D}/pvm/evidence#f`,
    `/X/${D}/pvm/evidence`, `/x/${D}/PVM/evidence`, `/x/${D}/pvm/Evidence`, `/x/${D.toUpperCase().replace("0X", "0x")}/pvm/evidence`,
    `/x/${D}/pvm/..%2Fevidence`, `/x/${D}/pvm%2Fevidence`, `/x/${D}/pvm%252Fevidence`, `/x/${D}%2Fpvm%2Fevidence`, `/x/${D}/pvm/%65vidence`,
    `/x/${D}//pvm/evidence`, `//x/${D}/pvm/evidence`, `/x/${D}/pvm//evidence`, `/x/${D}/./pvm/evidence`, `/x/${D}/pvm/../pvm/evidence`, `/x/${D}\\pvm\\evidence`,
    `/x/${D}/other/../pvm/evidence`, `/x/${D.slice(0, 10)}/pvm/evidence`, `/x/dep_abc/pvm/evidence`, `http://api.example/x/${D}/pvm/evidence`,
    "/t/pixel-a/pvm/evidence/", "/t/pixel-a/pvm/sealed", "/t/pixel-a/PVM/evidence", "/t/pixel-a/pvm/%65vidence", "/t/pixel-a//pvm/evidence", "/t/pixel-a/x/../pvm/evidence",
    "/t/pixel-a/pvm/evidence?x", "/T/pixel-a/pvm/evidence", "/t/pixel%2Da/pvm/evidence", "/t/" + "a".repeat(65) + "/pvm/evidence",
  ];
  for (const url of variants) assert.equal(carrierRoute({ method: "POST", url }), null, url);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) assert.equal(carrierRoute({ method, url: `/x/${D}/pvm/evidence` }), null, method);
  assert.equal(carrierRoute(null), null); assert.equal(carrierRoute({ method: "POST" }), null);
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
    assert.equal(r1.step, "verify", JSON.stringify(r1)); assert.deepEqual(r1.deployment, { id: D1, app: APP, instance: null, bound: false }); assert.equal(ev(vm1), 1);
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
    // a prefix id and another method are NOT the carrier's (carrierRoute: exact, raw, POST): the server's own fallback answers
    for (const [m, p] of [["POST", "/x/0xd1d1d1d1/pvm/evidence"], ["GET", `/x/${D1}/pvm/evidence`]]) {
      const r = await raw(port, m, p, m === "POST" ? "EVIDENCE x\n" : undefined);
      assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.headers["content-security-policy"], undefined, `${m} ${p}: the fallback's 404, not a carrier refusal`);
    }
    assert.equal((await raw(port, "POST", `/x/${D1}/pvm/evidence`, "E".repeat(300))).status, 413);
    const noapp = await raw(port, "POST", `/x/${D4}/pvm/sealed`, "x");
    assert.equal(noapp.status, 404); assert.equal(noapp.body, "", "a plain status, no body a client could mistake for an envelope");
    // the per-deployment rate (4 a minute here): D1 has used 3 -- two runs and the oversized request (the rate is checked
    // before the body is read; the GET above is not the carrier's at all) -- so one more passes and the next is 429
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

// ---- the module on the REAL tunnel hub (relay/tunnel.js): a synthetic phone attaches with AVF evidence and verifies its app
// over the hub's ABI/2 nonce (as in test/tunnel.test.mjs), then carries each spliced stream to a fake VM, frame by frame ----
const PIXEL_ID = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
// a well-framed sealed request (u32 length || nonce || header || enc || ciphertext) under a nonce the VM never issued: the
// VM answers it with its own refusal frame -- the point is that the bytes reached the VM and its answer came back
const SEALED_PROBE = (() => { const body = Buffer.concat([Buffer.alloc(32, 7), Buffer.from([1, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32, 9), Buffer.alloc(24, 5)]), frame = Buffer.alloc(4);
  frame.writeUInt32BE(body.length); return Buffer.concat([frame, body]); })();
async function realHub(pvmApp) {
  const { WebSocket } = await import("ws");
  const { createTunnelHub } = await import("../relay/tunnel.js");
  const { pvmCpuPolicy } = await import("../relay/pvm-cpu-tier.mjs");
  const { AVF_PAD_FORMAT, avfPadBinding } = await import("../relay/avf-binding.mjs");
  const { bind2, bind3, instanceIdOf, instanceSigMessage } = await import("../relay/pvm-app-attest.mjs");
  const { issueLeaf, extension, AUTH } = await import("./fixtures/avf-synthetic.mjs");
  const dir = tmpdir("pvm-rs3-"), ca = makeCa(dir);
  const vm = await startFakeVm({ dir, ca, code: Buffer.from(CODE, "hex"), appId: APP });
  const PVMCODE = createHash("sha256").update("pvm-cpu protected build").digest();
  const hub = createTunnelHub({ allow: [], attest: { avf: { codeHashes: [], padCodeHashes: [], authorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin] },
    pvmCpu: pvmCpuPolicy({ codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")], models: [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "m", selftestSha256: "d".repeat(64), minDecodeTokS: 10 }] }),
    ...(pvmApp ? { pvmApp } : {}) } });
  const hubSrv = http.createServer((_q, s) => s.end("ok")); hubSrv.on("upgrade", (q, sock, head) => hub.handleUpgrade(q, sock, head));
  await new Promise((r) => hubSrv.listen(0, "127.0.0.1", r));
  const hubUrl = `ws://127.0.0.1:${hubSrv.address().port}/v1/fleet-tunnel`, phones = [];
  const wait = async (frames, pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); } return null; };
  // a phone: AVF attach (v2 pad transcript), then -- when asked -- the ABI/2 evidence for `app` under the runtime `identity`;
  // every spliced stream is carried to the fake VM (or to the ports given). Returns the hub's abi2-result (null: not sent).
  // instance (v3, INSTANCE-BINDING.md): the VM instance's key pair -- the challenge becomes Bind3 and the frame carries the
  // instance key and its signature; instanceForge: "bind2" (the certificate over Bind2) or "other-signer" (instanceSig by
  // another key)
  const phone = async (name, { app = null, identity = PIXEL_ID, evidencePort = vm.evidencePort, sealedPort = vm.sealedPort, instance = null, instanceForge = null } = {}) => {
    const frames = [], ws = new WebSocket(hubUrl, { headers: { "x-metal-name": name, "x-metal-attest": "1" } }), streams = new Map();
    phones.push(ws);
    ws.on("message", (d) => {
      let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
      if (f.t === "s+") { const c = net.connect(f.kind === "pvm-evidence" ? evidencePort : sealedPort, "127.0.0.1", () => ws.send(JSON.stringify({ t: "s=", sid: f.sid, ok: true })));
        streams.set(f.sid, c); c.on("data", (b) => ws.send(JSON.stringify({ t: "sd", sid: f.sid, d: b.toString("base64") }))); c.on("close", () => { if (streams.delete(f.sid)) ws.send(JSON.stringify({ t: "sx", sid: f.sid })); }); c.on("error", () => {}); }
      else if (f.t === "sd") streams.get(f.sid)?.write(Buffer.from(f.d, "base64"));
      else if (f.t === "sx") { const c = streams.get(f.sid); streams.delete(f.sid); c?.destroy(); }
    });
    await new Promise((r) => ws.on("open", r));
    const nonce = Buffer.from((await wait(frames, (x) => x.t === "challenge")).nonce, "base64");
    const transport = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    const padKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const bound = avfPadBinding(transport, padKey, nonce), leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(bound).digest(), code: PVMCODE }) });
    ws.send(JSON.stringify({ t: "attest", rad: { format: AVF_PAD_FORMAT, body: Buffer.from(JSON.stringify({ chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")), signature: leaf.sign(bound).toString("base64") })).toString("base64"), transportKey: transport.toString("base64"), padKey } }));
    assert.equal((await wait(frames, (x) => x.t === "attest-result"))?.ok, true);
    if (!app) return null;
    const ch = await wait(frames, (x) => x.t === "abi2-challenge");
    const rid = createHash("sha256").update(identity).digest(), hubNonce = Buffer.from(ch.nonce, "base64");
    const ispki = instance && instance.publicKey.export({ type: "spki", format: "der" });
    const bind = instance && instanceForge !== "bind2" ? bind3(transport, hubNonce, rid, instanceIdOf(ispki)) : bind2(transport, hubNonce, rid);
    const challenge = Buffer.concat([bind, Buffer.from(app, "hex")]);
    const appLeaf = issueLeaf(dir, { ext: extension({ challenge, code: PVMCODE }) });
    const inst = instance ? { instanceKey: ispki.toString("hex"),
      instanceSig: edSign(null, instanceSigMessage(challenge), (instanceForge === "other-signer" ? generateKeyPairSync("ed25519") : instance).privateKey).toString("hex") } : {};
    ws.send(JSON.stringify({ t: "abi2", chain: [appLeaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")), identity, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self", app, ...inst }));
    return await wait(frames, (x) => x.t === "abi2-result");
  };
  return { hub, vm, phone, close: () => { for (const ws of phones) ws.close(); hubSrv.close(); vm.close(); } };
}

test("on the REAL tunnel hub: the module's streams go through tunnel.js spliceRaw to an attested phone -- evidence to any attested pVM tunnel, sealed only to a hub-verified app", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const rig = await realHub({ appIds: [APP], runtimeIds: [sha(PIXEL_ID)] }), { hub, vm } = rig;
  assert.equal((await rig.phone("pixel-verified", { app: APP }))?.ok, true); assert.equal(await rig.phone("pixel-evidence-only"), null);
  const ledger = { [D1]: "tunnel://pixel-verified", [D2]: "tunnel://pixel-evidence-only" };
  const logs = [], handle = createPvmServing({ resolve: async (id) => ledger[id] || null, hub, emit: (o) => logs.push(o) });
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, dir2 = tmp("pvm-rs3c-"), st = path.join(dir2, "state"), P = key(), R = key(), pf = path.join(dir2, "p.json");
  fs.writeFileSync(pf, JSON.stringify(policy(P)));
  const ev = () => vm.log.filter((l) => l.evidence).length;
  try {
    assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    // the BUILT client, through the module and the real hub, to the phone's VM: its own nonce answered, judged by the client
    for (const [dep, n] of [[D1, 1], [D2, 2]]) {
      const r = (await cli(["run", "--state", st, "--policy", pf, "--relay", `http://127.0.0.1:${port}/x/${dep}/pvm`, "--deployment", dep])).result;
      assert.equal(r.step, "verify", JSON.stringify(r)); assert.match(r.refused, /not a pinned Google attestation root/); assert.doesNotMatch(r.refused, /another nonce/);
      assert.equal(ev(), n, "evidence streams reach any AVF-attested pVM tunnel");
    }
    // sealed: carried to the hub-verified app, and the VM itself answered
    const s1 = await raw(port, "POST", `/x/${D1}/pvm/sealed`, SEALED_PROBE);
    assert.equal(s1.status, 200, "the real spliceRaw opened a sealed stream to the verified app"); assert.match(s1.body, /unknown evidence nonce/, "and the VM itself answered");
    assert.ok(vm.log.some((l) => /unknown evidence nonce/.test(l.refused || "")));
    const s2 = await raw(port, "POST", `/x/${D2}/pvm/sealed`, "x");
    assert.equal(s2.status, 404, "no sealed stream to a tunnel whose app the hub did not verify"); assert.equal(s2.body, "");
    assert.ok(logs.some((l) => l.tunnel === "pixel-verified" && l.pvm === "sealed" && l.bytesIn > 0), "sizes logged for the carried stream");
  } finally { srv.close(); rig.close(); }
});

test("the BOOTSTRAP route on the REAL hub: /t/<name>/pvm/evidence reaches that name's attested pVM tunnel with no ledger lookup -- evidence only, rate-limited per tunnel, plain refusals", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const rig = await realHub({ appIds: [APP], runtimeIds: [sha(PIXEL_ID)] }), { hub, vm } = rig;
  assert.equal(await rig.phone("pixel-unleased"), null);   // attested, evidence-capable; no ledger row names it
  const logs = [], resolved = [];
  const handle = createPvmServing({ resolve: async (id) => { resolved.push(id); return null; }, hub, emit: (o) => logs.push(o), perDeployment: windowLimiter({ max: 2, ms: 60000 }) });
  let notOurs = 0;
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { notOurs++; s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, ev = () => vm.log.filter((l) => l.evidence).length;
  try {
    const n = createHash("sha256").update("bootstrap nonce").digest("hex");
    const a = await raw(port, "POST", "/t/pixel-unleased/pvm/evidence", `EVIDENCE ${n}\n`);
    assert.equal(a.status, 200, a.body); assert.equal(JSON.parse(a.body).nonce, n, "the VM answered the caller's own nonce");
    assert.equal(ev(), 1); assert.equal(resolved.length, 0, "no ledger lookup on the bootstrap route");
    const u = await raw(port, "POST", "/t/no-such-phone/pvm/evidence", `EVIDENCE ${n}\n`);
    assert.equal(u.status, 404); assert.equal(u.body, "", "an unknown name: a plain 404, nothing that could pass for evidence");
    const n0 = notOurs, sealed = await raw(port, "POST", "/t/pixel-unleased/pvm/sealed", "x");
    assert.equal(sealed.status, 404); assert.equal(notOurs, n0 + 1, "sealed is never routed by name: not this module's path");
    { const n1 = notOurs; assert.equal((await raw(port, "GET", "/t/pixel-unleased/pvm/evidence", "")).status, 404); assert.equal(notOurs, n1 + 1, "a GET is not the carrier's: it falls through"); }
    assert.equal((await raw(port, "POST", "/t/pixel-unleased/pvm/evidence", `EVIDENCE ${n}\n`)).status, 200, "the bucket's second request");
    assert.equal(ev(), 2);
    const r3 = await raw(port, "POST", "/t/pixel-unleased/pvm/evidence", `EVIDENCE ${n}\n`);
    assert.equal(r3.status, 429, "the per-TUNNEL bucket (2 in the window here) holds");
    assert.equal(ev(), 2, "the refused request never reached the VM");
    assert.ok(logs.some((l) => l.pvm === "evidence" && l.tunnel === "pixel-unleased" && l.bytesIn > 0), "sizes logged");
    assert.ok(logs.some((l) => l.refused === "rate" && l.tunnel === "pixel-unleased"));
  } finally { srv.close(); rig.close(); }
});

// ---- the relay's OWN wiring (pvmServingFromEnv, exactly as api-relay.js builds it: the env's app policy is the hub's
// attest.pvmApp and handler() is the route) on the real hub. A synthetic phone cannot attach to a spawned api-relay.js (its
// AVF verifier pins Google's roots, correctly, with no override), so this is where the splice is driven end to end ----
test("the relay's wiring on the REAL hub: the env's app policy admits the CROSS PRODUCT; an unknown app, an unverified tunnel, a crossed envelope, a buyer leaving, an answer past the bound, a hung ledger and a missing policy all fail closed", { skip: !haveOpenssl && "no openssl", timeout: 240000 }, async () => {
  const OTHER = "0b".repeat(32), UNKNOWN = "0c".repeat(32);
  const PIXEL2 = PIXEL_ID.replace('"49.0.0"', '"49.0.1"'), RID = sha(PIXEL_ID), RID2 = sha(PIXEL2);
  // the operator means APP on RID and OTHER on RID2; the lists do not pair them (tunnel.js checks app in appIds AND runtime in
  // runtimeIds), so APP on RID2 is admitted too -- the stated predicate, pinned here so it cannot change silently
  const served = pvmServingFromEnv({ PVM_SERVING: "on", PVM_APP_IDS: `${APP},${OTHER}`, PVM_APP_RUNTIME_IDS: `${RID}, ${RID2}` }, { avfOn: true, pvmCpuOn: true });
  assert.deepEqual(served.missing, []); assert.deepEqual(served.attestPvmApp, { appIds: [APP, OTHER], runtimeIds: [RID, RID2] });
  const rig = await realHub(served.attestPvmApp), { hub, vm } = rig;
  let slowClosed = false;
  const slow = net.createServer((c) => { const t = setInterval(() => c.write("x"), 20); c.on("close", () => { clearInterval(t); slowClosed = true; }); c.on("error", () => {}); });
  const flood = net.createServer((c) => { c.on("error", () => {}); c.write(Buffer.alloc(512 << 10, 0x7b)); });   // 512 KiB: twice the evidence bound
  await Promise.all([slow, flood].map((x) => new Promise((r) => x.listen(0, "127.0.0.1", r))));
  const abi = {
    ok: await rig.phone("p-ok", { app: APP }), cross: await rig.phone("p-cross", { app: APP, identity: PIXEL2 }),
    unknown: await rig.phone("p-unknown", { app: UNKNOWN }), unverified: await rig.phone("p-unverified"),
    slow: await rig.phone("p-slow", { app: APP, evidencePort: slow.address().port }), flood: await rig.phone("p-flood", { app: APP, evidencePort: flood.address().port }),
  };
  assert.equal(abi.ok?.ok, true); assert.equal(abi.cross?.ok, true, "APP on OTHER's runtime: admitted (the cross product)");
  assert.equal(abi.unknown?.ok, false); assert.match(abi.unknown.reasons.join(" "), /not one this relay admits/); assert.equal(abi.unverified, null);
  const D5 = "0x" + "d5".repeat(32), D6 = "0x" + "d6".repeat(32), D7 = "0x" + "d7".repeat(32);
  const ledger = { [D1]: "tunnel://p-ok", [D2]: "tunnel://p-unverified", [D3]: "tunnel://p-unknown", [D4]: "tunnel://p-cross", [D5]: "tunnel://p-slow", [D6]: "tunnel://p-flood" };
  const logs = [], handle = served.handler({ resolve: (id) => (id === D7 ? new Promise(() => {}) : Promise.resolve(ledger[id] || null)), hub, emit: (o) => logs.push(o) });
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, dir2 = tmp("pvm-rs4-"), st = path.join(dir2, "state"), P = key(), R = key(), pf = path.join(dir2, "p.json");
  fs.writeFileSync(pf, JSON.stringify(policy(P)));
  // the relay path is the route; --deployment is the client's selection from its signed table (D1-D4). They are separate
  // inputs: the client never learns which instance a route reaches (RELAY-SERVING.md "Not given")
  const run = (route, select = D1) => cli(["run", "--state", st, "--policy", pf, "--relay", `http://127.0.0.1:${port}/x/${route}/pvm`, "--deployment", select]);
  try {
    assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    // sealed: the verified app and the cross-product admission reach the VM; an unknown app and an unverified tunnel do not
    for (const dep of [D1, D4]) { const r = await raw(port, "POST", `/x/${dep}/pvm/sealed`, SEALED_PROBE); assert.equal(r.status, 200, dep); assert.match(r.body, /unknown evidence nonce/); }
    for (const dep of [D3, D2]) { const r = await raw(port, "POST", `/x/${dep}/pvm/sealed`, SEALED_PROBE); assert.equal(r.status, 404, dep); assert.equal(r.body, ""); }
    assert.equal(logs.filter((l) => l.refused === "the tunnel does not take this stream").length, 2);
    // two buyers at once on one instance: each gets the envelope for its own nonce (web/pvm-verify.js compares the nonce echo
    // FIRST, so a crossed envelope would be refused as "another nonce", never reach the root check)
    const before = vm.log.filter((l) => l.evidence).length;
    for (const r of (await Promise.all([run(D1), run(D1)])).map((x) => x.result)) {
      assert.equal(r.step, "verify", JSON.stringify(r)); assert.match(r.refused, /not a pinned Google attestation root/); assert.doesNotMatch(r.refused, /another nonce/);
    }
    assert.equal(vm.log.filter((l) => l.evidence).length - before, 2, "two evidence requests reached the VM through the real hub");
    // an answer past the evidence bound (256 KiB): the stream is cut after the 200 went out; the client never takes it as evidence
    const cut = (await run(D6)).result;
    assert.equal(cut.step, "evidence", JSON.stringify(cut)); assert.match(cut.refused, /^no evidence/); assert.notEqual(cut.complete, true);
    const rawCut = await new Promise((resolve) => { const q = http.request({ host: "127.0.0.1", port, method: "POST", path: `/x/${D6}/pvm/evidence` }, (r) => { let n = 0;
      r.on("data", (d) => (n += d.length)); r.on("error", () => {}); r.on("close", () => resolve({ status: r.statusCode, n, complete: r.complete })); }); q.on("error", () => resolve({ status: 0, n: 0, complete: false })); q.end("EVIDENCE x\n"); });
    assert.equal(rawCut.status, 200); assert.equal(rawCut.complete, false, "a cut answer is ABORTED, never a clean end"); assert.ok(rawCut.n <= 256 << 10, `never more than the bound (${rawCut.n})`);
    assert.ok(logs.some((l) => l.tunnel === "p-flood" && l.cut), "the cut is logged");
    // the buyer leaves in the middle of the answer: the hub closes the phone's stream to the VM
    await new Promise((resolve) => {
      const q = http.request({ host: "127.0.0.1", port, method: "POST", path: `/x/${D5}/pvm/evidence` }, (r) => { let n = 0; r.on("data", (d) => { n += d.length; if (n >= 5) q.destroy(); }); r.on("error", () => {}); });
      q.on("error", () => {}); q.on("close", resolve); q.end("EVIDENCE z\n");
    });
    for (let i = 0; i < 200 && !slowClosed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(slowClosed, true, "the VM side of the stream was closed through the real hub when the buyer left");
    // a ledger that never answers: a plain 504 at the wiring's bound (5 s)
    const t0 = Date.now(), hung = await raw(port, "POST", `/x/${D7}/pvm/evidence`, "EVIDENCE x\n");
    assert.equal(hung.status, 504); assert.equal(hung.body, ""); assert.ok(Date.now() - t0 >= 4900 && Date.now() - t0 < 9000, `${Date.now() - t0} ms`);
    assert.ok(logs.every((l) => !JSON.stringify(l).includes("EVIDENCE")), "the carrier's lines hold sizes and ids only");
    // the SAME live, verified tunnels under a missing app policy: every pVM route is a plain 503, nothing reaches the hub
    const n0 = vm.log.length;
    for (const env of [{ PVM_SERVING: "1", PVM_APP_IDS: APP }, { PVM_SERVING: "1", PVM_APP_IDS: APP.toUpperCase(), PVM_APP_RUNTIME_IDS: RID }]) {
      const none = pvmServingFromEnv(env, { avfOn: true, pvmCpuOn: true });
      assert.equal(none.attestPvmApp, null); assert.match(none.missing.join(), /app admission policy/);
      const h = none.handler({ resolve: async (id) => ledger[id] || null, hub }), s = http.createServer((q, r) => { if (!h(q, r)) { r.writeHead(404); r.end(); } });
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      for (const w of ["evidence", "sealed"]) { const r = await raw(s.address().port, "POST", `/x/${D1}/pvm/${w}`, w === "sealed" ? SEALED_PROBE : "EVIDENCE x\n"); assert.equal(r.status, 503, w); assert.equal(r.body, ""); }
      s.close();
    }
    assert.equal(vm.log.length, n0, "nothing reached the VM");
  } finally { srv.close(); slow.close(); flood.close(); rig.close(); }
});

// ---- v3 at attach (INSTANCE-BINDING.md): the hub checks the INSTANCE the phone's VM attests over the hub's own nonce, and
// publishes the InstanceID in the tunnel row -- a HINT for a policy signer's enrollment, never the client's trust ----
test("on the REAL hub, v3 at attach: an instance-bound ABI/2 frame is verified over the hub's nonce and its InstanceID published; a forged instance signature or a Bind2 certificate is refused; v2 frames still verify", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const { instanceIdOf } = await import("../relay/pvm-app-attest.mjs");
  const rig = await realHub({ appIds: [APP], runtimeIds: [sha(PIXEL_ID)] });
  try {
    const I = generateKeyPairSync("ed25519"), iid = instanceIdOf(I.publicKey.export({ type: "spki", format: "der" })).toString("hex");
    assert.equal((await rig.phone("p-v3", { app: APP, instance: I }))?.ok, true);
    const row = rig.hub.origins().find((o) => o.name === "p-v3");
    assert.equal(row?.pvmApp?.instanceId, iid, "the row publishes the attested InstanceID");
    const forged = await rig.phone("p-v3-forged", { app: APP, instance: I, instanceForge: "other-signer" });
    assert.equal(forged?.ok, false); assert.match(forged.reasons.join(" "), /instanceSig is not the instance key's signature/);
    const old = await rig.phone("p-v3-bind2", { app: APP, instance: I, instanceForge: "bind2" });
    assert.equal(old?.ok, false); assert.match(old.reasons.join(" "), /attestation/, "instance fields over a Bind2 certificate: the instance was not attested");
    for (const n of ["p-v3-forged", "p-v3-bind2"]) assert.equal(rig.hub.origins().find((o) => o.name === n)?.pvmApp, undefined, `${n}: no app admitted`);
    assert.equal((await rig.phone("p-v2", { app: APP }))?.ok, true);
    assert.equal(rig.hub.origins().find((o) => o.name === "p-v2")?.pvmApp?.instanceId, undefined, "a v2 frame names no instance");
  } finally { rig.close(); }
});
