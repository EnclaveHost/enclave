// The designated lease relay's host-role SUPERVISOR (network/host-services/lease-relay-host.mjs runHostRelay):
//   1. lifecycle, with a scripted spawn and a stub gate:
//      - a start error with no 'exit' (the process never existed) is finalized and restarted after its backoff;
//      - 'error' and 'exit' for one child end it exactly once, and a spawn that throws is handled the same way;
//      - stop() while a gate check is still pending starts nothing afterwards, and clears a pending restart;
//      - the restart backoff doubles and frequent gate checks never bypass it;
//      - relay.heapMiB is the V8 heap cap passed as --max-old-space-size (relay.memoryMiB, its earlier name, is the same
//        cap; both together are refused);
//   2. the REAL platform host policy gate (network/host-service-gate.mjs -> host-policy-runtime.mjs -> platform-host-policy.mjs,
//      nothing stubbed), fed through the runner's policy carriers (runner.mjs policyEnv + policyCarrierFetch ->
//      network/policy-carriers.mjs), on a real local chain (the independent rig's registry, a deployed EnclaveAddressBook
//      owned by the admin, an EnclaveHostOwnership): with EMPTY policy state, an ACTIVATED anchored policy and every fleet
//      policy mirror refused at the transport, the relay host cold-starts from an operator-imported signed document; a host
//      with only the fleet mirrors never starts; the admin's anchored ban stops the relay, the next anchored policy restarts it.
//      The supervised process in part 2 is a real child process started from a pinned FIXTURE package (it only serves
//      /v1/info): what is under test is the supervisor and the gate. The real relay package runs under the same supervisor in
//      test/lease-designated-relays.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRig, haveTools, KEYS, freePort } from "./helpers/cli-independent-rig.mjs";
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from "../network/platform-host-policy.mjs";
import { PRODUCTION_MIRRORS } from "../network/platform-host-policy-config.mjs";
import { runHostRelay, initRelayKey, validateHostRelayConfig, planHostRelay } from "../network/host-services/lease-relay-host.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "contracts/foundry/out");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-relay-host-policy-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, what) => { const end = Date.now() + ms; for (;;) { try { if (await f()) return; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); } };

// ---- the fixture package: a pinned manifest + a tiny "relay" that serves /v1/info on LEASE_RELAY_LISTEN --------------
const PKG = path.join(tmp, "packages");
fs.mkdirSync(PKG, { recursive: true });
const BUNDLE = Buffer.from(`import http from "node:http";
const [h, p] = process.env.LEASE_RELAY_LISTEN.split(/:(?=[0-9]+$)/);
http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ fixture: true, pid: process.pid })); }).listen(Number(p), h);
`);
fs.writeFileSync(path.join(PKG, "lease-relay.mjs"), BUNDLE);
const MANIFEST = Buffer.from(JSON.stringify({ format: "enclave-host-service-package/v1", role: "lease-relay", entry: "network/lease-relay-service.mjs", kind: "relay",
  bundle: "lease-relay.mjs", bundleSha256: sha(BUNDLE), bytes: BUNDLE.length }));
fs.writeFileSync(path.join(PKG, "lease-relay.package.json"), MANIFEST);
const PIN = "sha256:" + sha(MANIFEST);
const RECORD = path.join(tmp, "deployment.json"); fs.writeFileSync(RECORD, "{}");

function relayCfg(name, { port = 1, relay = {}, ...top } = {}) {
  return { format: "enclave-host-relay/v1", host: { endpoint: `https://relay-${name}.policy-placement.net`, publicEndpoints: [] },
    platformHostPolicy: "production", packagesDir: PKG, stateRoot: path.join(tmp, `relay-${name}`),
    relay: { package: PIN, port, bind: "127.0.0.1", record: RECORD, digest: "sha256:" + "ab".repeat(32), rpc: ["https://rpc-a.example", "https://rpc-b.example"],
      quorum: 2, maxFloatEth: "0.001", minFloatEth: "0.0001", ...relay }, ...top };
}

// ---- 1. lifecycle -----------------------------------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(sig) { this.signals.push(sig); if (this.pid !== undefined && this.exitCode === null) setImmediate(() => { this.signalCode = sig; this.emit("exit", null, sig); }); return true; }
}
/** spawn(script): the i-th spawn follows script[i] (the last repeats): "throw" (spawn throws), a function run on the child,
 *  or { noPid: true, run } (a child whose process never existed, as when spawning fails asynchronously). */
