// Independent pVM hosting, end to end in one process, with enclave.host BLOCKED (every request recorded; any Enclave name
// refused): the REAL host agent (shielded/anchor/avf/runner/host-agent.mjs) in independent mode, the REAL platform host
// policy gate (network/host-policy-runtime.mjs over the root's policy world: agreeing RPCs, an admin-signed anchored policy
// from a TLS mirror), the REAL capacity publisher (independent-runtime.mjs + network/host-capacity-producer.mjs, records
// verified by network/host-capacity.mjs), and the REAL relay-free admission verifier (network/pvm-independent-admission.mjs:
// the relay's own verifier code) reaching the agent's REAL host surface through an opaque pipe.
// FIXTURES, labelled: the chain the agent reads is scripted (the real-contract lifecycle is test/pvm-independent-runner.test.mjs);
// the phone's VMs are simulated, with real keys and v4 evidence over a synthetic AVF chain from a TEST root (never Google's);
// the runner is a stand-in that claims/releases ONLY through the app-funded lease sender it is given (a recording stand-in for
// the gas worker's sender); component bytes are pre-cached as the verifier's CID-verified fetch would return them.
import test from "node:test";
import net from "node:net";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { keccak256, stringToBytes, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { operatorMessage } from "../custody/v2/protocol.mjs";
import { createHostAgent, checkHostConfig } from "../shielded/anchor/avf/runner/host-agent.mjs";
import { slotPorts } from "../shielded/anchor/avf/runner/pvm-device.mjs";
import { checkIndependentProfile, independentHostConfig, INDEPENDENT_FORMAT } from "../shielded/anchor/avf/runner/independent.mjs";
import { hostPolicyGate, capacityPublisher } from "../shielded/anchor/avf/runner/independent-runtime.mjs";
import { createPvmIndependentAdmission, hostSurfaceTransport } from "../network/pvm-independent-admission.mjs";
import { resolveHostPolicyConfig, createHostPolicyRuntime } from "../network/host-policy-runtime.mjs";
import { leaseHostAdmission } from "../network/host-policy-adapters.mjs";
import { verifyHostCapacity } from "../network/host-capacity.mjs";
import { hostLiveness } from "../network/host-liveness.mjs";
import { platformPolicyWorld, BOOK, OWNERSHIP } from "./helpers/platform-policy-world.mjs";
import { fixtureInputs, fixtureVm, networkGuard, caFetch, stableChain, opaquePipe, serveStatic, tmpdir, haveOpenssl, sha } from "./helpers/pvm-independent-world.mjs";

const skip = !haveOpenssl && "no openssl";
const operator = privateKeyToAccount("0x" + "71".repeat(32)), hostKey = privateKeyToAccount("0x" + "72".repeat(32)), otherHostKey = privateKeyToAccount("0x" + "73".repeat(32));
const me = operator.address.toLowerCase(), ownerWallet = "0x" + "0e".repeat(20);
const ENDPOINT = "https://phone.example.org/pixel10", E = keccak256(stringToBytes(ENDPOINT));
const A = (n) => "0x" + n.repeat(20), ADDRS = { registry: A("a1"), deployments: A("a2"), proofOfTime: A("a3"), appCatalog: A("a4") };
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32), APPID = "0x" + "ab".repeat(32);
const ZERO32 = "0x" + "00".repeat(32);
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

