// The pVM host agent's slots (shielded/anchor/avf/runner/host-agent.mjs; PVM-CPU.md "Slots by share"), end to end against a
// simulated phone and chain: the one-VM state carried into slot 1, a VM per app sized to its share, the host's proof key
// handed to a slot that does not hold it (and only then), the relay's sibling check answered by the right VM, one
// transaction in flight across the runners, and a slot freed when its lease ends. The VMs' own checks (the attestation
// verified in the donor VM, the sealed handover) are pvm-rt's (tests/keygrant.rs) and the device's (results/).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringToHex, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHostAgent, checkHostConfig, siblingDigest, HOST_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/host-agent.mjs";
import { slotPorts } from "../shielded/anchor/avf/runner/pvm-device.mjs";

const operator = privateKeyToAccount("0x" + "71".repeat(32)), hostKey = privateKeyToAccount("0x" + "72".repeat(32));
const me = operator.address.toLowerCase();
const A = (n) => "0x" + n.repeat(20);
const book = { registry: A("a1"), deployments: A("a2"), proofOfTime: A("a3"), appCatalog: A("a4") };
const D0 = "0x" + "d0".repeat(32), D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32);
const APPID = "0x" + "ab".repeat(32);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-slots-")), cache = path.join(dir, "cache");
  fs.mkdirSync(cache);
  const idle = path.join(dir, "idle.wasm"); fs.writeFileSync(idle, "\0asm idle");
  const component = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]), Buffer.from("wasi:http/incoming-handler")]);
  for (const cid of ["bafyapp0000001", "bafyapp0000002"]) fs.writeFileSync(path.join(cache, `${cid}.wasm`), Buffer.concat([component, Buffer.from(cid)]));
  const config = { format: HOST_CONFIG_FORMAT, name: "pixel-test", relayOrigin: "https://relay.test", chainId: "8453", addressBook: A("b0"), operator: me,
    maxFeePerGasWei: "500000000", register: { repo: "r", cpuPricePerSec6: "2" },
    evidence: { allowedCodeHashes: ["51".repeat(32)], allowedAuthorityHashes: ["98".repeat(64)], allowedRuntimeIds: ["d3".repeat(32)], rootPins: ["ce".repeat(32)], instanceIds: ["c0".repeat(32)] },
    device: { adb: "/bin/false", serial: "X", vmName: "pvmtest", agentPort: 18187, attachPort: 18188 }, idleApp: idle,
    claim: { enabled: true, maxMemMb: 512, sweepGraceSec: 300 }, slots: { count: 3, poolMemMb: 1536, routerPort: 17780 },
    ipfs: { python: "python3", fetchScript: "/nonexistent", gateways: ["https://gw.test"], cacheDir: cache } };
  const E = checkHostConfig(config).enclaveId;
  let T = 1_800_000_000_000;
  const now = () => T;
  const sec = () => Math.floor(T / 1000);
  // the chain
  const row = (id, over) => ({ id, owner: A("0e"), appRef: `catalog://${APPID}/${id === D1 ? 1 : 2}`, ports: "", configCid: "", gpuMilli: 0, cpuMilli: 250, appPort: 0,
    isPublic: true, active: true, createdAt: BigInt(sec() - 86400 + (id === D2 ? 60 : 0)), rate: 1n, balance6: 10n ** 9n, spent6: 0n,
    runner: "0x" + "00".repeat(32), runnerOperator: A("00"), leaseUntil: 0n, ...over });
  const rows = new Map([[D0, row(D0, { runner: E, runnerOperator: operator.address, leaseUntil: BigInt(sec() + 3600) })], [D1, row(D1)], [D2, row(D2)]]);
  const versions = { 1: { cid: "bafyapp0000001", memMb: 64 }, 2: { cid: "bafyapp0000002", memMb: 256 } };
  let head = 1_000_000n;
  const publicClient = { getBlockNumber: async () => head,
    // the ledger's events for the operator: two credits and one withdrawal, inside the scanned window
    getLogs: async ({ event, fromBlock, toBlock }) => {
      const inWin = (b) => b >= fromBlock && b <= toBlock;
      if (event.name !== "EarningsWithdrawn") throw new Error(`unexpected event ${event.name}`);
      if (fromBlock < head - 10_000n) throw Object.assign(new Error("RPC Request failed."), { details: "Archive requests require a personal token." });
      return [[999_500n, 2_250_000n]].filter(([b]) => inWin(b)).map(([b, a]) => ({ args: { amount6: a, to: "0x" + "0b".repeat(20) }, blockNumber: b, transactionHash: "0x" + "77".repeat(32) }));
    },
    readContract: async ({ address, functionName, args }) => {
    if (functionName === "all") return [Object.keys(book).map((k) => stringToHex(k, { size: 32 })), Object.values(book)];
    if (address === book.registry && functionName === "get") return { operator: operator.address, active: true, proofKey: hostKey.address, measurement: "0x" + "51".repeat(32), registeredAt: BigInt(sec() - 3600) };
    if (functionName === "count") return BigInt(rows.size);
    if (functionName === "getPage") return [...rows.values()].slice(Number(args[0]), Number(args[0] + args[1]));
    if (address === book.deployments && functionName === "get") return rows.get(args[0]);
    if (functionName === "claimableBy") return true;
    if (functionName === "getVersion") { const v = versions[Number(args[1])]; return { version: "1.0.0", vramMb: 0, gpuGflops: 0, cpuGflops: 0, createdAt: 0n, verified: true, yanked: false, ports: "", approval: 1, config: "", ...v }; }
    if (functionName === "versionConfigCid") return "";
    if (functionName === "earned6") return 1_250_000n;                       // $1.25 ready to pay out
    if (functionName === "earnOf") return [2n, 0n, 0n];                       // 2 µUSDC/s per app here
    throw new Error(`unexpected read ${functionName}`);
  } };
  // the phone: VMs by slot (0 = the host VM); each slot instance keeps the host's key once installed (its encrypted store)
  const vms = new Map(), store = new Map(), calls = [], failOnce = new Set(), failAlways = new Set();
  let unplugged = false;
  const own = (k) => privateKeyToAccount("0x" + (90 + k).toString(16).repeat(32));
  let boots = 0;
  const handle = (k) => {
    const ports = k ? slotPorts(k) : { app: 17786, evidence: 17787 };
    const answer = async (line, extra) => {
      const vm = vms.get(k), [cmd, arg] = line.split(" ");
      if (cmd === "EVIDENCE3") return JSON.stringify({ nonce: arg, app: vm.sha, instanceId: (k + 1).toString(16).padStart(2, "0").repeat(32), transportSpki: "302a300506032b6570032100" + vm.boot.toString(16).padStart(64, "0") });
      if (cmd === "SIBLING") {
        const inst = (k + 1).toString(16).padStart(2, "0").repeat(32), spki = "302a300506032b6570032100" + vm.boot.toString(16).padStart(64, "0");
        const st = { format: "enclave-pvm-sibling/v1", nonce: arg, deployment: vm.D, instanceId: inst, transportSpki: spki };
        const signer = store.get(k) ? hostKey : own(k);   // a slot's own instance key until it is given the host's
        return JSON.stringify({ ...st, proofKey: signer.address.toLowerCase(), sig: (await signer.sign({ hash: "0x" + siblingDigest(st).toString("hex") })).slice(2) });
      }
      if (cmd === "KEYNONCE") { assert.equal(k, 0, "only the host VM gives a key nonce"); vm.nonce = "5e".repeat(32); return JSON.stringify({ nonce: vm.nonce }); }
      if (cmd === "KEYREQ") return JSON.stringify({ format: "enclave-pvm-keyreq/v1", nonce: arg, ephPub: "ee".repeat(32), chain: "c4".repeat(80) });
      if (cmd === "KEYGRANT") {
        assert.equal(k, 0); assert.equal(extra.length, Number(arg));
        assert.equal(extra.subarray(0, 32).toString("hex"), vm.nonce); assert.equal(extra.subarray(32, 64).toString("hex"), "ee".repeat(32));
        return JSON.stringify({ grant: "9a".repeat(92), proofKey: hostKey.address.toLowerCase() });
      }
      if (cmd === "KEYINSTALL") {
        assert.equal(extra.subarray(32, 52).toString("hex"), hostKey.address.slice(2).toLowerCase(), "the registered key is the one installed");
        store.set(k, true); return JSON.stringify({ ok: true, proofKey: hostKey.address.toLowerCase(), kept: true });
      }
      return JSON.stringify({ error: `test: ${cmd} not simulated` });
    };
    return {
      slot: k, appPort: ports.app, evidencePort: ports.evidence,
      stageApp: async (file, sha) => { if (unplugged || failOnce.delete(`stage ${k}`)) throw new Error("adb: device 'X' not found");
        if (failAlways.has(`stage ${k}`)) throw new Error("the VM did not serve: VSOCK APP refused: the app did not start"); calls.push(`stage ${k}`); (vms.get(`staged${k}`) || vms.set(`staged${k}`, {}).get(`staged${k}`)).sha = sha; },
      stageOptions: async () => {},
      launch: async (o) => {
        calls.push(`launch ${k}${k ? ` ${o.vmMib} MiB cpus=${o.cpus} app=${o.appMem}` : ""}`);
        const pins = o.proofPins.split(" ");
        vms.set(k, { label: o.label, sha: vms.get(`staged${k}`).sha, D: pins[3], boot: ++boots });
      },
      stop: async () => { calls.push(`stop ${k}`); vms.delete(k); },
      alive: async (label) => !unplugged && !failOnce.delete(`alive ${k}`) && !!vms.get(k) && vms.get(k).label === label,
      waitServing: async () => ({ line: "APP serving https-p256" }),
      readToken: async () => "t", capture: async () => "",
      exchange: async (line, extra = null) => { if (!vms.get(k)) throw new Error("no VM"); if (/^KEY/.test(line)) calls.push(`${line.split(" ")[0]} ${k}`); return (await answer(line, extra)) + "\n"; },
      carrierFetch: async () => ({ status: 200, text: async () => "{}" }),
    };
  };
  const handles = [0, 1, 2, 3].map(handle);
  let offerText = null;   // the Enclave app's Sharing settings (files/offer.json), as the device reads them
  const device = { ...handles[0], ensurePorts: async () => { if (unplugged) throw new Error("the phone is not on USB, and adb over Wi-Fi does not answer"); return 0; },
                   slots: 3, slot: (k) => handles[k], readOffer: async () => offerText };
  // the runners: a lease is claimed by a slot runner's tick; `pending` set by the test
  const made = [];
  const createRunner = async ({ config: rc }) => {
    const D = rc.proof.deployment, runner = { config: rc, ticks: 0, closed: false,
      agent: { pending: null, lease: async () => { const d = rows.get(D); return { active: d.active, runner: d.runner, runnerOperator: String(d.runnerOperator).toLowerCase(), leaseUntil: d.leaseUntil, headTs: BigInt(sec()) }; } },
      start: async () => ({ attested: { proofKey: hostKey.address } }),
      tick: async () => { runner.ticks++; if (rc.lifecycle.claim && rows.get(D).leaseUntil < BigInt(sec())) Object.assign(rows.get(D), { runner: E, runnerOperator: operator.address, leaseUntil: BigInt(sec() + 3600) }); return { kind: "proved" }; },
      stop: async ({ release }) => { if (release) Object.assign(rows.get(D), { runner: "0x" + "00".repeat(32), leaseUntil: 0n }); return { kind: release ? "released" : "stopped" }; },
      close: () => { runner.closed = true; } };
    made.push(runner);
    return runner;
  };
  const fetchImpl = async (url) => ({ status: url.endsWith("/enclaves") ? 200 : 403, json: async () => (url.endsWith("/enclaves") ? { enclaves: [{ id: E, operator: me }] } : { error: "test" }) });
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  // the one-VM agent's state: D0 served by the VM, with its certificate
  fs.writeFileSync(path.join(stateDir, "host-state.json"), JSON.stringify({ current: { id: D0, appRef: `catalog://${APPID}/1`, configCid: "", cid: "bafyapp0000001",
    sha: "x", file: path.join(cache, "bafyapp0000001.wasm"), sock: 0, memMib: 0, cpuMilli: 250, gpuMilli: 0, label: "app-d0d0d0d0-old", phase: "serving", sealed: { blob: "00", count: 1 },
    cert: { name: "d0d0d0d0.app.enclave.host" }, at: T }, idle: { label: "idle-old" }, refused: {} }));   // gitleaks:allow
  return { dir, config, E, now, advance: (ms) => { T += ms; }, rows, versions, publicClient, device, createRunner, made, calls, vms, store, fetchImpl, stateDir,
           unplug: (v) => { unplugged = v; }, failOnce, failAlways, setHead: (h) => { head = h; }, setOffer: (o) => { offerText = o === null ? null : typeof o === "string" ? o : JSON.stringify({ v: 1, ...o }); } };
}

