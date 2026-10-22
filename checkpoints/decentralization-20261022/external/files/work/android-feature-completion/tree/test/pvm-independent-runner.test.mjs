// The pVM runner LIFECYCLE in INDEPENDENT mode (runner-agent.mjs lifecycle { heartbeat: false, reactivate: false, leaseGas:
// true }) on a LOCAL chain: the REAL EnclaveRegistry, EnclaveDeployments, EnclaveProofOfTime and EnclaveAddressBook on anvil
// (test/fixtures/lease-chain.mjs), the REAL runner and proof agents, a fake VM over a synthetic AVF chain (a TEST root).
// The negative control is test/pvm-runner-agent.test.mjs "the whole lifecycle": the same timeline in legacy mode sends a
// heartbeat at ~1000 s and its own claim/renew/release.
// FIXTURE, labelled: the app-funded lease sender is a STAND-IN that submits the ledger call itself (the gas worker's
// EIP-7702 + paymaster path is their own test); what this file proves is that the RUNNER never signs a claim, renew,
// release or heartbeat in independent mode, never falls back when the sender refuses, and never revives a deregistered entry.
// The registered endpoint is an independent host's own (https://phone.example.org/pixel10), not a relay route.
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
import { createRunnerAgent, RUNNER_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/runner-agent.mjs";

const skip = (!haveOpenssl && "no openssl") || (!haveAnvil && "no anvil");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = createHash("sha256").update("pvm independent runner test build").digest();
const ENDPOINT = "https://phone.example.org/pixel10";
const LAB_REGISTER = { repo: "lab/pvm-independent-test", measurement: "0x" + CODE.toString("hex"), cpuPricePerSec6: "834" };
const askVm = (port, line) => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(line + "\n")); let b = "";
  c.on("data", (d) => (b += d)); c.on("end", () => resolve(b)); c.on("error", reject);
});
function startCarrier(vm) {
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", async () => { const ans = await askVm(vm.evidencePort, body.trim()); res.writeHead(200); res.end(ans); });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/evidence`, close: () => srv.close() })));
}

async function setup() {
  const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const dir = tmpdir("pvm-ind-runner-"), ca = makeCa(dir);
  const operator = privateKeyToAccount(generatePrivateKey());
  // an explicitly free port (the fixture's random range can meet another process's anvil)
  const port = await new Promise((r) => { const x = net.createServer().listen(0, "127.0.0.1", () => { const p = x.address().port; x.close(() => r(p)); }); });
  const chain = await startLeaseChain({ port, operatorAccount: operator, addressBook: true });
  const enclaveId = V.keccak256(V.stringToBytes(ENDPOINT));
  const D = await chain.createFunded(), pins = chain.pins(D, enclaveId);
  const vm = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha(`ind seed ${D}`), "hex"), proofPins: pins, checkpointEveryMs: 10 });
  const carrier = await startCarrier(vm);
  const proof = { format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint: ENDPOINT,
    operator: operator.address.toLowerCase(), carrier: carrier.url, maxFeePerGasWei: "100000000000",
    evidence: { appId: APP, allowedRuntimeIds: [sha(PIXEL)], allowedCodeHashes: [CODE.toString("hex")], allowedAuthorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin], instanceIds: [vm.instanceId] },
    policy: { confirmations: 1, receiptTimeoutMs: 6000, confirmTimeoutMs: 6000, pollMs: 1000 } };
  const lifecycle = { register: LAB_REGISTER, claim: true, heartbeat: false, reactivate: false, leaseGas: true };
  const clock = { t: 1_800_000_000_000 };
  // the RUNNER's own signed transactions, decoded (the only way it sends: publicClient.sendRawTransaction)
  const ledgerAbi = chain.abis.EnclaveDeployments.abi, registryAbi = chain.abis.EnclaveRegistry.abi, potAbi = chain.abis.EnclaveProofOfTime.abi;
  const runnerSent = [];
  const client = new Proxy(chain.publicClient, { get(t, k) {
    if (k !== "sendRawTransaction") return t[k];
    return async (a) => {
      const tx = V.parseTransaction(a.serializedTransaction);
      let fn = "?"; for (const abi of [ledgerAbi, registryAbi, potAbi]) { try { fn = V.decodeFunctionData({ abi, data: tx.data }).functionName; break; } catch {} }
      runnerSent.push(fn);
      return t.sendRawTransaction(a);
    };
  } });
  // the app-funded lease sender (STAND-IN: submits the ledger call itself; refuse = a LeaseRefusal code to answer with)
  const wallet = V.createWalletClient({ chain: chain.chain, transport: V.http(chain.rpc), account: operator });
  const send = async (functionName, args) => { const hash = await wallet.writeContract({ address: chain.addresses.ledger, abi: ledgerAbi, functionName, args });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); return { hash, receipt }; };
  const sender = { claims: [], renews: [], releases: [], refuse: null,
    claim: async (id, e) => { if (sender.refuse) throw Object.assign(new Error(`claim ${id} refused: ${sender.refuse}`), { code: sender.refuse }); sender.claims.push(id); return send("claim", [id, e]); },
    renew: async (id) => { sender.renews.push(id); return send("renew", [id]); },
    release: async (id) => { sender.releases.push(id); return send("release", [id]); } };
  const runnerOf = ({ stateDir = path.join(dir, "state"), lc = lifecycle } = {}) =>
    createRunnerAgent({ config: { format: RUNNER_CONFIG_FORMAT, proof, lifecycle: lc }, publicClient: client, account: operator, stateDir, now: () => clock.t,
                        sleep: async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)); }, ...(lc.leaseGas ? { leaseSender: sender } : {}) });
  const count = async (contract, ev) => (await chain.events(contract, ev)).filter((l) => !l.args.id || l.args.id === (contract === "registry" ? enclaveId : D)).length;
  const later = async (sec = 300) => { await chain.advance(sec); clock.t += 62_000; };
  const stop = () => { try { carrier.close(); } catch {} try { vm.close(); } catch {} chain.stop(); };
  return { V, dir, chain, D, enclaveId, vm, operator, clock, runnerOf, count, later, stop, sender, runnerSent, lifecycle };
}
const LEASE_OPS = ["claim", "renew", "release", "heartbeat"];