function scripted(script) {
  const calls = [];
  const spawn = (cmd, argv) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    if (step === "throw") { calls.push({ at: Date.now(), argv, child: null }); const e = new Error("spawn EAGAIN"); e.code = "EAGAIN"; throw e; }
    const child = new FakeChild(step?.noPid ? undefined : 1000 + calls.length);
    calls.push({ at: Date.now(), argv, child });
    const run = typeof step === "function" ? step : step?.run;
    if (run) setImmediate(() => run(child));
    return child;
  };
  return { spawn, calls };
}
const stubGate = (over = {}) => ({ check: async () => {}, serviceRefusal: () => null, start() {}, stop() {}, status: () => ({ platformHostPolicy: "stub" }), ...over });
const fail = (code) => (c) => { const e = new Error(`spawn ${code}`); e.code = code; c.emit("error", e); };
const live = () => {};
const quiet = { log: () => {} };
let keyed = 0;
async function lifecycleCfg(over = {}) { const c = relayCfg(`life-${++keyed}`, over); await initRelayKey(c); return c; }

test("a start error with no exit event is finalized once and restarted after its backoff (the old supervisor kept the dead child forever)", async () => {
  const { spawn, calls } = scripted([{ noPid: true, run: fail("ENOMEM") }, live]);
  const r = await runHostRelay(await lifecycleCfg(), { gate: stubGate(), spawn, backoffMs: 30, intervalMs: 1000, ...quiet });
  await until(() => calls.length === 2, 3000, "the restart after a start error");
  const s = r.status();
  assert.equal(s.running, true); assert.equal(s.restarts, 1); assert.equal(s.lastExit.error, "ENOMEM");
  await r.stop();
});

test("'error' and 'exit' for the same child end it exactly once; 'error' on a running child only logs; a throwing spawn is handled", async () => {
  const logs = [];
  const { spawn, calls } = scripted([(c) => {
    const e = new Error("kill EPERM"); e.code = "EPERM";
    c.emit("error", e);                                              // a signal could not be delivered: it is still running
    setTimeout(() => { c.exitCode = 1; c.emit("exit", 1, null); c.emit("error", new Error("late")); }, 20);
  }, "throw", live]);
  const r = await runHostRelay(await lifecycleCfg(), { gate: stubGate(), spawn, backoffMs: 40, intervalMs: 1000, log: (m) => logs.push(m) });
  await until(() => calls.length === 3, 3000, "exit -> restart -> throwing spawn -> restart");
  await sleep(200);
  assert.equal(calls.length, 3, "no extra restart from the duplicate end report");
  const s = r.status();
  assert.equal(s.restarts, 2, "one end for the exited child, one for the spawn that threw"); assert.equal(s.running, true);
  assert.ok(logs.some((l) => /EPERM; still running/.test(l)));
  assert.ok(logs.some((l) => /could not start \(EAGAIN\)/.test(l)));
  await r.stop();
});

test("stop() while a gate check is pending starts nothing afterwards and clears the pending restart", async () => {
  let pending = null, checks = 0;
  const gate = stubGate({ check: () => (++checks === 1 ? Promise.resolve() : (pending ||= deferred()).promise) });
  const { spawn, calls } = scripted([(c) => setTimeout(() => { c.exitCode = 0; c.emit("exit", 0, null); }, 30), live]);
  const r = await runHostRelay(await lifecycleCfg(), { gate, spawn, backoffMs: 300, intervalMs: 10, ...quiet });
  await until(() => pending && r.status().restartPending, 3000, "a restart pending while a gate check is outstanding");
  await r.stop();
  assert.equal(r.status().restartPending, false, "stop clears the pending restart");
  pending.resolve();
  await sleep(500);
  assert.equal(calls.length, 1, "nothing was started after stop()");
});
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test("the restart backoff doubles up to its cap, and gate checks every 5 ms never bypass it", async () => {
  const { spawn, calls } = scripted([(c) => { c.exitCode = 1; c.emit("exit", 1, null); }]);
  const r = await runHostRelay(await lifecycleCfg(), { gate: stubGate(), spawn, backoffMs: 40, maxBackoffMs: 160, intervalMs: 5, ...quiet });
  await sleep(900);
  await r.stop();
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  assert.ok(calls.length >= 5 && calls.length <= 8, `spawns ${calls.length}, gaps ${gaps}`);
  const want = [40, 80, 160, 160, 160, 160, 160];
  gaps.forEach((g, i) => assert.ok(g >= want[i] - 5, `gap ${i} = ${g} ms, backoff ${want[i]} ms (gaps ${gaps})`));
});