test("slots: the served app moves to slot 1, more apps take their own VMs, the host's key is handed only where it is missing", async () => {
  const t = setup(), logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "test", json: async () => ({}) });   // secretsExist: unknown here
  try {
    const agent = await createHostAgent({ config: t.config, publicClient: t.publicClient, account: operator, stateDir: t.stateDir, device: t.device, fetchImpl: t.fetchImpl,
      now: t.now, sleep: async () => {}, log: (o) => logs.push(o), createRunner: t.createRunner,
      verifyEvidence: (doc, x) => ({ ok: doc.nonce === x.nonce && doc.app === x.appId, reasons: ["test refusal"], instanceId: doc.instanceId, transportSpki: doc.transportSpki }) });
    assert.ok(logs.some((o) => o.ev === "migrated" && o.deployment === D0));
    // the migrated app's component sha is recorded by the agent (the cache's file)
    const s0 = agent.state();
    assert.equal(s0.slots["1"].id, D0); assert.equal(s0.slots["1"].vmMib, 384); assert.equal(s0.slots["1"].label, null);
    assert.equal(s0.slots["1"].sealed, undefined, "the old VM's sealed release is not carried: the slot's own is asked for");
    s0.slots["1"].sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(s0.slots["1"].file)).digest("hex");

    let r = await agent.tick();
    if (process.env.DEBUG_SLOTS) console.error(logs.filter((o) => /fail|error|refused|not-taken/.test(o.ev)));
    assert.equal(r.hostUp, true);
    // host VM first, then slot 1 (D0) given the host's key, then the sweep takes the newest open deployment (D2) into slot 2
    assert.deepEqual(t.calls, ["stage 0", "launch 0", "stage 1", "launch 1 384 MiB cpus=0 app=256", "KEYNONCE 0", "KEYREQ 1", "KEYGRANT 0", "KEYINSTALL 1",
                               "stage 2", "launch 2 384 MiB cpus=0 app=256", "KEYNONCE 0", "KEYREQ 2", "KEYGRANT 0", "KEYINSTALL 2"]);
    const st = agent.state();
    assert.deepEqual(Object.values(st.slots).filter(Boolean).map((a) => [a.slot, a.id, a.phase]), [[1, D0, "serving"], [2, D2, "serving"]]);
    assert.equal(t.rows.get(D2).runner, t.E, "D2 claimed by its slot's runner");
    // the runners: the host's registers and re-keys; a slot's claims, never re-keys, and pins its own instance
    const cfgOf = (D) => t.made.find((x) => x.config.proof.deployment === D).config;
    assert.deepEqual(cfgOf("0x" + "00".repeat(32)).lifecycle.claim, false); assert.ok(cfgOf("0x" + "00".repeat(32)).lifecycle.register);
    assert.deepEqual(cfgOf(D2).lifecycle, { claim: true, syncProofKey: false });
    assert.deepEqual(cfgOf(D2).proof.evidence.instanceIds, ["03".repeat(32)]);
    assert.equal(cfgOf(D2).proof.carrier, `http://127.0.0.1:${slotPorts(2).evidence}/`);

    // the relay's checks reach the VM serving that deployment
    const nonce = "77".repeat(32);
    const [code, s] = await agent.sibling(new URLSearchParams({ deployment: D2, nonce }));
    assert.equal(code, 200);
    assert.equal(await recoverAddress({ hash: "0x" + siblingDigest({ nonce, transportSpki: s.transportSpki, instanceId: s.instanceId, deployment: D2 }).toString("hex"), signature: "0x" + s.sig }), hostKey.address);
    assert.equal(s.instanceId, "03".repeat(32), "slot 2's own VM answered");
    assert.equal((await agent.evidence(new URLSearchParams({ deployment: D1, nonce })))[0], 404, "not served here (yet)");
    // no deployment named: the HOST VM's own evidence over the caller's nonce (a client verifying this host itself);
    // a deployment parameter that names nothing is still a deployment question, never the host's answer
    const [hc, hv] = await agent.evidence(new URLSearchParams({ nonce }));
    assert.equal(hc, 200); assert.equal(hv.nonce, nonce); assert.equal(hv.instanceId, "01".repeat(32), "the host VM answered, not a slot");
    assert.equal((await agent.evidence(new URLSearchParams({ deployment: "", nonce })))[0], 404);

    // the owner shares only half the phone's CPU (the Enclave app's Sharing): D0 and D2 hold 500 per mille, so D1 waits
    t.setOffer({ cpuMilli: 500 }); t.calls.length = 0; t.advance(61_000);
    await agent.tick();
    assert.deepEqual(t.calls, [], "nothing taken beyond the offer");
    let off = agent.availability();
    assert.deepEqual([off.cpuShareOffered, off.cpuShareFree, off.nodeSlotsFree, off.offer.source], [0.5, 0, 0, "phone"]);
    // a setting the agent cannot read is ignored (the config's: all of it); D1 held back meanwhile, so no round takes it
    t.rows.get(D1).active = false;
    t.setOffer("{not json"); t.advance(1000); await agent.tick();
    assert.deepEqual([agent.availability().offer.source, agent.availability().cpuShareOffered], ["config-bad", 1]);
    // ONE share of CPU and RAM: the memory offered is that part of the config's pool (a stale memMb in the file is not read)
    t.setOffer({ cpuMilli: 500, memMb: 4096 }); t.advance(1000); await agent.tick();
    assert.deepEqual([agent.availability().cpuShareOffered, agent.availability().poolMemMb], [0.5, 768], "half the share: half the pool");
    t.setOffer({ cpuMilli: 1000 });   // all of it: the config's whole pool (1536)
    t.advance(1000); await agent.tick();
    assert.deepEqual([agent.availability().poolMemMb, agent.availability().offer.source], [1536, "phone"], "the whole pool");
    assert.deepEqual(t.calls, []);
    // the offer lowered under what already runs (100 per mille, 400 MiB): D0's owner edits its config, and D0 is
    // relaunched on it in its own slot -- re-admitted against what it holds, never released for the lower offer
    t.setOffer({ cpuMilli: 100 }); t.rows.get(D0).configCid = JSON.stringify({ config: { greeting: "edited" } });
    t.calls.length = 0; t.advance(1000); await agent.tick();
    assert.deepEqual(t.calls, ["stage 1", "launch 1 384 MiB cpus=0 app=256"], "relaunched on its new options");
    assert.equal(agent.state().slots["1"].id, D0); assert.equal(t.rows.get(D0).runner, t.E, "its lease kept");
    t.setOffer({ cpuMilli: 1000 }); t.advance(1000); await agent.tick();
    t.rows.get(D1).active = true;

    // the next round: D1 (a 64 MiB app: a 192 MiB VM) into slot 3; the pool is then 960 of 1536 MiB, 750 of 1000 per mille
    t.calls.length = 0; t.advance(61_000);
    r = await agent.tick();
    assert.deepEqual(t.calls, ["stage 3", "launch 3 192 MiB cpus=0 app=64", "KEYNONCE 0", "KEYREQ 3", "KEYGRANT 0", "KEYINSTALL 3"]);
    let av = agent.availability();
    assert.deepEqual([av.slots, av.nodeSlotsFree, av.cpuShareFree, av.poolMemMbFree, av.ramGbFree], [3, 0, 0.25, 576, 0.6]);
    assert.deepEqual(av.apps.map((a) => a.slot), [1, 2, 3]);

    // a slot VM that ended is launched again with the key it keeps: no handover
    t.calls.length = 0; t.vms.delete(2); t.advance(30_000);
    await agent.tick();
    assert.deepEqual(t.calls, ["stage 2", "launch 2 384 MiB cpus=0 app=256"]);

    // one transaction in flight across the runners: while D2's runner has one pending, only it is followed
    const byD = (D) => t.made.filter((x) => x.config.proof.deployment === D && !x.closed).at(-1);
    byD(D2).agent.pending = { nonce: 7 };
    const before = t.made.map((x) => x.ticks);
    t.advance(301_000);
    await agent.tick();
    const ticked = t.made.filter((x, i) => x.ticks > before[i]).map((x) => x.config.proof.deployment);
    assert.deepEqual(ticked, [D2], "the pending runner alone");
    byD(D2).agent.pending = null;

    // the cable out and no Wi-Fi: the phone cannot be asked. Its VMs run on: nothing is judged gone, relaunched or taken;
    // the runners' chain work goes on
    const labels = () => Object.values(agent.state().slots).filter(Boolean).map((a) => a.label);
    const was = labels(), runnerTicks = t.made.reduce((n, x) => n + x.ticks, 0);
    t.unplug(true); t.calls.length = 0; t.advance(301_000);
    r = await agent.tick();
    assert.equal(r.kind, "phone-unreachable");
    assert.deepEqual(t.calls, [], "nothing launched while unreachable");
    assert.deepEqual(labels(), was, "every slot keeps its running VM's label");
    assert.ok(t.made.reduce((n, x) => n + x.ticks, 0) > runnerTicks, "the runners still ticked");
    // back: the same VMs, still serving -- nothing relaunched
    t.unplug(false); t.calls.length = 0; t.advance(30_000);
    await agent.tick();
    assert.deepEqual(t.calls, []);
    // a relaunch cut short before it reached the phone (one adb call failed, then the staging): the running VM keeps its
    // label, so the next round finds it serving and leaves it be
    t.failOnce.add("alive 2"); t.failOnce.add("stage 2"); t.calls.length = 0; t.advance(30_000);
    await agent.tick();
    assert.deepEqual(labels(), was);
    await agent.tick();
    assert.deepEqual(t.calls, [], "the VM that never stopped is not relaunched");

    // hosting off (the Enclave app's switch): every app released (a final proof, then release), every slot freed and its VM
    // ended, then the host VM; nothing is taken, and the agent says so
    t.setOffer({ hosting: false, cpuMilli: 1000 }); t.calls.length = 0; t.advance(301_000);
    r = await agent.tick();
    assert.equal(r.kind, "hosting-off");
    assert.deepEqual(Object.values(agent.state().slots).filter(Boolean), [], "every slot freed");
    for (const D of [D0, D1, D2]) assert.equal(t.rows.get(D).runner, "0x" + "00".repeat(32), `${D.slice(0, 6)} released`);
    assert.deepEqual(t.calls.filter((c) => /^stop/.test(c)).sort(), ["stop 0", "stop 1", "stop 2", "stop 3"], "every VM ended, the host VM last");
    av = agent.availability();
    assert.deepEqual([av.hosting, av.claimEnabled, av.apps.length], [false, false, 0]);
    assert.equal((await agent.claimHint({ id: D1 })).accepted, false, "no claim hint taken while off");
    t.calls.length = 0; t.advance(61_000); await agent.tick();
    assert.deepEqual(t.calls, [], "off stays off: nothing launched");
    // on again: the host VM starts, and the sweep takes the open deployments back
    t.setOffer({ hosting: true, cpuMilli: 1000 }); t.advance(61_000);
    await agent.tick();
    assert.ok(t.calls.includes("launch 0"), "the host VM started again");
    assert.ok(Object.values(agent.state().slots).filter(Boolean).length >= 1, "apps taken again");
    assert.equal(agent.availability().hosting, true);
    // (back to the three apps for what follows)
    for (let i = 0; i < 3 && Object.values(agent.state().slots).filter(Boolean).length < 3; i++) { t.advance(61_000); await agent.tick(); }
    assert.equal(Object.values(agent.state().slots).filter(Boolean).length, 3);
    t.calls.length = 0;

    // earnings, from the ledger: ready $1.25, paid out $2.25 (one withdrawal since the agent first looked), $3.50 in total
    // (ready + paid out), 3 apps x 2 µUSDC/s
    t.advance(61_000); await agent.tick();   // (refreshed at most once a minute)
    const ea = agent.earnings();
    assert.deepEqual([ea.readyToPay6, ea.paidOut6, ea.earnedAllTime6, ea.ratePerHour6, ea.withdrawals.length], ["1250000", "2250000", "3500000", String(3 * 2 * 3600), 1]);
    assert.deepEqual(ea.payout, null, "no payout address anywhere yet: earnings stay on the ledger");
    assert.equal(ea.complete, true);
    // the agent was down for long: the RPC keeps no logs that old -- the gap is skipped and said, the rest still counted
    t.setHead(1_100_000n); t.advance(61_000); await agent.tick();
    assert.deepEqual([agent.earnings().complete, agent.earnings().paidOut6], [false, "2250000"]);
    // the owner sets a payout address in the app: the host runner is made again with it, and the view says so
    t.setOffer({ cpuMilli: 1000, payoutTo: "0x" + "AB".repeat(20) }); t.advance(1000); await agent.tick();
    assert.deepEqual(agent.earnings().payout, { to: "0x" + "ab".repeat(20), minWithdraw6: "1000000", source: "phone" });
    const hostCfg = t.made.filter((x) => x.config.proof.deployment === "0x" + "00".repeat(32) && !x.closed).at(-1).config;
    assert.deepEqual(hostCfg.lifecycle.payout, { to: "0x" + "ab".repeat(20), minWithdraw6: "1000000" }, "withdrawals go there");
    t.setOffer({ cpuMilli: 1000, payoutTo: "0x" + "00".repeat(20) }); t.advance(1000); await agent.tick();
    assert.equal(agent.availability().offer.source, "config-bad", "the zero address is refused");
    t.setOffer({ cpuMilli: 1000 }); t.advance(1000); await agent.tick();

    // D1's owner cancels: its slot is released and freed, and its pool returns
    t.rows.get(D1).active = false; t.calls.length = 0; t.advance(1000);
    await agent.tick();
    assert.ok(t.calls.includes("stop 3"));
    assert.equal(agent.state().slots["3"], null);
    av = agent.availability();
    assert.deepEqual([av.nodeSlotsFree, av.cpuShareFree, av.poolMemMbFree], [1, 0.5, 768]);
    assert.ok(byD(D1) === undefined, "its runner closed");

    // an app that cannot start here: tried, then backed off (10 min, then 20 ...), and a claim hint does not cut it short;
    // a new version starts it over (measured: one such app was hinted and retried every minute)
    t.rows.get(D1).active = true; t.failAlways.add("stage 3"); t.calls.length = 0; t.advance(61_000);
    await agent.tick();
    assert.equal(t.calls.filter((c) => c === "stage 3" || /^launch 3/.test(c)).length, 0, "the failed staging launched nothing");
    assert.equal(agent.state().refused[D1].n, 1);
    const hint = await agent.claimHint({ id: D1 });
    assert.deepEqual([hint.accepted, /did not start here/.test(hint.reason)], [false, true], hint.reason);
    for (let i = 0; i < 5; i++) { t.advance(61_000); await agent.tick(); }
    assert.equal(agent.state().refused[D1].n, 1, "no retry within the back-off, hint or not");
    t.advance(10 * 60_000); await agent.tick();
    assert.equal(agent.state().refused[D1].n, 2, "tried again after 10 min");
    t.advance(11 * 60_000); await agent.tick();
    assert.equal(agent.state().refused[D1].n, 2, "then 20 min");
    t.rows.get(D1).appRef = `catalog://${APPID}/2`; t.advance(61_000); await agent.tick();
    assert.equal(agent.state().refused[D1].n, 1, "a new version starts the count over (and is tried at once)");
    t.failAlways.delete("stage 3");
  } finally { globalThis.fetch = realFetch; fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("a held lease is judged again once per agent start: admitted while it fits, released after a restart once it no longer does (2026-10-13: a pin read under an older rule)", async () => {
  const t = setup(), logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "test", json: async () => ({}) });
  const make = () => createHostAgent({ config: t.config, publicClient: t.publicClient, account: operator, stateDir: t.stateDir, device: t.device, fetchImpl: t.fetchImpl,
    now: t.now, sleep: async () => {}, log: (o) => logs.push(o), createRunner: t.createRunner,
    verifyEvidence: (doc, x) => ({ ok: doc.nonce === x.nonce && doc.app === x.appId, reasons: ["test refusal"], instanceId: doc.instanceId, transportSpki: doc.transportSpki }) });
  try {
    const a = await make();
    const s0 = a.state(); s0.slots["1"].sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(s0.slots["1"].file)).digest("hex");
    for (let i = 0; i < 3; i++) { t.advance(1000); await a.tick(); }
    assert.equal(t.rows.get(D0).runner, t.E, "D0 held");
    assert.ok(!logs.some((o) => o.ev === "rejudged"), "admitted: nothing to say");
    // the rule moves under the held lease (here: its version now needs more memory than this host admits)
    t.versions[2].memMb = 4096;   // D0 (and D2) run version 2
    t.advance(1000); await a.tick();
    assert.equal(t.rows.get(D0).runner, t.E, "judged once per start: the running agent keeps it");
    await a.stop({ release: false });
    // a restart (a new build, a new rule): the held lease is judged again, and released
    const b = await make();
    for (let i = 0; i < 2 && t.rows.get(D0).runner === t.E; i++) { t.advance(1000); await b.tick(); }
    const j = logs.find((o) => o.ev === "rejudged" && o.deployment === D0);
    assert.ok(j, "rejudged after the restart"); assert.match(j.refused, /4096/);
    assert.equal(t.rows.get(D0).leaseUntil, 0n, "released");
    assert.equal(b.state().refused[D0] !== undefined, true);
  } finally { globalThis.fetch = realFetch; }
});