async function world(t) {
  const dir = tmpdir("pvm-ind-life-"), fx = fixtureInputs(dir), cache = path.join(dir, "cache"); fs.mkdirSync(cache);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // the platform's admin policy world: this host registered, active, operated by `operator`, owned by the host owner's wallet
  const pw = await platformPolicyWorld(t, { hosts: { [E.toLowerCase()]: { active: true, operator: me, owner: ownerWallet, endpoint: ENDPOINT } } });
  const guard = networkGuard(["127.0.0.1"]);   // loopback only: no enclave.host, nothing public
  guard.install(); t.after(() => guard.restore());
  const policyRpcs = await stableChain(t, pw.rpcs, guard.fetch);
  await pw.publish({ deny: [] });              // the admin's current, anchored policy (bans nobody yet)
  // two directories (capacity records) and component replicas, on loopback; directory B is down until set up
  const posted = { a: [], b: [] }; let dirBUp = false;
  const dirA = await serveStatic({ "/v1/host-capacity": async (req) => { const c = []; for await (const x of req) c.push(x); posted.a.push(JSON.parse(Buffer.concat(c))); return "{}"; } });
  const dirB = await serveStatic({ "/v1/host-capacity": async (req) => { if (!dirBUp) return { status: 503, body: "down" }; const c = []; for await (const x of req) c.push(x); posted.b.push(JSON.parse(Buffer.concat(c))); return "{}"; } });
  t.after(() => { dirA.close(); dirB.close(); });
  const profile = checkIndependentProfile({ format: INDEPENDENT_FORMAT, registeredEndpoint: ENDPOINT,
    chain: { chainId: "8453", addressBook: BOOK, rpcs: ["http://127.0.0.1:18545", "http://127.0.0.1:18546"], quorum: 2 },
    directories: [dirA.origin, dirB.origin], gateways: ["http://127.0.0.1:18101", "http://127.0.0.1:18102"],
    verifierInputs: { sha256: fx.sha256, sources: ["http://127.0.0.1:18201/pvm.json", "http://127.0.0.1:18202/pvm.json"] },
    platformPolicy: { mode: "explicit", config: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [pw.mirrorOrigin], rpcs: policyRpcs } },
    leaseGas: { file: "/srv/lease-gas.json", digest: "cd".repeat(32), rpcs: ["http://127.0.0.1:18545", "http://127.0.0.1:18546"], relays: ["http://127.0.0.1:18301"] }, capacity: { lifetimeSec: 60 } });
  // components (pre-cached, CID-keyed) and the idle app
  const component = (n) => Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]), Buffer.from(`wasi:http/incoming-handler app ${n}`)]);
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(cache, `bafyapp000000${n}.wasm`), component(n));
  const bundleDir = path.join(dir, "bundle"); fs.mkdirSync(bundleDir); fs.writeFileSync(path.join(bundleDir, "idle-app.wasm"), "\0asm idle");
  const idleSha = sha(fs.readFileSync(path.join(bundleDir, "idle-app.wasm")));
  const hostVm = fixtureVm(dir, fx.ca);
  const files = path.join(dir, "files"); fs.mkdirSync(files);
  const cfg = independentHostConfig({ build: { maxFeePerGasWei: "500000000", repo: "lab/pvm-independent", defaultPriceCpuPerSec6: "2", minWithdraw6: "1000000" }, setup: { name: "pixel10" },
    operator: me, codeHash: fx.doc.codeHashes[0], instanceIds: [hostVm.instanceId], files, apk: path.join(dir, "base.apk"), controlPort: 18190, bundleDir, profile, inputs: fx.doc,
    poolMemMb: 1536, ports: { agent: 18187, attach: 18188, egress: 18189, router: 17780 } });
  cfg.slots.count = 3; cfg.ipfs.cacheDir = cache; cfg.slots.routerPort = await freePort(); cfg.egress.port = await freePort();
  assert.equal(checkHostConfig(cfg).enclaveId, E);
  let T = Date.now();
  const now = () => T, sec = () => Math.floor(T / 1000);
  // ---- the chain the agent reads (SCRIPTED fixture) ----
  const reg = { operator: operator.address, active: true, proofKey: hostKey.address, measurement: "0x" + fx.doc.codeHashes[0], registeredAt: BigInt(sec() - 3600), endpoint: ENDPOINT };
  const row = (id, over) => ({ id, owner: ownerWallet, appRef: `catalog://${APPID}/${id === D1 ? 1 : id === D2 ? 2 : 3}`, ports: "", configCid: "", gpuMilli: 0, cpuMilli: 250, appPort: 0,
    isPublic: true, active: true, createdAt: BigInt(sec() - 86400), rate: 1n, balance6: 10n ** 9n, spent6: 0n, runner: ZERO32, runnerOperator: A("00"), leaseUntil: 0n, ...over });
  const rows = new Map([[D1, row(D1, { active: false })], [D2, row(D2, { createdAt: BigInt(sec() - 86000) })]]);   // D1: switched off by its owner (a template)
  const versions = { 1: { cid: "bafyapp0000001", memMb: 64 }, 2: { cid: "bafyapp0000002", memMb: 64 }, 3: { cid: "bafyapp0000003", memMb: 64, config: '{"apiKey":"$API_KEY"}' } };
  const version = (n) => ({ version: "1.0.0", vramMb: 0, gpuGflops: 0, cpuGflops: 0, createdAt: 0n, verified: true, yanked: false, ports: "", approval: 1, config: "", ...versions[n] });
  let head = 1_000_000n;
  const publicClient = { getBlockNumber: async () => head, getLogs: async () => [],
    readContract: async ({ address, functionName, args }) => {
      if (functionName === "all") return [Object.keys(ADDRS).map((k) => stringToHex(k, { size: 32 })), Object.values(ADDRS)];
      if (address === ADDRS.registry && functionName === "get") return { ...reg };
      if (functionName === "count") return BigInt(rows.size);
      if (functionName === "getPage") return [...rows.values()].slice(Number(args[0]), Number(args[0] + args[1])).map((r) => ({ ...r }));
      if (address === ADDRS.deployments && functionName === "get") return { ...rows.get(args[0]) };
      if (functionName === "claimableBy") return true;
      if (functionName === "getVersion") return version(Number(args[1]));
      if (functionName === "versionConfigCid") return "";
      if (functionName === "earned6") return 0n;
      if (functionName === "earnOf") return [2n, 0n, 0n];
      throw new Error(`unexpected read ${functionName}`);
    } };
  // ---- the phone's VMs (SIMULATED, real keys): v4 evidence over the asker's nonce; the sibling statement by the key held ----
  const vms = new Map(), calls = [];
  let unplugged = false;
  const own = (k) => privateKeyToAccount("0x" + (90 + k).toString(16).repeat(32));
  const handle = (k) => {
    const ports = k ? slotPorts(k) : { app: 17786, evidence: 17787 };
    const answer = async (line, extra) => {
      const vm = vms.get(k), [cmd, arg] = line.split(" ");
      if (cmd === "EVIDENCE3") return JSON.stringify(vm.keys.evidence(k ? vm.sha : idleSha, arg));
      if (cmd === "SIBLING") return JSON.stringify(await vm.keys.sibling(vm.D, arg, vm.keyed ? hostKey : vm.ownKey));
      if (cmd === "KEYNONCE") { vm.nonce = "5e".repeat(32); return JSON.stringify({ nonce: vm.nonce }); }
      if (cmd === "KEYREQ") return JSON.stringify({ format: "enclave-pvm-keyreq/v1", nonce: arg, ephPub: "ee".repeat(32), chain: "c4".repeat(80) });
      if (cmd === "KEYGRANT") return JSON.stringify({ grant: "9a".repeat(92), proofKey: hostKey.address.toLowerCase() });
      if (cmd === "KEYINSTALL") { vm.keyed = true; return JSON.stringify({ ok: true, proofKey: hostKey.address.toLowerCase(), kept: true }); }
      return JSON.stringify({ error: `test: ${cmd} not simulated` });
    };
    return { slot: k, appPort: ports.app, evidencePort: ports.evidence,
      stageApp: async (file, s) => { if (unplugged) throw new Error("the phone is not reachable"); calls.push(`stage ${k}`); vms.set(`staged${k}`, { sha: s }); },
      stageOptions: async (f) => { vms.set(`opts${k}`, f); },
      launch: async (o) => { calls.push(`launch ${k}`); const pins = o.proofPins.split(" ");
        const keep = vms.get(k);   // a relaunch of the same slot keeps its VM instance (and its installed key)
        vms.set(k, { label: o.label, sha: vms.get(`staged${k}`).sha, D: pins[3], keys: keep && keep.D === pins[3] ? keep.keys : (k ? fixtureVm(dir, fx.ca) : hostVm),
                     keyed: !!(keep && keep.D === pins[3] && keep.keyed), ownKey: own(k) }); },
      stop: async () => { calls.push(`stop ${k}`); vms.delete(k); },
      alive: async (label) => !unplugged && !!vms.get(k) && vms.get(k).label === label,
      waitServing: async () => ({ line: "APP serving https-p256" }),
      readToken: async () => "t", capture: async () => "",
      exchange: async (line, extra = null) => { if (!vms.get(k)) throw new Error("no VM"); if (/^KEY/.test(line)) calls.push(`${line.split(" ")[0]} ${k}`); return (await answer(line, extra)) + "\n"; },
      carrierFetch: async () => ({ status: 200, text: async () => "{}" }) };
  };
  const handles = [0, 1, 2, 3].map(handle);
  const device = { ...handles[0], ensurePorts: async () => { if (unplugged) throw new Error("the phone is not reachable"); return 0; }, slots: 3, slot: (k) => handles[k], readOffer: async () => null };
  // ---- the app-funded lease sender (RECORDING stand-in for network/lease-gas-runtime.mjs configuredLeaseSender) ----
  const sender = { claims: [], renews: [], releases: [], refuse: null,
    claim: async (D, H) => { if (sender.refuse) throw Object.assign(new Error(`claim ${D} refused: ${sender.refuse}`), { code: sender.refuse });
      sender.claims.push(D); Object.assign(rows.get(D), { runner: H, runnerOperator: operator.address, leaseUntil: BigInt(sec() + 3600) }); return { hash: "0x" + "c1".repeat(32) }; },
    renew: async (D) => { sender.renews.push(D); rows.get(D).leaseUntil = BigInt(sec() + 3600); return { hash: "0x" + "c2".repeat(32) }; },
    release: async (D) => { sender.releases.push(D); Object.assign(rows.get(D), { runner: ZERO32, leaseUntil: 0n }); return { hash: "0x" + "c3".repeat(32) }; } };
  // ---- the runners (STAND-IN): a slot claims/releases only through the lease sender it was given; the legacy path is absent ----
  const made = [];
  const createRunner = async ({ config: rc, leaseSender }) => {
    const D = rc.proof.deployment, slot = !!rc.lifecycle.claim;
    if (slot) assert.equal(leaseSender, sender, "a slot runner gets the app-funded sender");
    const r = { config: rc, leaseSender, ticks: 0, closed: false,
      agent: { pending: null, lease: async () => { const d = rows.get(D) || { active: true, runner: ZERO32, runnerOperator: A("00"), leaseUntil: 0n };
        return { active: d.active, runner: d.runner, runnerOperator: String(d.runnerOperator).toLowerCase(), leaseUntil: d.leaseUntil, headTs: BigInt(sec()) }; } },
      start: async () => ({ attested: { proofKey: hostKey.address } }),
      tick: async () => { r.ticks++; const d = rows.get(D);
        if (slot && d && d.active && d.leaseUntil < BigInt(sec())) { try { await leaseSender.claim(D, E); } catch (e) { return { kind: "claim-refused", lifecycle: { kind: "claim-refused", reason: e.message } }; } }
        return { kind: "proved" }; },
      stop: async ({ release }) => { if (release && rows.get(D) && rows.get(D).runner === E) await leaseSender.release(D); return { kind: release ? "released" : "stopped" }; },
      close: () => { r.closed = true; } };
    made.push(r);
    return r;
  };
  // ---- the independent runtime: the REAL measured policy gate for this host, the sender ----
  const stateDir = path.join(dir, "state"); fs.mkdirSync(stateDir);
  const logs = [];
  // each agent start is a new process: a new measured gate, which reads its persisted refusal (a ban survives a restart)
  const make = () => createHostAgent({ config: cfg, publicClient, account: operator, stateDir, device, fetchImpl: guard.fetch, now, sleep: async () => {},
    log: (o) => logs.push(o), createRunner, independent: { leaseSender: sender, hostGate: hostPolicyGate({ profile, hostId: E, stateDir, fetch: caFetch(pw.ca) }) } });
  // ---- a VERIFIER elsewhere (a client, directory or owner): its own policy runtime over the same platform policy ----
  const verifierPolicy = createHostPolicyRuntime(resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: BOOK, hostOwnership: OWNERSHIP, mirrors: [pw.mirrorOrigin], rpcs: policyRpcs }) } }),
    { fetch: caFetch(pw.ca) });
  const readState = async (D) => { const d = rows.get(D); const n = Number(/\/(\d+)$/.exec(d.appRef)[1]);
    return { block: head, deployment: { ...d }, registry: { operator: reg.operator, active: reg.active, proofKey: reg.proofKey }, catalog: { app: { active: true }, version: version(n) } }; };
  const fetchComponent = async (cid) => fs.readFileSync(path.join(cache, `${cid}.wasm`));
  const verifier = ({ pins = { codeHashes: fx.doc.codeHashes, authorityHashes: fx.doc.authorityHashes, runtimeIds: fx.doc.runtimeIds, rootPins: fx.doc.rootPins }, transport, read = readState } = {}) =>
    createPvmIndependentAdmission({ readState: read, fetchComponent, pins, hostAdmission: leaseHostAdmission(verifierPolicy.gate), transport });
  return { dir, fx, pw, guard, profile, cfg, rows, reg, versions, calls, vms, made, sender, logs, make, verifier, readState, posted, dirA, dirB,
           setDirB: (v) => { dirBUp = v; }, advance: (ms) => { T += ms; head += BigInt(Math.max(1, Math.floor(ms / 2000))); }, unplug: (v) => { unplugged = v; }, hostVm, idleSha };
}

