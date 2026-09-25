// The pVM runner LIFECYCLE agent (shielded/anchor/avf/runner/runner-agent.mjs; RUNNER-AGENT.md) on a LOCAL chain: the REAL
// EnclaveRegistry, EnclaveDeployments, EnclaveProofOfTime and EnclaveAddressBook on anvil (test/fixtures/lease-chain.mjs), a
// fake VM speaking the device protocol behind an HTTP carrier stand-in, and a fresh random operator key per test. Nothing
// is pre-registered or pre-claimed: the agent does it. Interruptions are made by a node that swallows sends and by closing
// the agent (a crash leaves exactly what the journal says); every "exactly once" is counted from the chain's own events.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";
import { tmpdir, makeCa, haveOpenssl, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance, PIXEL } from "./fixtures/pvm-fake-vm.mjs";
import { startLeaseChain, haveAnvil } from "./fixtures/lease-chain.mjs";
import { AGENT_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/proof-agent.mjs";
import { createRunnerAgent, checkRunnerConfig, RUNNER_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/runner-agent.mjs";

const skip = (!haveOpenssl && "no openssl") || (!haveAnvil && "no anvil");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = createHash("sha256").update("pvm runner-agent test build").digest();
const ENDPOINT = "https://api.enclave.host/t/pixel10-pvm-cpu";
const LAB_REGISTER = { repo: "lab/pvm-runner-test", measurement: "0x" + CODE.toString("hex"), cpuPricePerSec6: "834" };   // synthetic lab values, not a production price
const askVm = (port, line) => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(line + "\n")); let b = "";
  c.on("data", (d) => (b += d)); c.on("end", () => resolve(b)); c.on("error", reject);
});
function startCarrier(vm) {
  const state = { lines: [], target: vm };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", async () => { state.lines.push(body.trim()); const ans = await askVm(state.target.evidencePort, body.trim()); res.writeHead(200); res.end(ans); });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/evidence`, state, close: () => srv.close() })));
}

async function setup() {
  const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const dir = tmpdir("pvm-runner-"), ca = makeCa(dir);
  const operatorKeyHex = generatePrivateKey(), operator = privateKeyToAccount(operatorKeyHex);   // a fresh test key per setup
  const chain = await startLeaseChain({ operatorAccount: operator, addressBook: true });
  const enclaveId = V.keccak256(V.stringToBytes(ENDPOINT));
  const D = await chain.createFunded(), pins = chain.pins(D, enclaveId);
  const vm = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha(`runner seed ${D}`), "hex"), proofPins: pins, checkpointEveryMs: 10 });
  const carrier = await startCarrier(vm);
  const proof = { format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint: ENDPOINT,
    operator: operator.address.toLowerCase(), carrier: carrier.url, maxFeePerGasWei: "100000000000",
    evidence: { appId: APP, allowedRuntimeIds: [sha(PIXEL)], allowedCodeHashes: [CODE.toString("hex")], allowedAuthorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin], instanceIds: [vm.instanceId] },
    policy: { confirmations: 1, receiptTimeoutMs: 6000, confirmTimeoutMs: 6000, pollMs: 1000 } };
  const config = (lifecycle = { register: LAB_REGISTER, claim: true }, proofOver = {}) => ({ format: RUNNER_CONFIG_FORMAT, proof: { ...proof, ...proofOver }, lifecycle });
  const clock = { t: 1_800_000_000_000 };
  const runnerOf = ({ cfg = config(), client = chain.publicClient, stateDir = path.join(dir, "state") } = {}) =>
    createRunnerAgent({ config: cfg, publicClient: client, account: operator, stateDir, now: () => clock.t,
                        sleep: async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)); } });
  const count = async (contract, ev) => (await chain.events(contract, ev)).filter((l) => !l.args.id || l.args.id === (contract === "registry" ? enclaveId : D)).length;
  const nonceOf = () => chain.publicClient.getTransactionCount({ address: operator.address, blockTag: "latest" });
  const later = async (sec = 300) => { await chain.advance(sec); clock.t += 62_000; };
  const lossy = () => { const h = { swallow: true }; h.client = new Proxy(chain.publicClient, { get(t, k) {
    if (k === "sendRawTransaction") return async (a) => (h.swallow ? V.keccak256(a.serializedTransaction) : t.sendRawTransaction(a));
    return t[k]; } }); return h; };
  const stop = () => { try { carrier.close(); } catch {} try { vm.close(); } catch {} chain.stop(); };
  return { V, dir, ca, pins, chain, D, enclaveId, vm, carrier, operator, operatorKeyHex, config, clock, runnerOf, count, nonceOf, later, lossy, stop };
}

