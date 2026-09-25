// EXTRACTED for review/pvm-carrier-candidate from test/pvm-relay-serving.test.mjs at 48c6efb3 (review/pvm-u7-integration, reviewed
// by enclave-99). VERBATIM: the three tests that need only the relay, the synthetic AVF fixture and the fake VM ("carrierRoute",
// "the BOOTSTRAP route on the REAL hub", "on the REAL hub, v3 at attach") and their helpers. The other five drive the installed
// pVM client, the lab web carrier or a device capture -- none of which this relay candidate carries -- and stay on the reviewed
// branch. NEW here, client-free (raw HTTP), for the relay properties only those five exercised: the carrier's bounds and stream
// lifecycle; the real hub's stream rule (evidence to any attested pVM tunnel, sealed only to a hub-verified app); and the hub
// admitting the CROSS PRODUCT of the app and runtime lists.
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
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = "6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990";
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32), D4 = "0x" + "d4".repeat(32);
const PIXEL_RID = sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}');
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

// ---------------- NEW for the candidate, client-free (raw HTTP): what the reviewed file's five client-driven tests exercised ----------------
// a raw POST that says whether the answer ENDED cleanly (a complete body) or was cut, and can leave early (abortAfter bytes)
const post = (port, p, body, { abortAfter = 0 } = {}) => new Promise((resolve) => {
  let done = false; const fin = (o) => { if (!done) { done = true; resolve(o); } };
  const q = http.request({ host: "127.0.0.1", port, method: "POST", path: p }, (r) => {
    let b = Buffer.alloc(0);
    r.on("data", (d) => { b = Buffer.concat([b, d]); if (abortAfter && b.length >= abortAfter) q.destroy(); });
    r.on("end", () => fin({ status: r.statusCode, body: b, complete: r.complete }));
    r.on("aborted", () => fin({ status: r.statusCode, body: b, complete: false })); r.on("error", () => fin({ status: r.statusCode, body: b, complete: false }));
    r.on("close", () => fin({ status: r.statusCode, body: b, complete: r.complete }));
  });
  q.on("error", () => fin({ status: 0, body: Buffer.alloc(0), complete: false })); q.end(body);
});