const relayCalls = (w) => w.guard.calls.filter((u) => /enclave\.host/.test(u));

test("cold start, a new deployment and attested admission -- no relay, API, Nan or minipc in any step", { skip }, async (t) => {
  const w = await world(t);
  const agent = await w.make();
  const r = await agent.tick();
  assert.equal(r.kind, "ok", JSON.stringify(w.logs.filter((o) => /fail|error|refused/.test(o.ev || "")).slice(0, 4)));
  assert.equal(r.hostUp, true);
  // the host VM, then the newest open deployment (D2) into slot 1: its VM given the host's key by the host VM, claimed
  // through the APP-FUNDED sender (the operator's own claim path does not exist here)
  assert.deepEqual(w.calls, ["stage 0", "launch 0", "stage 1", "launch 1", "KEYNONCE 0", "KEYREQ 1", "KEYGRANT 0", "KEYINSTALL 1"]);
  assert.deepEqual(w.sender.claims, [D2]);
  assert.equal(w.rows.get(D2).runner, E);
  const cfgOf = (D) => w.made.find((x) => x.config.proof.deployment === D).config;
  assert.deepEqual(cfgOf(D2).lifecycle, { claim: true, syncProofKey: false, heartbeat: false, reactivate: false, leaseGas: true }, "slot: off-chain liveness, no revival, app-funded");
  const hostL = cfgOf(ZERO32).lifecycle;
  assert.deepEqual([hostL.heartbeat, hostL.reactivate, hostL.leaseGas], [false, false, undefined], "the host's runner registers (operator-paid, design B) but never heartbeats");
  assert.equal(cfgOf(D2).proof.endpoint, ENDPOINT, "the registry identity is the owner's endpoint");
  // the platform policy was read from the admin's anchored, mirrored policy, and admits this host
  assert.equal(agent.policy().serving, true, JSON.stringify(agent.policy()));
  assert.ok(w.pw.served.some((u) => u.endsWith(".json")), "the policy came from the mirror, checked against the book's anchor");
  // availability says what it is: independent, no relay secrets, no WebPKI, off-chain liveness, app-funded leases
  const av = agent.availability();
  assert.deepEqual([av.independent, av.secrets, av.certificates, av.liveness, av.leaseGas], [true, false, "attested key (native client); no WebPKI", "signed capacity record (off-chain)", "app-funded"]);
  // off-chain liveness: the operator's signed capacity record, posted to the owner's directories (B is down: reported, A has it)
  const account = operator;
  const cap = capacityPublisher({ profile: w.profile, account, agent, now: () => Date.now() });
  const res = await cap.tick();
  assert.deepEqual(res.map((x) => x.ok), [true, false], JSON.stringify(res));
  const env = w.posted.a[0];
  const v = await verifyHostCapacity(env, { pins: { chainId: 8453, registry: ADDRS.registry }, entry: { endpoint: ENDPOINT, operator: me, active: true } });
  assert.equal(v.signer.toLowerCase(), me);
  const live = hostLiveness({ operator: me, active: true, lastSeen: 0 }, { nowMs: Date.now(), signedUntilMs: v.record.expiresAt, registryUpdateWindowSec: 0 });
  assert.equal(live.live, true, JSON.stringify(live));
  assert.equal(live.evidence, "signed-record");
  // ATTESTED ADMISSION by a verifier elsewhere: its OWN nonce, the relay's verifier code, the registry proof key, the policy --
  // carried through an opaque pipe to the agent's real host surface
  const surface = await agent.serve(0); t.after(() => surface.close());
  const pipe = await opaquePipe(`http://127.0.0.1:${surface.address().port}`); t.after(() => pipe.close());
  const adm = await w.verifier({ transport: hostSurfaceTransport({ base: pipe.origin, fetch: w.guard.fetch }) }).admit(D2, E);
  assert.equal(adm.ok, true, JSON.stringify(adm));
  assert.equal(adm.tlsSpkiSha256, w.vms.get(1).keys.tlsSpkiSha256, "the TLS key a client will pin is the slot VM's attested key");
  assert.equal(adm.operator, me);
  assert.equal(pipe.carried.length, 2, "evidence and sibling statement, both carried opaquely");
  // nothing ever went to enclave.host (or anywhere outside loopback)
  assert.deepEqual(relayCalls(w), []); assert.deepEqual(w.guard.refused, []);
  assert.ok(!w.logs.some((o) => /^cert|^secrets/.test(o.ev || "")), "no certificate or secrets request was even attempted");
  await agent.stop?.({ release: false }).catch(() => {});
});