test("runner config: strict; the owner's registration values are required to register and never defaulted", () => {
  const proof = { format: AGENT_CONFIG_FORMAT, chainId: "8453", addressBook: "0xab214342d5a490150a4a977063a2f88e21f80907", deployment: "0x" + "11".repeat(32),
    endpoint: ENDPOINT, operator: "0x" + "22".repeat(20), carrier: "https://api.enclave.host/x/" + "11".repeat(32) + "/pvm/evidence", maxFeePerGasWei: "2000000000",
    evidence: { appId: "aa".repeat(32), allowedRuntimeIds: ["bb".repeat(32)], allowedCodeHashes: ["cc".repeat(32)], allowedAuthorityHashes: ["dd".repeat(64)], rootPins: ["ee".repeat(32)], instanceIds: ["ff".repeat(32)] } };
  const ok = checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof, lifecycle: {} });
  assert.equal(ok.lifecycle.claim, false, "claiming is opt-in");
  assert.equal(ok.lifecycle.maxClaimBond6, "0", "no bond unless the owner says so");
  assert.equal(ok.lifecycle.register, undefined, "no invented registration values");
  const refuse = (lifecycle, re, over = {}) => assert.throws(() => checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof, lifecycle, ...over }), re);
  refuse({ register: { repo: "x", measurement: "0x" + "12".repeat(32) } }, /exactly \{ repo, measurement, cpuPricePerSec6 \}/);
  refuse({ register: { ...LAB_REGISTER, cpuPricePerSec6: "0" } }, /price > 0/);   // (the price rule fires before the measurement rule)
  refuse({ register: { ...LAB_REGISTER, measurement: "0x12" } }, /measurement/);
  const withPin = { ...proof, evidence: { ...proof.evidence, allowedCodeHashes: [CODE.toString("hex")] } };
  assert.equal(checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof: withPin, lifecycle: { register: LAB_REGISTER } }).lifecycle.register.measurement, LAB_REGISTER.measurement);
  assert.throws(() => checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof: withPin, lifecycle: { register: { ...LAB_REGISTER, measurement: "0x" + "12".repeat(32) } } }),
                /measurement must be one of the evidence's allowedCodeHashes .*: [0-9a-f]{64}/, "a measurement that is not the attested build's code hash");
  refuse({ claim: "yes" }, /true or false/);
  refuse({ renewMarginSec: 10 }, />= 60/);
  refuse({ autoBond: true }, /unknown lifecycle key/);
  refuse({}, /exactly format, proof, lifecycle/, { extra: 1 });
  assert.throws(() => checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof: { ...proof, chainId: "0x2105" }, lifecycle: {} }), /chainId/);
});