test("independent lifecycle on the real contracts: register (operator, design B), claim/renew/release only app-funded, proofs, and NO heartbeat",
     { skip, timeout: 240000 }, async () => {
  const S = await setup();
  let r;
  try {
    r = await S.runnerOf();
    const st = await r.start();
    assert.equal(st.attested.proofKey, S.vm.proofKey);
    const t1 = await r.tick();
    assert.match(t1.lifecycle.op, /^register/, JSON.stringify(t1));
    assert.equal(t1.lifecycle.kind, "landed");
    assert.equal(await S.chain.registeredProofKey(S.enclaveId), S.vm.proofKey, "registered under the independent endpoint with exactly the attested key");
    const t2 = await r.tick();
    assert.equal(t2.lifecycle.op, "claim", JSON.stringify(t2));
    assert.deepEqual([t2.lifecycle.kind, t2.lifecycle.via], ["landed", "app-funded"]);
    assert.deepEqual(S.sender.claims, [S.D]);
    assert.equal(await S.count("ledger", "Claimed"), 1);
    await S.later(300);
    const t3 = await r.tick();
    assert.equal(t3.lifecycle, null); assert.equal(t3.proof.kind, "landed", "a proof posted (operator-paid checkpoint, design B)");
    await S.later(700);   // ~1000 s since registering: the legacy runner heartbeats here (the negative control); this one does not
    const t4 = await r.tick();
    assert.equal(t4.lifecycle, null, `no heartbeat: ${JSON.stringify(t4.lifecycle)}`);
    assert.equal(t4.proof.kind, "landed");
    await S.later(300);   // inside the renew margin
    const t5 = await r.tick();
    assert.deepEqual([t5.lifecycle.op, t5.lifecycle.kind, t5.lifecycle.via], ["renew", "landed", "app-funded"]);
    assert.equal(await S.count("ledger", "Renewed"), 1);
    S.clock.t += 62_000;
    assert.equal((await r.tick()).lifecycle, null, "renewed once");
    await S.chain.advance(120);
    const sp = await r.stop({ release: true });
    assert.equal(sp.kind, "released", JSON.stringify(sp));
    assert.equal(sp.proof.kind, "landed", "the final proof first");
    assert.deepEqual(S.sender.releases, [S.D]);
    assert.equal(await S.count("registry", "Heartbeat"), 0, "no heartbeat event on the chain at all");
    assert.deepEqual(S.runnerSent.filter((f) => LEASE_OPS.includes(f)), [], `the runner signed none of ${LEASE_OPS.join("/")}: ${S.runnerSent.join(",")}`);
    assert.ok(S.runnerSent.includes("register") && S.runnerSent.includes("checkpoint"), `the runner's own: ${S.runnerSent.join(",")}`);
  } finally { if (r) r.close(); S.stop(); }
});

test("independent: a refused app-funded claim is never paid by the operator; a deregistered entry is never revived",
     { skip, timeout: 240000 }, async () => {
  const S = await setup();
  let r;
  try {
    r = await S.runnerOf(); await r.start();
    assert.match((await r.tick()).lifecycle.op, /^register/);
    // the owner's reserve refuses (sponsorship disabled): the claim is NOT sent by the operator instead
    S.sender.refuse = "Disabled";
    const n0 = S.runnerSent.length;
    const t = await r.tick();
    assert.deepEqual([t.lifecycle.op, t.lifecycle.kind, t.lifecycle.code], ["claim", "claim-refused", "Disabled"], JSON.stringify(t));
    assert.equal(await S.count("ledger", "Claimed"), 0);
    assert.deepEqual(S.runnerSent.slice(n0).filter((f) => LEASE_OPS.includes(f)), [], "no operator-paid fallback");
    // the operator deregisters the host: the runner stops; nothing re-registers it on a routine tick
    S.sender.refuse = null;
    await S.chain.deregister(S.enclaveId); await S.later(1000);
    const regs = await S.count("registry", "Registered");
    const n1 = S.runnerSent.length;
    const d = await r.tick();
    assert.equal(d.kind, "registry-inactive", JSON.stringify(d));
    assert.match(d.lifecycle.reason, /deregistration stands/);
    assert.equal(await S.count("registry", "Registered"), regs, "not revived");
    assert.deepEqual(S.runnerSent.slice(n1), [], "nothing sent");
    r.close(); r = null;
    // NEGATIVE CONTROL: the legacy lifecycle (reactivate default) WOULD revive it on the same routine tick
    r = await S.runnerOf({ stateDir: path.join(S.dir, "legacy"), lc: { register: LAB_REGISTER, claim: true } }); await r.start();
    const c = await r.tick();
    assert.match(c.lifecycle.op, /re-activate/, JSON.stringify(c));
  } finally { if (r) r.close(); S.stop(); }
});