test("replayed or mismatched evidence and configuration are refused; a carrier is never an authority", { skip }, async (t) => {
  const w = await world(t);
  const agent = await w.make(); await agent.tick();
  const surface = await agent.serve(0); t.after(() => surface.close());
  const pipe = await opaquePipe(`http://127.0.0.1:${surface.address().port}`); t.after(() => pipe.close());
  const transport = hostSurfaceTransport({ base: pipe.origin, fetch: w.guard.fetch });
  pipe.reset();
  assert.equal((await w.verifier({ transport }).admit(D2, E)).ok, true, "an honest verification (its evidence answer is what the carrier keeps)");
  // a replaying carrier: that genuine, earlier answer for the NEXT verification (an old quote for a new nonce)
  pipe.replay(true);
  let r = await w.verifier({ transport }).admit(D2, E);
  pipe.replay(false); pipe.reset();
  assert.equal(r.ok, false); assert.equal(r.stage, "evidence"); assert.match(r.reason, /answers another nonce/);
  // another build than the verifier's pinned inputs approve (the verifier pins a different code hash)
  r = await w.verifier({ transport, pins: { ...w.fx.doc, codeHashes: ["99".repeat(32)] } }).admit(D2, E);
  assert.equal(r.ok, false); assert.equal(r.stage, "evidence");
  // the catalog names another component than the one the VM attests (a mismatched app/config)
  w.versions[2].cid = "bafyapp0000003";
  r = await w.verifier({ transport }).admit(D2, E);
  assert.equal(r.ok, false); assert.match(r.reason, /names another app/);
  w.versions[2].cid = "bafyapp0000002";
  // the host's registry names ANOTHER proof key (a VM holding a different host's key is not this host's)
  w.reg.proofKey = otherHostKey.address;
  r = await w.verifier({ transport }).admit(D2, E);
  assert.equal(r.ok, false); assert.equal(r.stage, "binding"); assert.match(r.reason, /does not hold this host's registered proof key/);
  w.reg.proofKey = hostKey.address;
  // the lease's operator is not the host's registry operator
  const keep = w.rows.get(D2).runnerOperator; w.rows.get(D2).runnerOperator = A("66");
  r = await w.verifier({ transport }).admit(D2, E);
  assert.equal(r.ok, false); assert.match(r.reason, /lease's operator is not the host's registry operator/);
  w.rows.get(D2).runnerOperator = keep;
  // the owner edits the deployment WHILE it is verified: the second chain read differs -> refused
  let reads = 0;
  r = await w.verifier({ transport, read: async (D) => { const s = await w.readState(D); if (++reads === 2) s.deployment.configCid = '{"config":{"edited":true}}'; return s; } }).admit(D2, E);
  assert.equal(r.ok, false); assert.equal(r.stage, "recheck"); assert.match(r.reason, /changed during verification/);
  // a host this deployment is not leased to (another registry id) is refused before anything is asked of it
  const before = pipe.carried.length;
  r = await w.verifier({ transport }).admit(D2, "0x" + "77".repeat(32));
  assert.equal(r.ok, false); assert.equal(r.stage, "chain"); assert.equal(pipe.carried.length, before, "nothing was asked of the host");
  assert.equal((await w.verifier({ transport }).admit(D2, E)).ok, true, "and the honest host still verifies");
  assert.deepEqual(relayCalls(w), []);
});

test("old deployment recovery, endpoint failure and reconnect: restart adopts; a lost VM is relaunched on the same lease; no new claim", { skip }, async (t) => {
  const w = await world(t);
  let agent = await w.make(); await agent.tick();
  assert.deepEqual(w.sender.claims, [D2]);
  // the agent restarts (the phone's agent process ends; its state is journaled): the served lease is adopted, not claimed again
  agent = await w.make(); w.calls.length = 0;
  await agent.tick();
  assert.deepEqual(w.sender.claims, [D2], "no second claim");
  assert.ok(!w.calls.includes("launch 1"), "the running VM is adopted, not relaunched");
  assert.equal(agent.state().slots["1"].id, D2);
  // the phone becomes unreachable: nothing is taken or judged; its VMs run on
  w.unplug(true); w.advance(61_000);
  let r = await agent.tick();
  assert.equal(r.kind, "phone-unreachable");
  assert.deepEqual(w.sender.claims, [D2]);
  // it comes back, and the slot VM is gone meanwhile: relaunched on the SAME lease (no claim), its key re-proved
  w.unplug(false); w.vms.delete(1); w.calls.length = 0; w.advance(61_000);
  r = await agent.tick();
  assert.ok(w.calls.includes("launch 1"), JSON.stringify(w.calls));
  assert.deepEqual(w.sender.claims, [D2], "the same lease: never claimed again");
  // directory B returns: the next capacity record reaches both
  w.setDirB(true);
  const cap = capacityPublisher({ profile: w.profile, account: operator, agent, now: () => Date.now() });
  assert.deepEqual((await cap.tick()).map((x) => x.ok), [true, true]);
  assert.deepEqual(relayCalls(w), []);
});

test("owner revocation and host deregistration end service; an app needing relay-held secrets is never taken", { skip }, async (t) => {
  const w = await world(t);
  const agent = await w.make(); await agent.tick();
  // D3 asks for secrets in its config: refused with the reason, never claimed
  w.rows.set(D3, { ...w.rows.get(D1), id: D3, appRef: `catalog://${APPID}/3`, createdAt: 1n, runner: ZERO32, leaseUntil: 0n, active: true });
  w.rows.get(D1).active = false;   // (keep the sweep on D3)
  w.advance(61_000); await agent.tick();
  assert.ok(w.logs.some((o) => o.ev === "not-taken" && o.deployment === D3 && /only the relay can release to a pVM today/.test(o.why)), "D3 refused for its secrets");
  assert.ok(!w.sender.claims.includes(D3));
  // the deployment's OWNER switches D2 off: the lease is released (app-funded) and the slot freed; admission refuses it now
  w.rows.get(D2).active = false; w.advance(61_000);
  await agent.tick();
  assert.deepEqual(w.sender.releases, [D2], "released through the app-funded sender");
  assert.equal(agent.state().slots["1"], null);
  const transport = { evidence: async () => assert.fail("not asked"), sibling: async () => assert.fail("not asked") };
  let r = await w.verifier({ transport }).admit(D2, E);
  assert.equal(r.ok, false); assert.match(r.reason, /not active|not leased/);
  // the operator deregisters the host: nothing more is taken, and verifiers refuse it
  w.rows.get(D2).active = true; w.reg.active = false; w.advance(61_000);
  await agent.tick();
  assert.equal(agent.availability().registered, false);
  assert.deepEqual(w.sender.claims, [D2], "nothing taken by a deregistered host");
  w.rows.get(D2).runner = E; w.rows.get(D2).runnerOperator = operator.address; w.rows.get(D2).leaseUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
  r = await w.verifier({ transport }).admit(D2, E);
  assert.equal(r.ok, false); assert.match(r.reason, /registry entry is not active/);
  assert.deepEqual(relayCalls(w), []);
});

test("an admin ban (the platform's anchored host policy) stops this host and every verifier refuses it; an unban resumes", { skip }, async (t) => {
  const w = await world(t);
  const agent = await w.make(); await agent.tick();
  assert.deepEqual(w.sender.claims, [D2]);
  const surface = await agent.serve(0); t.after(() => surface.close());
  const pipe = await opaquePipe(`http://127.0.0.1:${surface.address().port}`); t.after(() => pipe.close());
  const transport = hostSurfaceTransport({ base: pipe.origin, fetch: w.guard.fetch });
  // the administrator signs, mirrors and anchors a policy banning this host's registry id
  await w.pw.publish({ deny: [{ kind: "registryId", value: E.toLowerCase(), reason: "platform abuse (test)" }] });
  w.advance(61_000);
  const r = await agent.tick();
  assert.equal(r.kind, "banned", JSON.stringify(r));
  assert.deepEqual(w.sender.releases, [D2], "its lease released (a final proof, then release), its slot freed");
  assert.equal(agent.state().slots["1"], null);
  assert.equal(agent.policy().banned, true);
  assert.equal(agent.availability().claimEnabled !== undefined, true);
  // a verifier elsewhere refuses it at the policy step (before asking the host anything)
  w.rows.get(D2).runner = E; w.rows.get(D2).runnerOperator = operator.address; w.rows.get(D2).leaseUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const before = pipe.carried.length;
  const adm = await w.verifier({ transport }).admit(D2, E);
  assert.equal(adm.ok, false); assert.equal(adm.stage, "policy"); assert.match(adm.reason, /banned by platform policy/);
  assert.equal(pipe.carried.length, before, "the banned host was asked nothing");
  // the ban survives a restart of the agent (persisted refusal), and a fresh claim is never made while banned
  w.rows.get(D2).runner = ZERO32; w.rows.get(D2).leaseUntil = 0n;
  const again = await w.make(); w.advance(61_000);
  assert.equal((await again.tick()).kind, "banned");
  assert.deepEqual(w.sender.claims, [D2], "nothing claimed while banned");
  // the admin lifts the ban: the host serves again (a NEW authenticated admit)
  await w.pw.publish({ deny: [] });
  w.advance(61_000);
  const back = await again.tick();
  assert.equal(back.kind, "ok", JSON.stringify(back));
  assert.equal(again.policy().serving, true);
  assert.deepEqual(relayCalls(w), []);
});

test("an owner custody-v2 startup package: taken in independent mode, the package (not a config) goes to the VM, and its operator authorizes only its own release", { skip }, async (t) => {
  const w = await world(t);
  const agent = await w.make(); await agent.tick();
  const surface = await agent.serve(0); t.after(() => surface.close());   // the host surface, the app router and the egress server
  // D3's config takes $NAME, but its owner committed a startup package (guestBootstrap): its values come from custody in the VM
  const pkg = Buffer.from(JSON.stringify({ version: 1, chainId: 8453, ledger: ADDRS.deployments, deployment: D3, owner: ownerWallet, appRef: `catalog://${APPID}/3`,
    appId: "ab".repeat(32), runtimeId: "cd".repeat(32), configText: '{"apiKey":"$API_KEY"}', secretsMode: "custody-v2",
    custody: { v: 2, chainId: 8453, vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5" } }));
  const intent = { version: 1, sha256: sha(pkg) };
  w.rows.set(D3, { ...w.rows.get(D1), id: D3, appRef: `catalog://${APPID}/3`, configCid: JSON.stringify({ guestBootstrap: intent }), createdAt: 1n, runner: ZERO32, leaseUntil: 0n, active: true });
  w.rows.get(D1).active = false;
  // no package on this host (and the owner's gateways serve none): not taken, with that reason
  w.advance(61_000); await agent.tick();
  assert.ok(w.logs.some((o) => o.ev === "not-taken" && o.deployment === D3 && /owner startup package/.test(o.why)), "refused without its package");
  assert.ok(!w.sender.claims.includes(D3));
  // the owner places it: taken, and the VM gets the package, no ENCLAVE_CONFIG and no sealed release
  const sd = path.join(w.dir, "state", "startup"); fs.mkdirSync(sd, { recursive: true }); fs.writeFileSync(path.join(sd, `${D3}.json`), pkg);
  w.advance(10 * 60_000 + 1000); await agent.tick();   // a refusal is looked at again after its 10-minute backoff
  assert.ok(w.sender.claims.includes(D3), "claimed through the app-funded sender");
  const slot = Object.entries(agent.state().slots).find(([, a]) => a && a.id === D3);
  assert.ok(slot, "D3 has a slot");
  const opts = w.vms.get(`opts${slot[0]}`);
  assert.match(opts, new RegExp(`^STARTUP ${pkg.toString("hex")}$`, "m"));
  assert.doesNotMatch(opts, /^SEALED /m);
  assert.doesNotMatch(Buffer.from(/^ENV ([0-9a-f]+)$/m.exec(opts)[1], "hex").toString(), /ENCLAVE_CONFIG/);
  // the VM's custody-auth-v2 over its egress: the operator signs exactly this release, for D3 only, a reviewed vault only
  const token = slot[1].egressToken, binding = "be".repeat(32), vault = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
  const ask = (line) => new Promise((resolve, reject) => { const c = net.connect(w.cfg.egress.port, "127.0.0.1"); let b = "";
    c.on("data", (x) => { b += x; }); c.on("end", () => resolve(b.trim())); c.on("error", reject); c.write(line + "\n"); });
  const ok = await ask(`EGRESS ${token} CUSTODYAUTH ${vault} ${D3} ${binding}`);
  const [tag, endpoint, expiry, sig] = ok.split(" ");
  assert.equal(tag, "OK"); assert.equal(endpoint, ENDPOINT);
  const signer = await recoverMessageAddress({ message: operatorMessage({ chainId: 8453, vault, id: D3, endpoint, binding: Buffer.from(binding, "hex"), expiry: Number(expiry) }), signature: sig });
  assert.equal(signer.toLowerCase(), me, "the registered operator signed this release");
  assert.equal(await ask(`EGRESS ${token} CUSTODYAUTH 0x${"77".repeat(20)} ${D3} ${binding}`), "ERR not a reviewed custody vault");
  assert.equal(await ask(`EGRESS ${token} CUSTODYAUTH ${vault} ${D2} ${binding}`), "ERR not this launch's deployment");
  assert.deepEqual(relayCalls(w), []);
});