test("the whole lifecycle on a local chain: register with the ATTESTED key, claim, prove, heartbeat when due, renew once inside the margin, final proof THEN release",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r;
  try {
    r = await S.runnerOf();
    const st = await r.start();
    assert.equal(st.attested.proofKey, S.vm.proofKey);
    const t1 = await r.tick();
    assert.equal(t1.lifecycle.kind, "landed", JSON.stringify(t1));
    assert.match(t1.lifecycle.op, /^register/);
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), S.vm.proofKey, "registered with exactly the attested key");
    assert.equal(t1.proof.kind, "not-our-lease");
    const t2 = await r.tick();
    assert.equal(t2.lifecycle.op, "claim", JSON.stringify(t2));
    assert.equal(t2.lifecycle.kind, "landed");
    const leased = BigInt(t2.lifecycle.args.leaseUntil);
    await S.later(300);
    const t3 = await r.tick();
    assert.equal(t3.lifecycle, null, "nothing due: no renew, no heartbeat");
    assert.equal(t3.proof.kind, "landed");
    await S.later(700);   // ~1000 s since registering: the heartbeat is due; the lease still has ~800 s
    const t4 = await r.tick();
    assert.equal(t4.lifecycle.op, "heartbeat", JSON.stringify(t4.lifecycle));
    assert.equal(t4.proof.kind, "landed");
    await S.later(300);   // now inside the 600 s margin
    const bal0 = (await S.chain.deployment(S.D)).balance6;
    const t5 = await r.tick();
    assert.equal(t5.lifecycle.op, "renew", JSON.stringify(t5.lifecycle));
    assert.equal(BigInt(t5.lifecycle.args.leaseUntil), leased + 1800n, "extended from leaseUntil by one quantum");
    assert.equal(bal0 - (await S.chain.deployment(S.D)).balance6, BigInt(t5.lifecycle.args.burned6), "the tenant paid exactly that quantum");
    S.clock.t += 62_000;
    const t6 = await r.tick();
    assert.equal(t6.lifecycle, null, "renewed once: no second renew");
    assert.equal(await S.count("ledger", "Renewed"), 1);
    // stop: the final proof lands BEFORE the release; the tenant gets the tail back
    await S.chain.advance(120);
    const balBefore = (await S.chain.deployment(S.D)).balance6;
    const sp = await r.stop({ release: true });
    assert.equal(sp.kind, "released", JSON.stringify(sp));
    assert.equal(sp.proof.kind, "landed", "a final proof first");
    const d = await S.chain.deployment(S.D);
    assert.equal(d.runner, "0x" + "00".repeat(32));
    assert.ok(d.balance6 > balBefore, "the unused tail went back to the tenant");
    const cps = await S.chain.events("prover", "Checkpointed"), rel = await S.chain.events("ledger", "Released");
    assert.ok(cps.at(-1).blockNumber < rel.at(-1).blockNumber, "the final checkpoint was mined before the release");
    assert.equal(await S.count("ledger", "Claimed"), 1);
    assert.equal(rel.length, 1);
  } finally { if (r) r.close(); S.stop(); }
});

test("the entry: another operator's endpoint is never touched; a missing or deactivated entry is not created or revived without the owner's registration values; an old key is replaced by the ATTESTED one",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r;
  try {
    // another operator holds the endpoint
    const S2 = await setup();
    try {
      await S2.chain.register({ endpoint: ENDPOINT, proofKey: "0x" + "56".repeat(20), from: S2.chain.accounts.stranger });
      r = await S2.runnerOf(); await r.start();
      const a = await r.tick();
      assert.equal(a.kind, "endpoint-taken", JSON.stringify(a));
      assert.equal(await S2.nonceOf(), 0, "nothing sent");
      r.close(); r = null;
    } finally { S2.stop(); }
    // no entry, no registration values: nothing is created
    r = await S.runnerOf({ cfg: S.config({ claim: true }) }); await r.start();
    const b = await r.tick();
    assert.equal(b.kind, "registry-missing", JSON.stringify(b));
    r.close(); r = null;
    // the owner registered by hand with an OLD key: setProofKey to the attested one, then the claim
    await S.chain.register({ endpoint: ENDPOINT, proofKey: "0x" + "78".repeat(20) });
    r = await S.runnerOf({ cfg: S.config({ claim: true }), stateDir: path.join(S.dir, "s2") }); await r.start();
    const c = await r.tick();
    assert.equal(c.lifecycle.op, "setProofKey", JSON.stringify(c));
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), S.vm.proofKey);
    assert.equal((await r.tick()).lifecycle.op, "claim");
    // deactivated by the owner: not revived (a heartbeat would re-activate it), and no heartbeat is sent
    await S.chain.deregister(S.enclaveId); await S.later(1000);
    const n0 = await S.nonceOf();
    const e = await r.tick();
    assert.equal(e.kind, "registry-inactive", JSON.stringify(e));
    assert.equal(await S.nonceOf(), n0, "no heartbeat, no transaction");
    assert.equal(await S.count("registry", "Heartbeat"), 0);
  } finally { if (r) r.close(); S.stop(); }
});

