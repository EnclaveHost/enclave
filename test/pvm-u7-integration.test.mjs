// The pVM carrier inside U7 (review/pvm-u7-integration: security/u7-eligible-routing + the pVM runner's relay pieces; agreed
// with the verifier session, enclave-99's conditions). A SPAWNED real relay/api-relay.js from this tree, a stub chain (the
// EnclaveDeployments ledger and the EnclaveRegistry, synthetic rows), synthetic AVF phones (test/fixtures/avf-synthetic.mjs,
// a lab CA) bridging fake VMs (test/fixtures/pvm-fake-vm.mjs), an eligible app host, and a token tunnel. The lab CA is
// trusted ONLY through test/fixtures/avf-lab-root-preload.mjs (`node --import`), test-only, and the first two tests hold it
// to its conditions. What is shown:
//   - the narrow pVM path works through the intended wiring: the bootstrap /t/<name>/pvm/evidence, /x/<D>/pvm/evidence and
//     sealed for the live lease holder's hub-verified pVM tunnel, and again after an in-place re-attach that carries NO tier;
//   - it refuses: another holder, an ELIGIBLE (non-phone) holder, an expired lease, a lapse mid-session, a tunnel whose public
//     URL is not the runner's, a token tunnel whose hello says avf, a phone whose attestation was refused;
//   - the phone row gets NOTHING else, through any fallback: /x/<D>/<other> and every non-exact or non-POST form of the pVM
//     paths (U7's host_ineligible), the app subdomain, /t/<name>/<other>, WebSocket upgrades (including on the pVM paths),
//     v1 control, certificates and secrets (exactly 403 host_ineligible); the caller's Authorization, Proxy-Authorization and
//     Cookie never reach the VM, and carrier answers set no cookie and are sandboxed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir, makeCa, haveOpenssl, issueLeaf, extension, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance } from "./fixtures/pvm-fake-vm.mjs";
import { bootDaemon } from "./helpers/daemon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(here, ".."), RELAY_DIR = path.join(ROOT, "relay");
const PRELOAD = path.join(here, "fixtures", "avf-lab-root-preload.mjs");
const skip = !haveOpenssl && "no openssl";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const ORIGIN = "https://relay.lab", DEP = "0x" + "12".repeat(20), REG = "0x" + "34".repeat(20);
const PVMCODE = createHash("sha256").update("pvm-cpu protected build (u7 integration)").digest();
const OTHER_CODE = createHash("sha256").update("another build (u7 integration)").digest();
const APP = sha("the served component (u7 integration)");
const MODELS = [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "m", selftestSha256: "dd".repeat(32), minDecodeTokS: 10 }];
const idOf = (url) => V.keccak256(V.stringToBytes(url));
const nowS = () => Math.floor(Date.now() / 1000);
const D = (byte) => "0x" + byte.repeat(32);   // distinct first bytes: every 8-hex label names one deployment
const SENTINEL = "SENTINEL-" + randomBytes(6).toString("hex");
// a well-framed sealed request under a nonce the VM never issued: the VM answers with its own refusal frame
const SEALED_PROBE = (() => { const body = Buffer.concat([Buffer.alloc(32, 7), Buffer.from([1, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32, 9), Buffer.alloc(24, 5)]), frame = Buffer.alloc(4);
  frame.writeUInt32BE(body.length); return Buffer.concat([frame, body]); })();

// ---------- the stub chain: the ledger (schema rev 2, as test/relay-u7-eligible-routing.test.mjs) and the registry ----------
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function tupleOf(d) {
  const strs = [d.appRef || "ipfs://pvm", "", ""].map((s) => { const hex = Buffer.from(s, "utf8").toString("hex"); return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) }; });
  let off = 17 * 32; const heads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
  return [W(d.id), W("0x" + "aa".repeat(20)), ...heads, W(0), W(10), W(8080), W(1), W(1), W(1700000000), W(3), W(5_000_000), W(0),
          W(d.runner ?? "0x" + "0".repeat(64)), W("0x" + "0".repeat(40)), W(d.leaseUntil ?? 0)].join("") + strs.map((s) => s.body).join("");
}
const encPage = (rows) => { const t = rows.map(tupleOf); let off = rows.length * 32; const heads = t.map((x) => { const h = W(off); off += x.length / 2; return h; }); return "0x" + W(32) + W(rows.length) + heads.join("") + t.join(""); };
const ENCLAVE_TUPLE_V1 = [{ name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }];
const GET_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: ENCLAVE_TUPLE_V1 }] }];
const SEL = { count: "0x06661abd", schema: "0x5d1b72b6", get: V.toFunctionSelector("get(bytes32)"), getPage: V.toFunctionSelector("getPage(uint256,uint256)") };
function stubChain(state) {
  return http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const q = JSON.parse(b || "{}");
    const one = (m) => {
      if (m.method === "eth_chainId") return "0x2105"; if (m.method === "eth_blockNumber") return "0x1";
      if (m.method !== "eth_call") return "0x";
      const to = String(m.params?.[0]?.to || "").toLowerCase(), data = String(m.params?.[0]?.data || "");
      if (to === DEP) {
        if (data.startsWith(SEL.schema)) return "0x" + W(2);
        if (data.startsWith(SEL.count)) return "0x" + W(state.ledger.length);
        const start = Number(BigInt("0x" + data.slice(10, 74))), n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(state.ledger.slice(start, start + n));
      }
      if (to === REG) {
        if (data.startsWith(SEL.count)) return "0x" + W(0);                       // discovery: nothing to dial (the tunnels are hub rows)
        if (data.startsWith(SEL.getPage)) return "0x" + W(32) + W(0);
        if (data.startsWith(SEL.get)) {
          const id = "0x" + data.slice(10, 74), op = state.registry.get(id.toLowerCase());
          return V.encodeFunctionResult({ abi: GET_ABI, functionName: "get", result: { endpoint: op ? "registered" : "", repo: "", measurement: "0x" + "0".repeat(64),
            operator: op || "0x" + "0".repeat(40), registeredAt: 1n, lastSeen: 1n, active: !!op } });
        }
        return "0x";
      }
      return "0x";
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: q.id, result: one(q) })); }); });
}