test("relay.heapMiB is the V8 heap cap (--max-old-space-size); relay.memoryMiB is the same cap under its earlier name", async () => {
  for (const [relay, want] of [[{ heapMiB: 200 }, 200], [{ memoryMiB: 192 }, 192], [{}, 256]]) {
    const { spawn, calls } = scripted([live]);
    const r = await runHostRelay(await lifecycleCfg({ relay }), { gate: stubGate(), spawn, ...quiet });
    assert.equal(calls[0].argv[0], `--max-old-space-size=${want}`);
    assert.equal(r.status().heapMiB, want);
    await r.stop();
  }
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { relay: { heapMiB: 200, memoryMiB: 200 } })), /same V8 heap cap: give one/);
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { relay: { heapMiB: 64 } })), /128 to 1024 \(the V8 old-space heap cap, not a process memory limit\)/);
  assert.equal("memoryMiB" in validateHostRelayConfig(relayCfg("x", { relay: { memoryMiB: 300 } })).relay, false, "normalized to heapMiB only");
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { platformHostPolicyCarriers: { importDir: "relative" } })), /absolute path/);
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { platformHostPolicyCarriers: { serviceIndex: true } })), /needs the pinned serviceIndex/);
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { platformHostPolicy: "off", platformHostPolicyCarriers: { peers: [] } })), /nothing would use them/);
  assert.throws(() => validateHostRelayConfig(relayCfg("x", { platformHostPolicyCarriers: { peers: ["ftp://x"] } })), /distinct http\(s\) base URLs/);
});