test("a key goes on-chain only from a FRESH statement: after the VM is re-provisioned (new key, new instance), a re-registration carries the NEW key, never the stale attested one",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r, vm2;
  try {
    vm2 = await startFakeVm({ dir: S.dir, ca: S.ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha("re-provisioned instance"), "hex"), proofPins: S.pins, checkpointEveryMs: 10 });
    // the owner's policy binds both instances (the re-provisioned one enrolled)
    const cfg = S.config(); cfg.proof.evidence.instanceIds = [S.vm.instanceId, vm2.instanceId];
    r = await S.runnerOf({ cfg }); await r.start();
    assert.match((await r.tick()).lifecycle.op, /^register/);
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), S.vm.proofKey);
    // re-provisioned: the carrier now reaches the new VM; the agent still holds its earlier attestation of the OLD key
    S.carrier.state.target = vm2;
    await S.chain.deregister(S.enclaveId);   // the entry needs re-registering (the owner's deactivation, reversed by the configured register)
    const a = await r.tick();
    assert.match(a.lifecycle.op, /^register \(re-activate\)/, JSON.stringify(a.lifecycle));
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), vm2.proofKey, "the re-registration carries the NEW key from a fresh statement");
    assert.notEqual(vm2.proofKey, S.vm.proofKey);
  } finally { if (r) r.close(); if (vm2) vm2.close(); S.stop(); }
});

test("setProofKey carries the FRESH statement's key: the registry publishes K0, the agent holds an earlier attestation of K1, the VM is re-provisioned to K2 before any proof re-attests -> K2, never K1",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r, vm2;
  try {
    vm2 = await startFakeVm({ dir: S.dir, ca: S.ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha("re-provisioned K2"), "hex"), proofPins: S.pins, checkpointEveryMs: 10 });
    const K0 = "0x" + "78".repeat(20);
    await S.chain.register({ endpoint: ENDPOINT, proofKey: K0 });           // the owner set another key earlier
    const cfg = S.config(); cfg.proof.evidence.instanceIds = [S.vm.instanceId, vm2.instanceId];
    r = await S.runnerOf({ cfg });
    assert.equal((await r.start()).attested.proofKey, S.vm.proofKey);       // the agent holds K1
    S.carrier.state.target = vm2;                                            // re-provisioned to K2, before any tick
    const a = await r.tick();
    assert.equal(a.lifecycle.op, "setProofKey", JSON.stringify(a.lifecycle));
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), vm2.proofKey, "K2, from a fresh statement");
    assert.notEqual(vm2.proofKey, S.vm.proofKey); assert.notEqual(vm2.proofKey, K0);
  } finally { if (r) r.close(); if (vm2) vm2.close(); S.stop(); }
});

test("the registered measurement is EXACTLY the attested build: a config naming another pinned build registers nothing",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let r;
  try {
    const OTHER = createHash("sha256").update("another pinned build").digest("hex");
    const cfg = S.config({ register: { ...LAB_REGISTER, measurement: "0x" + OTHER }, claim: true });
    cfg.proof.evidence.allowedCodeHashes = [CODE.toString("hex"), OTHER];   // both pinned; the VM attests CODE
    r = await S.runnerOf({ cfg }); await r.start();
    const a = await r.tick();
    assert.equal(a.kind, "measurement-mismatch", JSON.stringify(a));
    assert.equal(await S.nonceOf(), 0, "nothing registered");
  } finally { if (r) r.close(); S.stop(); }
});