// The Enclave app's screen is the hosting panel (host-ui, the Windows tray's too): the agent answers the Windows node's local
// hosting API on its own port with its own token, and the panel's rules hold on the phone -- a share below what runs, or
// hosting off with apps here, asks first (409 would_drop, newest first) and changes nothing until confirmed; the price, the
// payout wallet and "Pay out now" go where the agent already sends them (the host runner).
test("the hosting panel's API on the phone: the PC's contract, its drop questions, the price, the payout wallet and Pay out now", async () => {
  const t = setup(), logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "test", json: async () => ({}) });
  t.device.writeOffer = async (text) => t.setOffer(text);
  const asked = [];
  const createRunner = async (o) => { const r = await t.createRunner(o); r.requestPayout = () => asked.push(o.config.proof.deployment); return r; };
  let srv;
  try {
    const agent = await createHostAgent({ config: t.config, publicClient: t.publicClient, account: operator, stateDir: t.stateDir, device: t.device, fetchImpl: t.fetchImpl,
      now: t.now, sleep: async () => {}, log: (o) => logs.push(o), createRunner,
      verifyEvidence: (doc, x) => ({ ok: doc.nonce === x.nonce && doc.app === x.appId, reasons: [], instanceId: doc.instanceId, transportSpki: doc.transportSpki }) });
    agent.state().slots["1"].sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(agent.state().slots["1"].file)).digest("hex");
    t.advance(1000); await agent.tick(); t.advance(61_000); await agent.tick();   // D2 taken a second after D0's record, D1 a minute later
    assert.deepEqual(Object.values(agent.state().slots).filter(Boolean).map((a) => a.id).sort(), [D0, D1, D2].sort(), "three apps, 250 per mille each");

    const tokenFile = path.join(t.dir, "hosting-admin.token");
    srv = await agent.serveLocal(0, tokenFile);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, "the token is the app's alone");
    const base = `http://127.0.0.1:${srv.address().port}/v1/local/hosting`;
    const call = async (method, p = "", body, tok = token) => {
      const r = await realFetch(base + p, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return [r.status, await r.json()];
    };
    assert.equal((await call("GET", "", null, "nope"))[0], 401, "no token, no answer");

    let [st, v] = await call("GET");
    assert.equal(st, 200);
    assert.deepEqual(v.caps, { cpuShare: 1, gpuShare: 0, paused: false });
    assert.deepEqual([v.axes, v.cpuLabel, v.device.noun, v.backend, v.reservedShare], [["cpu"], "CPU & RAM", "phone", "pvm", 0]);
    assert.deepEqual([v.inUse.cpuShare, v.free.cpuShare, v.deploymentsServed], [0.75, 0.25, 3]);
    assert.deepEqual(v.market, { taking: true, why: "listed on enclave.host" });
    assert.deepEqual(v.apps.map((a) => a.host), ["d1d1d1d1.app.enclave.host", "d2d2d2d2.app.enclave.host", "d0d0d0d0.app.enclave.host"], "newest first");   // gitleaks:allow
    assert.equal(v.pricing.gpu, null);
    assert.deepEqual([v.pricing.cpu.override, v.pricing.cpu.tier, v.pricing.cpu.perHour], [0.0072, "pvm-cpu", 0.0072], "the price posted before the panel stays, as the owner's");

    // a share below what runs: what it would stop, newest first, until what stays fits; nothing changes until confirmed
    [st, v] = await call("PUT", "", { cpuShare: 0.3 });
    assert.equal(st, 409); assert.equal(v.error, "would_drop");
    assert.deepEqual(v.drop.map((u) => [u.id, u.cpuShare, u.gpuShare]), [[D1, 0.25, 0], [D2, 0.25, 0]]);
    assert.equal((await call("GET"))[1].caps.cpuShare, 1, "nothing changed");
    assert.equal((await call("PUT", "", { cpuShare: 0.3, drop: [D1] }))[0], 409, "a confirmation must name every one");
    assert.equal((await call("PUT", "", { gpuShare: 0.5 }))[0], 400, "a phone offers no GPU");
    [st, v] = await call("PUT", "", { cpuShare: 0.3, drop: [D1, D2] });
    assert.equal(st, 200);
    assert.deepEqual([v.caps.cpuShare, v.dropped.length], [0.3, 2]);
    assert.equal(JSON.parse(t.device.readOffer ? await t.device.readOffer() : "{}").cpuMilli, 300, "written where the agent reads it every round");
    t.advance(1000); await agent.tick();
    assert.deepEqual(Object.values(agent.state().slots).filter(Boolean).map((a) => a.id), [D0], "the two newest released");
    assert.equal(t.rows.get(D2).leaseUntil, 0n, "its lease handed back");

    // the price: the owner's, then the default (the market's, else the config's while the guide is unknown)
    [st, v] = await call("PUT", "/price", { cpuPerHour: 0.01 });
    assert.deepEqual([st, v.pricing.cpu.override, v.pricing.cpu.perHour], [200, 0.01, 0.0108]);
    assert.equal((await call("PUT", "/price", { cpuPerHour: 0 }))[0], 400);
    assert.equal((await call("PUT", "/price", { gpuPerHour: 1 }))[0], 400);
    t.advance(1000); await agent.tick();
    const hostCfg = t.made.filter((x) => x.config.proof.deployment === "0x" + "00".repeat(32)).at(-1).config;
    assert.equal(hostCfg.lifecycle.register.cpuPricePerSec6, "3", "the host runner re-states the entry at the owner's price");

    // the payout wallet, and Pay out now (any amount, with the host runner's next transaction)
    [st, v] = await call("GET", "/earnings");
    assert.deepEqual([st, v.readable, v.earned6, v.paidOut6, v.operator], [200, true, "1250000", "2250000", me]);
    assert.equal((await call("PUT", "/payout-wallet", { address: "0x12" }))[0], 400);
    [st, v] = await call("PUT", "/payout-wallet", { address: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61" });
    assert.deepEqual([st, v.wallet, v.payTo], [200, "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", "0x0b2d009c0c9af05b12100d77f3c815fea822ee61"]);
    assert.equal(agent.earnings().payout.to, "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", "the host runner pays it");
    t.advance(1000); await agent.tick();
    [st, v] = await call("POST", "/payout");
    assert.deepEqual([st, v.pending], [202, true]);
    assert.match(v.message, /^Paying out \$1\.25 to 0x0b2d00…ee61: the transaction goes out within a minute\.$/);
    assert.deepEqual(asked, ["0x" + "00".repeat(32)], "asked of the host runner");
    assert.equal((await call("GET", "/earnings"))[1].paying, true);
    [st, v] = await call("DELETE", "/payout-wallet");
    assert.deepEqual([st, v.wallet, v.payTo, v.why], [200, null, null, "no payout wallet is set"], "pay nobody: even the config's address is not used");

    // hosting off with an app here: asked first, then everything released by the round
    [st, v] = await call("PUT", "", { paused: true });
    assert.deepEqual([st, v.drop.map((u) => u.id)], [409, [D0]]);
    [st, v] = await call("PUT", "", { paused: true, drop: [D0] });
    assert.deepEqual([st, v.caps.paused, v.market.taking], [200, true, false]);
    t.advance(1000); await agent.tick();
    assert.deepEqual(Object.values(agent.state().slots).filter(Boolean), [], "hosting off: nothing runs");
    [st, v] = await call("PUT", "", { paused: false });
    assert.deepEqual([st, v.caps.paused, v.caps.cpuShare], [200, false, 0.3], "on again, the share kept");
  } finally { globalThis.fetch = realFetch; if (srv) srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});