// ---- 2. the real gate and carriers, cold, with the fleet down ---------------------------------------------------------
const skip = haveTools() || false;                                    // node:test skips on any non-false value, null included
const DO = ["134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"];
const Z32 = "0x" + "00".repeat(32);
const KEY4 = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";   // anvil #4
const admin = privateKeyToAccount(KEYS.deployer);                                       // the book's owner: the admin
const OP = { a: privateKeyToAccount(KEYS.other), c: privateKeyToAccount(KEY4) }, OP_KEY = { a: KEYS.other, c: KEY4 };
const denied = [];
const netFetch = (url, opts) => {
  const u = new URL(url);
  if (DO.includes(u.hostname)) { denied.push(u.href); return Promise.reject(new TypeError("connect ECONNREFUSED (DigitalOcean down)")); }
  if (u.hostname === "127.0.0.1") return fetch(u, opts);
  return Promise.reject(new TypeError(`no route to ${u.hostname}`));
};
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
let rig, book, bookAbi, ownership, registryAddr, docs = [], hosts = {};
const POLICY = () => ({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: [...PRODUCTION_MIRRORS], activation: "required" });
async function sign(deny) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registryAddr.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: "denylist", deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) };
  docs.push(d); return d;
}
const anchor = async (digest) => { const a = encodeAnchor(digest); await rig.write(rig.wc(KEYS.deployer), book, bookAbi, "setMany", [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); await rig.mine(); };
// the operator imports a signed document (any channel): the importDir carrier
const importDoc = (dir, d) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${d.digest}.json`), JSON.stringify({ document: d.document, signature: d.signature })); };
const up = (port) => fetch(`http://127.0.0.1:${port}/v1/info`).then((r) => r.ok, () => false);
const diag = () => Object.values(hosts).map((h) => `--- ${h.name}: ${JSON.stringify(h.running?.status?.() ?? null).slice(0, 1500)}\n${h.logs.slice(-20).join("\n")}`).join("\n");
const wait = async (f, ms, what) => { try { await until(f, ms, what); } catch (e) { throw new Error(`${e.message}\n${diag()}`); } };

async function startRelayHost(name, { carriers }) {
  const port = await freePort();
  const cfg = relayCfg(name, { port, platformHostPolicy: POLICY(), platformHostPolicyRpcs: rig.rpcs, ...(carriers ? { platformHostPolicyCarriers: carriers } : {}) });
  await initRelayKey(cfg);
  assert.equal(fs.existsSync(path.join(cfg.stateRoot, "host-policy")), false, "empty policy cache: no admission or policy state");
  const logs = [];
  const running = await runHostRelay(cfg, { fetch: netFetch, log: (m) => logs.push(m), intervalMs: 300, gateIntervalMs: 300, backoffMs: 200 });
  return (hosts[name] = { name, cfg, port, running, logs });
}

before(async () => {
  if (skip) return;
  rig = await startRig();
  registryAddr = rig.addresses.registry;
  const B = art("EnclaveAddressBook.sol", "EnclaveAddressBook"); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, "set", [stringToHex("registry", { size: 32 }), registryAddr]);
  ownership = await rig.deploy(art("EnclaveHostOwnership.sol", "EnclaveHostOwnership"), [registryAddr]);
  for (const n of ["a", "c"])
    await rig.write(rig.wc(OP_KEY[n]), registryAddr, rig.A.registry4.abi, "register", [`https://relay-${n}.policy-placement.net`, "independent/host", Z32, 1000n, 0n, "0x" + "00".repeat(20)]);
  // ACTIVATED before any relay host exists: the admin's first policy (it bans an unrelated operator), signed and anchored
  await sign([{ kind: "operator", value: "0x" + "5a".repeat(20), reason: "unrelated abuse" }]);
  await anchor(docs[0].digest);
  for (let i = 0; i < 3; i++) await rig.mine();
});
after(async () => {
  for (const h of Object.values(hosts)) await h.running?.stop().catch(() => {});
  await rig?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("REAL gate: a relay host cold-starts from an imported signed policy with every fleet mirror refused; a fleet-only host never starts", { skip, timeout: 240_000 }, async () => {
  const importDir = path.join(tmp, "import-a");
  importDoc(importDir, docs[0]);
  const a = await startRelayHost("a", { carriers: { importDir } });
  await wait(() => up(a.port), 40000, "relay A started by the supervisor under the real gate");
  const s = a.running.status();
  assert.equal(s.refusal, null); assert.equal(s.platformHostPolicy.serving, true, JSON.stringify(s.platformHostPolicy));
  assert.equal(s.platformHostPolicy.runtime.accepted.digest, docs[0].digest); assert.equal(s.platformHostPolicy.runtime.anchor, "anchored");
  assert.ok(denied.some((u) => u.startsWith(PRODUCTION_MIRRORS[0])), "the gate tried the fleet mirrors, and they were refused");

  const c = await startRelayHost("c", { carriers: null });           // the production default alone: fleet mirrors only
  await sleep(5000);
  assert.equal(await up(c.port), false, "relay C must not start");
  const sc = c.running.status();
  assert.equal(sc.running, false);
  assert.match(String(sc.refusal), /has not loaded the policy the book anchors|anchored policy is not available/, JSON.stringify(sc));
  await c.running.stop();
});

test("REAL gate: the admin's anchored ban stops the relay (sticky); the next anchored policy restarts it; stop() ends it for good", { skip, timeout: 240_000 }, async () => {
  const a = hosts.a, importDir = path.join(tmp, "import-a");
  const ban = await sign([...docs[0].policy.deny, { kind: "operator", value: OP.a.address.toLowerCase(), reason: "abuse report 9" }]);
  importDoc(importDir, ban);                                          // published (here: imported) before anchoring
  await anchor(ban.digest);
  await wait(async () => !(await up(a.port)) && !a.running.status().running, 40000, "relay A stopped by the ban");
  const sb = a.running.status();
  assert.match(String(sb.refusal), /banned by platform policy #2 \(operator\): abuse report 9/);
  assert.ok(a.logs.some((l) => /STOPPING the relay/.test(l)));
  await sleep(2000);
  assert.equal(await up(a.port), false, "stays stopped while the ban is anchored");

  const unban = await sign(docs[0].policy.deny);
  importDoc(importDir, unban);
  await anchor(unban.digest);
  await wait(() => up(a.port), 40000, "relay A serves again after the authenticated unban");
  const s2 = a.running.status();
  assert.equal(s2.refusal, null); assert.equal(s2.platformHostPolicy.runtime.accepted.sequence, 3);
  assert.ok(a.logs.some((l) => /admitted again/.test(l)));

  await a.running.stop();
  await sleep(1500);
  assert.equal(await up(a.port), false); assert.equal(a.running.status().running, false); assert.equal(a.running.status().restartPending, false);
});