test("a mined lifecycle call WITHOUT the event it must produce is recorded as a failure, never as landed",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let r;
  try {
    const registry = S.chain.addresses.registry.toLowerCase();
    const noEvents = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "getTransactionReceipt") return async (a) => { const x = await t.getTransactionReceipt(a); return x && x.to && x.to.toLowerCase() === registry ? { ...x, logs: [] } : x; };
      return t[k];
    } });
    r = await S.runnerOf({ client: noEvents }); await r.start();
    const a = await r.tick();
    assert.equal(a.lifecycle.kind, "reverted", JSON.stringify(a.lifecycle));
    assert.match(a.lifecycle.reason, /mined without its Registered\|Updated event/);
  } finally { if (r) r.close(); S.stop(); }
});

test("the claim: an unauthorized bond, another runner's live lease, and a claim race lost at simulation each send nothing",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r;
  try {
    r = await S.runnerOf(); await r.start();
    assert.match((await r.tick()).lifecycle.op, /^register/);
    await S.chain.setClaimBond(1_000_000n);
    const n0 = await S.nonceOf();
    const a = await r.tick();
    assert.equal(a.lifecycle.kind, "bond-required", JSON.stringify(a));
    assert.equal(await S.nonceOf(), n0);
    await S.chain.setClaimBond(0n);
    // a race: another runner claims between our read and our send -> the simulation refuses; nothing is sent
    const other = "https://api.enclave.host/t/another-phone";
    await S.chain.register({ endpoint: other, proofKey: "0x" + "9a".repeat(20), from: S.chain.accounts.stranger });
    const otherId = S.V.keccak256(S.V.stringToBytes(other));
    r.close();
    let raced = false;
    const client = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "simulateContract") return async (args) => {
        if (args.functionName === "claim" && !raced) { raced = true; await S.chain.claim(S.D, otherId, S.chain.accounts.stranger); }
        return t.simulateContract(args);
      };
      return t[k];
    } });
    r = await S.runnerOf({ client, stateDir: path.join(S.dir, "race") }); await r.start();
    const n1 = await S.nonceOf();
    const b = await r.tick();
    assert.equal(b.lifecycle.kind, "claim-refused", JSON.stringify(b));
    assert.match(b.lifecycle.reason, /leased/);
    assert.equal(await S.nonceOf(), n1);
    // and on the next tick the other runner's live lease is simply not ours
    const c = await r.tick();
    assert.equal(c.lifecycle, null, JSON.stringify(c));
    assert.equal(c.proof.kind, "not-our-lease");
    assert.equal(await S.count("ledger", "Claimed"), 1, "only the other runner's claim");
  } finally { if (r) r.close(); S.stop(); }
});

test("renew only what is proven: a lease whose app stopped serving is left to lapse (the tenant's balance untouched), then re-claimed in place when it serves again",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let r;
  try {
    r = await S.runnerOf(); await r.start();
    await r.tick(); await r.tick();   // register, claim
    S.vm.setServing(false);
    await S.later(1300);              // inside the margin, and the proofs stopped at the claim
    const bal = (await S.chain.deployment(S.D)).balance6;
    const a = await r.tick();
    assert.notEqual(a.lifecycle && a.lifecycle.op, "renew", JSON.stringify(a));
    assert.equal(a.proof.kind, "vm-refused");
    assert.equal((await S.chain.deployment(S.D)).balance6, bal, "no renew spent the tenant's balance");
    assert.equal(await S.count("ledger", "Renewed"), 0);
    await S.later(600);               // the lease lapses
    S.vm.setServing(true);
    const b = await r.tick();
    assert.equal(b.lifecycle.op, "claim (re-claim a lapsed lease)", JSON.stringify(b.lifecycle));
    assert.equal(b.lifecycle.kind, "landed");
    await S.later(200);
    assert.equal((await r.tick()).proof.kind, "landed", "proving again");
  } finally { if (r) r.close(); S.stop(); }
});