// ---------- an eligible app host (a dialed box naming its confidential CPU), recording what reaches it ----------
async function appHost(t) {
  const seen = [];
  const s = http.createServer((q, r) => { seen.push(`${q.method} ${q.url}`);
    if (q.url === "/availability") { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, teeCpu: "amd-sev-snp" })); }
    q.resume(); q.on("end", () => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ servedBy: "app" })); }); });
  s.on("upgrade", (q, sock) => { seen.push(`UPGRADE ${q.url}`); sock.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); t.after(() => s.close());
  return { endpoint: `http://127.0.0.1:${s.address().port}`, seen };
}

// ---------- the spawned relay: a scrubbed environment (PATH plus exactly these), the preload only when asked ----------
async function spawnRelay(t, { preload, chainPort, labRoot, rid, app, dir }) {
  const env = { PATH: process.env.PATH, ENCLAVES: app.endpoint, API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${chainPort}`, RPC_FALLBACKS: "0",
    DEPLOYMENTS_ADDRESS: DEP, REGISTRY_ADDRESS: REG, ADDRESS_BOOK_ADDRESS: "", TUNNEL_PUBLIC_ORIGIN: ORIGIN, AVAIL_POLL_SEC: "1", REGISTRY_POLL_SEC: "2",
    APP_DOMAIN: "app.test", APP_ZONE: "app.test", FEATURED_VIEWS_FILE: path.join(dir, "featured.json"), AUTH_DATA_DIR: dir, STATE_DIRECTORY: dir,
    CERTS_KEY: "c1".repeat(32), DNS_API: "http://127.0.0.1:1", DNS_TXT_KEY: "d1".repeat(32), SECRETS_KEY: "5e".repeat(32),
    PVM_SERVING: "1", METAL_AVF_CODE_HASHES: PVMCODE.toString("hex"), METAL_AVF_AUTHORITY_HASHES: AUTH.toString("hex"), PVM_CPU_CODE_HASHES: PVMCODE.toString("hex"),
    PVM_CPU_MODELS: JSON.stringify(MODELS), PVM_APP_IDS: APP, PVM_APP_RUNTIME_IDS: rid, METAL_TUNNEL_TOKENS: "box1:lab-box-attach",
    ...(preload ? { TEST_AVF_LAB_ROOT_PIN: labRoot } : {}) };
  const { child, port, log } = await bootDaemon({ tries: 2,
    start: (p) => spawn(process.execPath, [...(preload ? ["--import", PRELOAD] : []), path.join(RELAY_DIR, "api-relay.js")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...env, API_RELAY_PORT: String(p) } }),
    claimed: (l, p) => l.includes(`[api-relay] :${p}`), ready: async (p) => (await fetch(`http://127.0.0.1:${p}/health`)).ok });
  t.after(() => child.kill("SIGKILL"));
  return { port, log };
}
const req = (port, method, p, body = "", headers = {}) => new Promise((resolve) => {
  const q = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b, headers: r.headers })); });
  q.on("error", () => resolve({ status: 0, body: "", headers: {} })); q.end(body);
});
const upgrade = (port, p, host) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.1\r\nHost: ${host || "127.0.0.1"}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`));
  let b = ""; s.on("data", (d) => { b += d; if (b.includes("\r\n\r\n")) { s.destroy(); resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(b) || [])[1] || 0)); } });
  s.on("error", () => resolve(0)); s.on("close", () => resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(b) || [])[1] || 0)));
});
const wait = async (frames, pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); } return null; };
const until = async (fn, ms = 15000, what = "a condition") => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)); } };

// ---------- a synthetic AVF phone presenting a fake VM's transport key; every stream and request it gets is recorded ----------
async function phone(port, name, { vm, ca, dir, code = PVMCODE, operator = null, tokenAttach = false, helloMode = "avf" }) {
  const { WebSocket } = await import("ws");
  const { AVF_PAD_FORMAT, avfPadBinding } = await import("../relay/avf-binding.mjs");
  const rec = { streams: [], toVm: [], reqs: [] };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/fleet-tunnel`, { headers: tokenAttach ? { "x-metal-name": name, "x-metal-token": "lab-box-attach" } : { "x-metal-name": name, "x-metal-attest": "1" } });
  const frames = [], streams = new Map();
  let closed = false; ws.on("close", () => { closed = true; });
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
    if (f.t === "ping") return ws.send(JSON.stringify({ t: "pong" }));
    if (f.t === "req") { rec.reqs.push(`${f.method || "GET"} ${f.path}`);
      return ws.send(JSON.stringify({ t: "res", id: f.id, status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ ok: true, role: "phone-anchor" })).toString("base64") })); }
    if (f.t === "s+") { rec.streams.push(f.kind);
      const c = net.connect(f.kind === "pvm-evidence" ? vm.evidencePort : vm.sealedPort, "127.0.0.1", () => ws.send(JSON.stringify({ t: "s=", sid: f.sid, ok: true })));
      streams.set(f.sid, c); c.on("data", (b) => ws.send(JSON.stringify({ t: "sd", sid: f.sid, d: b.toString("base64") })));
      c.on("close", () => { if (streams.delete(f.sid)) ws.send(JSON.stringify({ t: "sx", sid: f.sid })); }); c.on("error", () => {}); return; }
    if (f.t === "sd") { const b = Buffer.from(f.d, "base64"); rec.toVm.push(b); return streams.get(f.sid)?.write(b); }
    if (f.t === "sx") { const c = streams.get(f.sid); streams.delete(f.sid); c?.destroy(); }
  });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const hello = () => ws.send(JSON.stringify({ t: "hello", name, mode: helloMode, publicUrl: `${ORIGIN}/t/${name}` }));
  if (tokenAttach) { hello(); return { rec, ws, frames, closed: () => closed, close: () => ws.close() }; }
  const nonce = Buffer.from((await wait(frames, (x) => x.t === "challenge")).nonce, "base64");
  const spki = Buffer.from(vm.transportSpki, "hex"), padKey = randomBytes(32).toString("hex");
  const B = avfPadBinding(spki, padKey, nonce), leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(B).digest(), code }) });
  const rad = { format: AVF_PAD_FORMAT, body: Buffer.from(JSON.stringify({ chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")), signature: leaf.sign(B).toString("base64") })).toString("base64"),
                transportKey: spki.toString("base64"), padKey };
  const operatorSig = operator ? await operator.signMessage({ message: `enclave-tunnel-attach:${name}:${nonce.toString("base64")}` }) : undefined;
  ws.send(JSON.stringify({ t: "attest", rad, ...(operatorSig ? { operatorSig } : {}) }));
  const result = await wait(frames, (x) => x.t === "attest-result");
  if (!result || !result.ok) return { result, rec, ws, frames, closed: () => closed, close: () => ws.close() };
  hello();
  // ABI/2 for the hub's fresh nonce: the VM's own EVIDENCE3 answer, passed through (as host/app/RelayKeeper.java does)
  const ch = await wait(frames, (x) => x.t === "abi2-challenge"), hex = Buffer.from(ch.nonce, "base64").toString("hex");
  const ev = await new Promise((resolve) => { const c = net.connect(vm.evidencePort, "127.0.0.1", () => c.write(`EVIDENCE3 ${hex}\n`)); let b = ""; c.on("data", (d) => (b += d)); c.on("end", () => resolve(JSON.parse(b.split("\n")[0]))); });
  ws.send(JSON.stringify({ t: "abi2", chain: ev.chain, identity: ev.identity, selftest: ev.selftest, app: ev.app, instanceKey: ev.instanceKey, instanceSig: ev.instanceSig }));
  const abi2 = await wait(frames, (x) => x.t === "abi2-result");
  return { result, abi2, rec, ws, frames, closed: () => closed, close: () => ws.close() };
}

test("the lab-root preload is TEST-ONLY and only ADDS: nothing deployable references it; with it, the production pins are present and unchanged and exactly the lab pin is added; without its pin it refuses to load", () => {
  // (a) nothing in relay/, deploy.sh, a systemd unit or a CI workflow names it
  const hits = [];
  const scan = (p) => { const st = fs.statSync(p); if (st.isDirectory()) { for (const f of fs.readdirSync(p)) if (f !== "node_modules") scan(path.join(p, f)); return; }
    if (st.size < 5e6 && /avf-lab-root-preload|TEST_AVF_LAB_ROOT_PIN/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p)); };
  scan(RELAY_DIR);
  const wf = path.join(ROOT, ".github", "workflows"); if (fs.existsSync(wf)) scan(wf);
  let units = [];   // systemd units the repository tracks (outside a git checkout -- the mutation harness's copy -- there are none to read)
  try { units = execFileSync("git", ["-C", ROOT, "ls-files", "*.service", "*.socket", "*.timer"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch {}
  for (const u of units) scan(path.join(ROOT, u));
  assert.deepEqual(hits, [], "no deployable file references the test-only preload or its variable");
  // (c) it only ADDS: the production pins as shipped, plus the lab pin
  const lab = "ab".repeat(32);
  const out = execFileSync(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", `import { GOOGLE_ATTESTATION_ROOT_SHA256 as M } from ${JSON.stringify(path.join(RELAY_DIR, "avf-verify.mjs"))}; console.log(JSON.stringify([...M]));`],
                              { encoding: "utf8", env: { PATH: process.env.PATH, TEST_AVF_LAB_ROOT_PIN: lab } });
  assert.deepEqual(JSON.parse(out), [["google-hardware-attestation-root-2022", "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc"],
                                     ["google-key-attestation-ca1-2025", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], ["test-lab-root", lab]]);
  // and it refuses to run without a well-formed pin (a typo can never widen the map by accident)
  assert.throws(() => execFileSync(process.execPath, ["--import", PRELOAD, "-e", "0"], { stdio: "pipe", env: { PATH: process.env.PATH } }));
  assert.throws(() => execFileSync(process.execPath, ["--import", PRELOAD, "-e", "0"], { stdio: "pipe", env: { PATH: process.env.PATH, TEST_AVF_LAB_ROOT_PIN: "AB".repeat(32) } }));
});

test("(b) the negative control: the SAME spawned relay WITHOUT the preload refuses the lab chain -- no tunnel, no route", { skip, timeout: 120000 }, async (t) => {
  const dir = tmpdir("pvm-u7-neg-"), ca = makeCa(dir), vm = await startFakeVm({ dir, ca, code: PVMCODE, appId: APP, instance: newInstance() }); t.after(() => vm.close());
  const state = { ledger: [{ id: D("a1"), runner: idOf(`${ORIGIN}/t/pixel-a`), leaseUntil: nowS() + 3600 }], registry: new Map() };
  const chain = stubChain(state); await new Promise((r) => chain.listen(0, "127.0.0.1", r)); t.after(() => chain.close());
  const app = await appHost(t);
  const { port } = await spawnRelay(t, { preload: false, chainPort: chain.address().port, labRoot: ca.rootPin, rid: vm.rid, app, dir });
  const p = await phone(port, "pixel-a", { vm, ca, dir }); t.after(() => p.close());
  assert.equal(p.result.ok, false, "without the preload the lab chain is not trusted"); assert.match(p.result.reason, /pinned Google attestation root|root/i);
  const r = await req(port, "POST", `/x/${D("a1")}/pvm/evidence`, `EVIDENCE3 ${"ab".repeat(32)}\n`);
  assert.equal(r.status, 404); assert.deepEqual(p.rec.streams, []);
});

test("the pVM carrier inside U7, through the REAL api-relay: authorized paths work; every wrong lease, endpoint, tunnel or attestation fails; the phone row gets nothing else through any fallback", { skip, timeout: 240000 }, async (t) => {
  const dir = tmpdir("pvm-u7-"), ca = makeCa(dir);
  const vmA = await startFakeVm({ dir, ca, code: PVMCODE, appId: APP, instance: newInstance() }); t.after(() => vmA.close());
  const vmC = await startFakeVm({ dir, ca, code: OTHER_CODE, appId: APP, instance: newInstance() }); t.after(() => vmC.close());
  const operator = privateKeyToAccount(generatePrivateKey());
  const app = await appHost(t);
  const EP = (n) => `${ORIGIN}/t/${n}`;
  const DP = D("a1"), DOTHER = D("b2"), DELIG = D("c3"), DEXP = D("d4"), DWRONG = D("e5"), DBOX = D("f6"), DC = D("07"), DSHORT = D("18");
  const state = { ledger: [
    { id: DP, runner: "0x" + "0".repeat(64), leaseUntil: 0 },                        // not leased yet: the bootstrap moment
    { id: DOTHER, runner: idOf(EP("pixel-b")), leaseUntil: nowS() + 3600 },          // another phone holds it (not attached)
    { id: DELIG, runner: idOf(app.endpoint), leaseUntil: nowS() + 3600 },            // an ELIGIBLE (non-phone) host holds it
    { id: DEXP, runner: idOf(EP("pixel-a")), leaseUntil: nowS() - 60 },              // pixel-a's lease, expired
    { id: DWRONG, runner: idOf(`${ORIGIN}/t/pixel-a/elsewhere`), leaseUntil: nowS() + 3600 },   // not the tunnel's own public URL
    { id: DBOX, runner: idOf(EP("box1")), leaseUntil: nowS() + 3600 },               // a token tunnel whose hello says avf
    { id: DC, runner: idOf(EP("pixel-c")), leaseUntil: nowS() + 3600 },              // a phone whose attestation is refused
  ], registry: new Map([[idOf(EP("pixel-a")).toLowerCase(), operator.address.toLowerCase()]]) };   // pixel-a's endpoint is registered to the owner
  const chain = stubChain(state); await new Promise((r) => chain.listen(0, "127.0.0.1", r)); t.after(() => chain.close());
  const { port, log } = await spawnRelay(t, { preload: true, chainPort: chain.address().port, labRoot: ca.rootPin, rid: vmA.rid, app, dir });
  const rows = async () => { const j = await fetch(`http://127.0.0.1:${port}/enclaves`).then((r) => r.json()).catch(() => null); return ((j && j.enclaves) || []).filter((e) => e.endpoint === "tunnel://pixel-a"); };
  const ev = (p, h = {}) => req(port, "POST", p, `EVIDENCE3 ${randomBytes(32).toString("hex")}\n`, h);
  const isCarrier = (r) => r.headers["content-security-policy"] === "sandbox; default-src 'none'";

  // ---- the phones: pixel-a (registered: its attach must carry the owner's co-signature), a token box, a refused build ----
  const bare = await phone(port, "pixel-a", { vm: vmA, ca, dir }); t.after(() => bare.close());
  assert.equal(bare.result.ok, false); assert.match(bare.result.reason, /registered on chain; attach must carry operatorSig/, "a registered name: no co-signature, no attach");
  let A = await phone(port, "pixel-a", { vm: vmA, ca, dir, operator }); t.after(() => A.close());
  assert.equal(A.result.ok, true, JSON.stringify(A.result)); assert.equal(A.abi2 && A.abi2.ok, true, JSON.stringify(A.abi2));
  const box = await phone(port, "box1", { vm: vmA, ca, dir, tokenAttach: true }); t.after(() => box.close());
  const C = await phone(port, "pixel-c", { vm: vmC, ca, dir, code: OTHER_CODE }); t.after(() => C.close());
  assert.equal(C.result.ok, false); assert.match(C.result.reason, /codeHash/);
  await until(async () => (await rows()).length === 1, 15000, "pixel-a's row");

  // ---- the BOOTSTRAP route: before any lease ----
  const boot = await ev("/t/pixel-a/pvm/evidence");
  assert.equal(boot.status, 200, JSON.stringify(boot)); assert.equal(JSON.parse(boot.body.split("\n")[0]).format, "enclave-pvm-app-evidence/v3"); assert.ok(isCarrier(boot));
  assert.equal((await ev(`/x/${DP}/pvm/evidence`)).status, 404, "no lease yet: no /x route");
  // ---- the lease lands: /x/<D>/pvm routes to the holder's hub-verified pVM tunnel (the one fresh read on a miss finds it) ----
  state.ledger[0] = { id: DP, runner: idOf(EP("pixel-a")), leaseUntil: nowS() + 3600 };
  await new Promise((r) => setTimeout(r, 5200));   // U7's fresh-read cooldown shares the relay's ledger cache
  const hdrs = { authorization: `Bearer ${SENTINEL}`, "proxy-authorization": `Basic ${SENTINEL}`, cookie: `session=${SENTINEL}; enclave_sso=${SENTINEL}` };
  const x = await ev(`/x/${DP}/pvm/evidence`, hdrs);
  assert.equal(x.status, 200, JSON.stringify(x)); assert.equal(JSON.parse(x.body.split("\n")[0]).format, "enclave-pvm-app-evidence/v3");
  assert.ok(isCarrier(x) && x.headers["x-content-type-options"] === "nosniff" && x.headers["set-cookie"] === undefined, JSON.stringify(x.headers));
  const sealed = await req(port, "POST", `/x/${DP}/pvm/sealed`, SEALED_PROBE, hdrs);
  assert.equal(sealed.status, 200, JSON.stringify(sealed)); assert.match(sealed.body, /unknown evidence nonce/, "the sealed stream reached the VM, which answered itself");
  assert.ok(isCarrier(sealed) && sealed.headers["set-cookie"] === undefined);
  assert.ok(!Buffer.concat(A.rec.toVm).includes(SENTINEL), "no Authorization, Proxy-Authorization or Cookie reached the VM: the carrier forwards the body only");
  assert.deepEqual(A.rec.streams, ["pvm-evidence", "pvm-evidence", "pvm-app-sealed"]);

  // ---- refusals: another holder, an eligible holder, expired, the wrong endpoint, a token tunnel, a refused attestation ----
  const s0 = A.rec.streams.length;
  for (const [id, what] of [[DOTHER, "another phone holds it"], [DELIG, "an ELIGIBLE non-phone host holds it"], [DEXP, "an expired lease"], [DWRONG, "not the tunnel's own public URL"],
                            [DBOX, "a token tunnel whose hello says avf"], [DC, "a phone whose attestation was refused"]]) {
    const r = await ev(`/x/${id}/pvm/evidence`); assert.equal(r.status, 404, what); assert.equal(r.body, "", what); assert.ok(isCarrier(r), what);
  }
  assert.equal(A.rec.streams.length, s0, "none of them reached pixel-a"); assert.deepEqual(box.rec.streams, [], "the token box never got a stream");
  assert.ok(!app.seen.some((l) => l.includes("/pvm/")), "the eligible host never saw a pvm request: the carve-out resolves phone rows only");
  const tbox = await ev("/t/box1/pvm/evidence"); assert.equal(tbox.status, 503); assert.equal(JSON.parse(tbox.body).error, "host_ineligible", "a token tunnel's /t path is U7's");

  // ---- the phone row gets NOTHING else: every other path, method, host, upgrade and plane is U7's ----
  const reqs0 = A.rec.reqs.length, s1 = A.rec.streams.length, lbl = DP.slice(2, 10);
  const u7 = (r, what) => { assert.ok(!isCarrier(r), `${what}: not the carrier`); assert.ok(r.status === 503 || r.status === 404 || r.status === 403, `${what}: ${r.status} ${r.body.slice(0, 160)}`); };
  for (const [m, p] of [["GET", `/x/${DP}/`], ["POST", `/x/${DP}/v1/chat`], ["GET", `/x/${DP}/pvm/evidence`], ["PUT", `/x/${DP}/pvm/sealed`],
                        ["POST", `/x/${DP}/pvm/evidence/`], ["POST", `/x/${DP}/pvm/evidence/x`], ["POST", `/X/${DP}/pvm/evidence`], ["POST", `/x/${DP}/PVM/evidence`],
                        ["POST", `/x/${DP}/pvm/..%2Fevidence`], ["POST", `/x/${DP}/pvm%252Fevidence`], ["POST", `/x/${DP}//pvm/evidence`], ["POST", `/x/${DP}/./pvm/evidence`],
                        ["POST", `/x/${DP}/pvm/evidence?q=1`], ["POST", `/x/0x${lbl}/pvm/evidence`],
                        ["POST", "/t/pixel-a/pvm/sealed"], ["POST", "/t/pixel-a/v1/chat"], ["POST", "/t/pixel-a/pvm/evidence/"], ["POST", "/t/pixel-a/x/../pvm/evidence"],
                        ["POST", "/t/pixel-a/PVM/evidence"], ["POST", "/t/pixel-a/pvm/%65vidence"], ["POST", "/t/pixel-a/pvm/evidence?x"], ["GET", "/t/pixel-a/pvm/evidence"]]) {
    const r = await req(port, m, p, m === "GET" ? "" : `EVIDENCE3 ${"ab".repeat(32)}\n`, hdrs); u7(r, `${m} ${p}`);
  }
  // a NON-ledger id (no 0x) is U7's probe over ELIGIBLE hosts only: here the eligible app host answers it, never the phone
  { const r = await req(port, "POST", `/x/${lbl}/pvm/evidence`, "x", hdrs); assert.ok(!isCarrier(r)); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).servedBy, "app"); }
  for (const [m, p] of [["GET", "/"], ["POST", "/pvm/evidence"], ["POST", "/v1/chat"]]) {
    const r = await req(port, m, p, m === "GET" ? "" : "x", { ...hdrs, host: `${lbl}.app.test` }); u7(r, `the app subdomain ${m} ${p}`);
  }
  for (const [p, host] of [[`/x/${DP}/`, null], [`/x/${DP}/pvm/evidence`, null], ["/", `${lbl}.app.test`], ["/pvm/evidence", `${lbl}.app.test`], ["/t/pixel-a/ws", null]]) {
    const code = await upgrade(port, p, host); assert.notEqual(code, 101, `a WebSocket to ${host || ""}${p} is refused (${code})`); assert.ok(code >= 400 || code === 0, `${host || ""}${p}: ${code}`);
  }
  // v1 control: the deployment's status is the relay's own ledger answer (no host is asked); every call that would reach
  // the host is U7's refusal -- and none of them reaches the phone
  { const r = await req(port, "GET", `/v1/deployments/${DP}`, "", hdrs); assert.ok(r.status === 200 ? JSON.parse(r.body).id === DP : true, r.body.slice(0, 200)); }
  for (const [m, p] of [["POST", `/v1/deployments/${DP}/stop`], ["GET", `/v1/deployments/${DP}/logs`], ["POST", `/v1/deployments/${DP}/restart`], ["PATCH", `/v1/deployments/${DP}`]]) {
    const r = await req(port, m, p, m === "GET" ? "" : "{}", { ...hdrs, "content-type": "application/json" }); u7(r, `v1 control ${m} ${p}`);
  }
  // certificates: the registered operator signs a real CSR for the lease holder's own label -- U7 refuses on eligibility
  const certs = await import("../relay/certs.js");
  const key = path.join(dir, "leaf.key"), csrPem = path.join(dir, "leaf.csr"), name = `${lbl}.app.test`;
  execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key], { stdio: "pipe" });
  execFileSync("openssl", ["req", "-new", "-key", key, "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`, "-out", csrPem], { stdio: "pipe" });
  const csr = fs.readFileSync(csrPem, "utf8"), { spkiHash } = certs.parseCsr(csr, name), ts = nowS();
  const cr = await req(port, "POST", "/v1/certs/issue", JSON.stringify({ name, csr, endpoint: EP("pixel-a"), ts, opSig: await operator.signMessage({ message: certs.issueMessage(name, EP("pixel-a"), spkiHash, ts) }) }), { "content-type": "application/json" });
  assert.equal(cr.status, 403, cr.body); assert.equal(JSON.parse(cr.body).error, "host_ineligible", "certificates: U7's refusal, not 'disabled' or an earlier check");
  // secrets: the lease holder's fetch, with the fleet HMAC AND its registered operator's signature -- U7 refuses on eligibility
  const { fetchSig } = await import("../relay/secrets.js"), ts2 = nowS();
  const sr = await req(port, "POST", "/v1/secrets/fetch", JSON.stringify({ id: DP, endpoint: EP("pixel-a"), ts: ts2, sig: fetchSig("5e".repeat(32), DP, EP("pixel-a"), ts2),
    opSig: await operator.signMessage({ message: `enclave-secrets-fetch:${DP}:${EP("pixel-a")}:${ts2}` }) }), { "content-type": "application/json" });
  assert.equal(sr.status, 403, sr.body); assert.equal(JSON.parse(sr.body).error, "host_ineligible", "secrets: U7's refusal");
  assert.equal(A.rec.streams.length, s1, "no stream reached the phone on any of those");
  assert.ok(A.rec.reqs.slice(reqs0).every((l) => /^GET \/(availability|health|v1\/health)$/.test(l)), `only its own surfaces were asked of the phone: ${JSON.stringify(A.rec.reqs.slice(reqs0))}`);
  // its own surface is still reachable
  const own = await req(port, "GET", "/t/pixel-a/availability"); assert.equal(own.status, 200, JSON.stringify(own));

  // ---- an IN-PLACE re-attach (same transport key, fresh nonce, the owner's co-signature, NO caps): routed, one row, no tier ----
  const A2 = await phone(port, "pixel-a", { vm: vmA, ca, dir, operator }); t.after(() => A2.close());
  assert.equal(A2.result.ok, true); assert.equal(A2.abi2 && A2.abi2.ok, true);
  await until(() => A.closed(), 5000, "the hub to close the superseded socket");
  const x2 = await ev(`/x/${DP}/pvm/evidence`); assert.equal(x2.status, 200, JSON.stringify(x2)); assert.deepEqual(A2.rec.streams, ["pvm-evidence"]);
  const rr = await until(async () => { const r = await rows(); return r.length === 1 && r[0].publicUrl === EP("pixel-a") ? r : null; }, 10000, "one row");
  assert.equal(rr[0].tier, undefined, "no tier on an in-place re-attach"); assert.equal(rr[0].eligible, false); assert.equal(rr[0].serving, false);
  assert.equal(JSON.parse((await req(port, "GET", `/x/${DP}/`)).body).error, "host_ineligible", "still no tenant path after the re-attach");

  // ---- a lease that lapses mid-session: routed, then refused at the next request ----
  state.ledger.push({ id: DSHORT, runner: idOf(EP("pixel-a")), leaseUntil: nowS() + 12 });
  await new Promise((r) => setTimeout(r, 5200));
  assert.equal((await ev(`/x/${DSHORT}/pvm/evidence`)).status, 200, "the live short lease");
  await until(() => nowS() > state.ledger.at(-1).leaseUntil + 1, 20000, "the lapse");
  await new Promise((r) => setTimeout(r, 2500));   // the VM's own evidence pace
  assert.equal((await ev(`/x/${DSHORT}/pvm/evidence`)).status, 404, "lapsed mid-session: the next request is refused");
  // the carrier's log names only the exact routes it claimed
  assert.doesNotMatch(log(), /\[pvm-serving\][^\n]*"id":"0x[0-9a-f]{8}"/, "a prefix was never claimed");
});