test("NEW, client-free: the carrier's bounds and a stream's life -- a hung ledger answers 504 and caps pending lookups; an answer past its bound is never complete; two buyers each get only their own stream; a buyer leaving closes the VM's stream", { skip: !haveOpenssl && "no openssl", timeout: 120000 }, async () => {
  const cadir = tmpdir("pvm-cand-life-"), ca = makeCa(cadir);
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from(CODE, "hex"), appId: APP });
  // a "VM" that answers one byte every 20 ms, forever -- to be cut, and to be left in the middle of
  // every stream the carrier opens to it, in order, so a check names ONE request's stream (not a count another stream's
  // late close could satisfy)
  const slowConns = [];
  const slow = net.createServer((c) => { const s = { c, closed: false }; slowConns.push(s); const t = setInterval(() => c.write("x"), 20);
    c.on("close", () => { clearInterval(t); s.closed = true; }); c.on("error", () => {}); });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const hub = fakeHub({ "pvm-a": { vm, appVerified: true }, "pvm-slow": { vm: { evidencePort: slow.address().port, sealedPort: slow.address().port }, appVerified: true } });
  const servers = [];
  const serve = async (opts) => { const logs = []; const h = createPvmServing({ hub, emit: (o) => logs.push(o), ...opts });
    const srv = http.createServer((q, s) => { if (!h(q, s)) { s.writeHead(404); s.end(); } }); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); servers.push(srv); return { port: srv.address().port, logs }; };
  const until = async (f) => { for (let i = 0; i < 150 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); return f(); };
  try {
    // a ledger that never answers: 504 at the bound, and a second lookup from the same client meanwhile is refused
    const hung = await serve({ resolve: () => new Promise(() => {}), resolveTimeoutMs: 300, maxPendingPerClient: 1 });
    const t0 = Date.now(), first = raw(hung.port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE x\n");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await raw(hung.port, "POST", `/x/${D1}/pvm/evidence`, "EVIDENCE y\n")).status, 429, "one pending lookup per client here");
    const f = await first; assert.equal(f.status, 504); assert.equal(f.body, ""); assert.ok(Date.now() - t0 < 3000);
    // an answer past its bound: the 200 is out, then the stream is cut -- never a clean end a client could take as an answer
    const small = await serve({ resolve: async () => "tunnel://pvm-slow", bounds: { evidence: [256, 50] } });
    const cut = await post(small.port, `/x/${D2}/pvm/evidence`, "EVIDENCE x\n");
    assert.equal(cut.status, 200); assert.equal(cut.complete, false, "an answer past its bound never ends cleanly"); assert.ok(cut.body.length <= 50, `${cut.body.length} bytes`);
    assert.ok(await until(() => small.logs.some((l) => l.cut)), "logged as cut");
    // two buyers at once: each gets only its own stream (the VM answers each its own nonce)
    const both = await serve({ resolve: async () => "tunnel://pvm-a" });
    const [n1, n2] = ["1a".repeat(32), "2b".repeat(32)];
    const [a, b] = await Promise.all([post(both.port, `/x/${D3}/pvm/evidence`, `EVIDENCE ${n1}\n`), post(both.port, `/x/${D3}/pvm/evidence`, `EVIDENCE ${n2}\n`)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.ok(a.complete && b.complete);
    assert.equal(JSON.parse(a.body.toString().split("\n")[0]).nonce, n1); assert.equal(JSON.parse(b.body.toString().split("\n")[0]).nonce, n2);
    // a buyer leaving in the middle of an answer: THAT request's stream to the VM is closed, within a bounded wait. The
    // earlier streams (the cut one) must be closed first, so a late close of one of them cannot stand in for this one.
    assert.ok(await until(() => slowConns.every((x) => x.closed)), "the earlier VM streams are closed before this step");
    const lv = await serve({ resolve: async () => "tunnel://pvm-slow" }), mine = slowConns.length;
    const left = await post(lv.port, `/x/${D4}/pvm/evidence`, "EVIDENCE x\n", { abortAfter: 10 });
    assert.equal(left.status, 200); assert.ok(left.body.length >= 10, "the buyer read part of the answer, then left");
    assert.equal(slowConns.length, mine + 1, "this request opened exactly one stream to the VM");
    assert.ok(await until(() => slowConns[mine].closed), "the buyer went away: the carrier closed THAT request's VM stream");
  } finally {
    // a mutant may leave streams open: end them all, so the file exits and a failure is reported by this test's name
    for (const x of slowConns) x.c.destroy();
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    slow.close(); vm.close();
  }
});

test("NEW, client-free: the REAL hub's stream rule -- evidence reaches any AVF-attested pVM tunnel; a sealed stream only a hub-verified app", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const rig = await realHub({ appIds: [APP], runtimeIds: [sha(PIXEL_ID)] }), { hub } = rig;
  assert.equal((await rig.phone("pixel-verified", { app: APP }))?.ok, true); assert.equal(await rig.phone("pixel-evidence-only"), null);
  const ledger = { [D1]: "tunnel://pixel-verified", [D2]: "tunnel://pixel-evidence-only" };
  const logs = [], handle = createPvmServing({ resolve: async (id) => ledger[id] || null, hub, emit: (o) => logs.push(o) });
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
  try {
    for (const [d, n] of [[D1, "3c".repeat(32)], [D2, "4d".repeat(32)]]) {
      const r = await raw(port, "POST", `/x/${d}/pvm/evidence`, `EVIDENCE ${n}\n`);
      assert.equal(r.status, 200, d); assert.equal(JSON.parse(r.body.split("\n")[0]).nonce, n, "evidence reaches any AVF-attested pVM tunnel");
      await new Promise((res) => setTimeout(res, 2100));   // the fake VM's own evidence pace
    }
    const s1 = await raw(port, "POST", `/x/${D1}/pvm/sealed`, SEALED_PROBE);
    assert.equal(s1.status, 200, "the real spliceRaw opened a sealed stream to the verified app"); assert.match(s1.body, /unknown evidence nonce/, "and the VM itself answered");
    const s2 = await raw(port, "POST", `/x/${D2}/pvm/sealed`, "x");
    assert.equal(s2.status, 404, "no sealed stream to a tunnel whose app the hub did not verify"); assert.equal(s2.body, "");
    assert.ok(logs.some((l) => l.tunnel === "pixel-verified" && l.pvm === "sealed" && l.bytesIn > 0), "sizes logged for the carried stream");
  } finally { srv.close(); rig.close(); }
});

test("NEW, client-free: the hub admits the CROSS PRODUCT of the app and runtime lists -- any listed app on any listed runtime; an unlisted app or runtime is refused", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  // a second ADMISSIBLE runtime (the verifier judges an identity's semantics: an interpreter runs pulley64, so only the version
  // varies here), and a second app
  const OTHER_ID = PIXEL_ID.replace('"49.0.0"', '"49.0.1"'), APP2 = sha("another admitted app (candidate cross-product test)");
  const rig = await realHub({ appIds: [APP, APP2], runtimeIds: [sha(PIXEL_ID), sha(OTHER_ID)] });
  try {
    let n = 0;
    for (const app of [APP, APP2]) for (const identity of [PIXEL_ID, OTHER_ID])
      assert.equal((await rig.phone(`pixel-x${n++}`, { app, identity }))?.ok, true, `app ${app.slice(0, 8)} on runtime ${sha(identity).slice(0, 8)}`);
    assert.equal((await rig.phone("pixel-unlisted-app", { app: sha("an app nobody listed") }))?.ok, false, "an unlisted app");
    assert.equal((await rig.phone("pixel-unlisted-runtime", { app: APP, identity: PIXEL_ID.replace("49.0.0", "48.0.0") }))?.ok, false, "an unlisted runtime");
  } finally { rig.close(); }
});