test("interrupted and restarted: a claim, a renew and a release journaled but never delivered are each delivered ONCE; a renew still in the mempool is followed, never repeated",
     { skip, timeout: 240000 }, async () => {
  const S = await setup();
  let r;
  const quick = S.config({ register: LAB_REGISTER, claim: true }, { policy: { confirmations: 1, receiptTimeoutMs: 3000, confirmTimeoutMs: 3000, pollMs: 1000, maxReplacements: 0 } });
  // move to 500 s before the lease ends with a proof landed 150 s earlier, so a renew is due AND earned
  const toMargin = async () => {
    const d = await S.chain.deployment(S.D), now = await S.chain.now();
    await S.chain.advance(Number(d.leaseUntil) - now - 650); S.clock.t += 62_000;
    const h = await S.runnerOf(); await h.start();
    const t = await h.tick(); assert.equal(t.proof.kind, "landed", `a proof before the margin: ${JSON.stringify(t)}`); h.close();
    await S.chain.advance(150); S.clock.t += 62_000;
  };
  try {
    // (1) a claim journaled, never delivered (a node that swallows it), then the process dies
    const h = S.lossy(); h.swallow = false;
    r = await S.runnerOf({ cfg: quick, client: h.client }); await r.start();
    assert.match((await r.tick()).lifecycle.op, /^register/);
    h.swallow = true;
    const c = await r.tick();
    assert.equal(c.kind, "in-flight", JSON.stringify(c));
    assert.equal(c.lifecycle.op, "claim");
    r.close();
    r = await S.runnerOf(); const st = await r.start();
    assert.equal(st.recovered.op, "claim"); assert.equal(st.recovered.kind, "landed", JSON.stringify(st.recovered));
    assert.equal(await S.count("ledger", "Claimed"), 1);
    r.close(); r = null;
    // (2) a renew journaled, never delivered: the restart delivers the SAME renew once; the tenant pays one quantum
    await toMargin();
    const h2 = S.lossy();
    r = await S.runnerOf({ cfg: quick, client: h2.client }); await r.start();
    const bal0 = (await S.chain.deployment(S.D)).balance6;
    const a = await r.tick();
    assert.equal(a.kind, "in-flight", JSON.stringify(a)); assert.equal(a.lifecycle.op, "renew");
    r.close();
    r = await S.runnerOf(); const st2 = await r.start();
    assert.equal(st2.recovered.op, "renew"); assert.equal(st2.recovered.kind, "landed", JSON.stringify(st2.recovered));
    S.clock.t += 62_000;
    const a2 = await r.tick();
    assert.notEqual(a2.lifecycle && a2.lifecycle.op, "renew", "the lease is extended: no second renew");
    assert.equal(await S.count("ledger", "Renewed"), 1);
    assert.equal(bal0 - (await S.chain.deployment(S.D)).balance6, BigInt(st2.recovered.args.burned6), "the tenant paid exactly one quantum");
    r.close(); r = null;
    // (3) a renew in the mempool when the agent dies (blocks stopped): the next agent follows it and never sends another
    await toMargin();
    await S.chain.setAutomine(false);
    r = await S.runnerOf({ cfg: quick }); await r.start();
    const b = await r.tick();
    assert.equal(b.kind, "in-flight", JSON.stringify(b)); assert.equal(b.lifecycle.op, "renew");
    r.close();
    r = await S.runnerOf({ cfg: quick }); await r.start();
    const b2 = await r.tick();
    assert.equal(b2.kind, "in-flight", "still in the mempool: followed, not re-decided");
    assert.equal(await S.chain.publicClient.getTransactionCount({ address: S.operator.address, blockTag: "pending" }), (await S.nonceOf()) + 1, "one transaction in flight, not two");
    await S.chain.setAutomine(true); await S.chain.mine(1);
    const b3 = await r.tick();
    assert.notEqual(b3.lifecycle && b3.lifecycle.op, "renew");
    assert.equal(await S.count("ledger", "Renewed"), 2, "exactly one more renew");
    r.close(); r = null;
    // (4) the final proof lands, the release is never delivered, the process dies: the restart delivers that release once,
    //     and no proof follows it (release clears the watermark)
    await S.chain.advance(120); S.clock.t += 62_000;
    const ledger = S.chain.addresses.ledger.toLowerCase();
    const noLedger = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "sendRawTransaction") return async (x) => ((S.V.parseTransaction(x.serializedTransaction).to || "").toLowerCase() === ledger ? S.V.keccak256(x.serializedTransaction) : t.sendRawTransaction(x));
      return t[k];
    } });
    r = await S.runnerOf({ cfg: quick, client: noLedger }); await r.start();
    const s1 = await r.stop({ release: true });
    assert.equal(s1.proof && s1.proof.kind, "landed", JSON.stringify(s1));
    assert.notEqual(s1.kind, "released");
    const cps = (await S.chain.events("prover", "Checkpointed")).length;
    r.close();
    r = await S.runnerOf(); const st4 = await r.start();
    assert.equal(st4.recovered.op, "release"); assert.equal(st4.recovered.kind, "landed", JSON.stringify(st4.recovered));
    const s2 = await r.stop({ release: true });
    assert.equal(s2.kind, "not-our-lease", JSON.stringify(s2));
    assert.equal(await S.count("ledger", "Released"), 1, "released exactly once");
    assert.equal((await S.chain.deployment(S.D)).runner, "0x" + "00".repeat(32));
    assert.equal((await S.chain.events("prover", "Checkpointed")).length, cps, "no proof after the release");
  } finally { if (r) r.close(); S.stop(); }
});

test("the CLI runs the lifecycle agent from a runner config: one real tick registers; --release with nothing leased exits cleanly; --release on a proof-only config is refused",
     { skip, timeout: 180000 }, async () => {
  const fs = await import("node:fs"), { spawn, spawnSync } = await import("node:child_process");
  const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "../shielded/anchor/avf/runner/proof-agent-cli.mjs");
  const S = await setup();
  try {
    const cfgFile = path.join(S.dir, "runner.json"), keyFile = path.join(S.dir, "op.key");
    fs.writeFileSync(cfgFile, JSON.stringify(S.config())); fs.writeFileSync(keyFile, S.operatorKeyHex + "\n", { mode: 0o600 });
    const env = { PATH: process.env.PATH, PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: keyFile };
    // ASYNC spawn: the fake VM and the carrier live in THIS process, and spawnSync would block them
    const run = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, "--config", cfgFile, "--state", path.join(S.dir, "cli"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d)); c.on("exit", (code) => resolve({ code, out, err }));
    });
    const once = await run(["--once"]);
    assert.equal(once.code, 0, once.err + once.out);
    assert.ok(once.out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((l) => l.ev === "done" && l.kind === "landed" && /^register/.test(l.op)), once.out);
    assert.equal((await S.chain.events("registry", "Registered")).length, 1);
    const rel = await run(["--release"]);
    assert.equal(rel.code, 0, rel.err + rel.out);
    assert.match(rel.out, /"ev":"stop","kind":"not-our-lease"/);
    fs.writeFileSync(path.join(S.dir, "proof-only.json"), JSON.stringify(S.config().proof));
    const bad = spawnSync(process.execPath, [CLI, "--config", path.join(S.dir, "proof-only.json"), "--state", path.join(S.dir, "x"), "--release"], { env, encoding: "utf8" });   // refused before any carrier call
    assert.equal(bad.status, 2); assert.match(bad.stderr, /--release needs a runner config/);
    for (const o of [once.out, once.err, rel.out, rel.err]) assert.ok(!o.includes(S.operatorKeyHex.slice(2)), "the key never appears in the output");
  } finally { S.stop(); }
});
