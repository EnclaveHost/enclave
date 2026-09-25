// The owner-side posting agent (shielded/anchor/avf/runner/proof-agent.mjs) on a LOCAL lease: the REAL EnclaveRegistry,
// EnclaveDeployments, EnclaveProofOfTime and EnclaveAddressBook on anvil (test/fixtures/lease-chain.mjs: no network, no funds,
// nothing public), a fake VM that speaks the device's wire protocol (test/fixtures/pvm-fake-vm.mjs: PROOFKEY, CHECKPOINT) behind
// an HTTP carrier stand-in that can turn hostile, and an operator that is a fresh random local key per test (never a real
// wallet). The agent's clock is the test's: each sleep advances it (and, where a test says so, mines a block), so the bounded
// waits run in milliseconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";
import { tmpdir, makeCa, haveOpenssl, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance, PIXEL } from "./fixtures/pvm-fake-vm.mjs";
import { startLeaseChain, haveAnvil } from "./fixtures/lease-chain.mjs";
import { createProofAgent, checkAgentConfig, pendingFromJournal, AGENT_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/proof-agent.mjs";

const skip = (!haveOpenssl && "no openssl") || (!haveAnvil && "no anvil");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = createHash("sha256").update("pvm proof-agent test build").digest();
const ENDPOINT = "https://api.enclave.host/t/pixel10-pvm-cpu";
const askVm = (port, line) => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(line + "\n")); let b = "";
  c.on("data", (d) => (b += d)); c.on("end", () => resolve(b)); c.on("error", reject);
});

// POST /evidence -> the VM's evidence port, like cpu/web-carrier.mjs; `state.mode` turns it hostile
function startCarrier(vm) {
  const state = { mode: "honest", target: vm, last: null, lastStatement: null, lines: [], rateRefusals: 0, refusalText: null };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const line = body.trim(); state.lines.push(line);
      if (state.mode === "503") { res.writeHead(503); return res.end(); }
      // the VM's evidence budget spent by another caller: the payload's own refusal line, verbatim, for the next N requests
      if (state.rateRefusals > 0) { state.rateRefusals--; res.writeHead(200, { "content-type": "application/json" }); return res.end(`{"error":"${state.refusalText || "one evidence answer every 2 s"}"}\n`); }
      // swap-anchor: the VM is asked to sign another anchor hash than the agent's (a genuine signature for the same upto and block)
      const fwd = state.mode === "swap-anchor" && line.startsWith("CHECKPOINT") ? line.replace(/ [0-9a-f]{64}$/, " " + "ab".repeat(32)) : line;
      const ans = await askVm(state.target.evidencePort, fwd);
      let out = ans;
      if (line.startsWith("PROOFKEY")) {   // replay-statement: the previous, genuine statement for a new nonce
        if (state.mode === "replay-statement" && state.lastStatement) out = state.lastStatement;
        else if (!/"error"/.test(ans)) state.lastStatement = ans;
      }
      if (line.startsWith("CHECKPOINT")) {
        if (state.mode === "replay" && state.last) out = state.last;   // the VM signed the new request; the carrier hands back the old answer
        if (!/"error"/.test(ans)) state.last = ans;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(out);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/evidence`, state, close: () => srv.close() })));
}

async function setup({ addressBook = true, register = "vm", claim = true } = {}) {
  const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const dir = tmpdir("pvm-agent-"), ca = makeCa(dir);
  const operatorKeyHex = generatePrivateKey(), operator = privateKeyToAccount(operatorKeyHex);   // a fresh test key, funded on the local chain only
  const chain = await startLeaseChain({ operatorAccount: operator, addressBook });
  const enclaveId = V.keccak256(V.stringToBytes(ENDPOINT));
  const D = await chain.createFunded(), pins = chain.pins(D, enclaveId);
  const vm = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha(`seed ${D}`), "hex"), proofPins: pins, checkpointEveryMs: 10 });
  const carrier = await startCarrier(vm);
  if (register) await chain.register({ endpoint: ENDPOINT, proofKey: register === "vm" ? vm.proofKey : register });
  if (claim) await chain.claim(D, enclaveId);
  const config = (over = {}) => ({ format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), ...(addressBook ? { addressBook: chain.addresses.addressBook.toLowerCase() }
      : { proofOfTime: chain.addresses.proofOfTime.toLowerCase(), registry: chain.addresses.registry.toLowerCase(), deployments: chain.addresses.ledger.toLowerCase() }),
    deployment: D, endpoint: ENDPOINT, operator: operator.address.toLowerCase(), carrier: carrier.url, maxFeePerGasWei: "100000000000",
    evidence: { appId: APP, allowedRuntimeIds: [sha(PIXEL)], allowedCodeHashes: [CODE.toString("hex")], allowedAuthorityHashes: [AUTH.toString("hex")],
                rootPins: [ca.rootPin], instanceIds: [vm.instanceId] },
    policy: { confirmations: 1, receiptTimeoutMs: 8000, confirmTimeoutMs: 8000, pollMs: 1000 }, ...over });
  const clock = { t: 1_800_000_000_000, mineOnSleep: false, onSleep: null };
  const agentOf = async ({ cfg = config(), client = chain.publicClient, account = operator, stateDir = path.join(dir, "state") } = {}) =>
    createProofAgent({ config: cfg, publicClient: client, account, stateDir, now: () => clock.t,
                       sleep: async (ms) => { clock.t += ms; if (clock.onSleep) await clock.onSleep(); if (clock.mineOnSleep) await chain.mine(1); await new Promise((r) => setImmediate(r)); } });
  const checkpointsAsked = () => carrier.state.lines.filter((l) => l.startsWith("CHECKPOINT")).length;
  const nonceOf = () => chain.publicClient.getTransactionCount({ address: operator.address, blockTag: "latest" });
  const journal = (sd = path.join(dir, "state")) => fs.readFileSync(path.join(sd, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const later = async (sec = 300) => { await chain.advance(sec); clock.t += 62_000; };   // chain time passes; the VM's 60 s rate is honoured
  const stop = () => { try { carrier.close(); } catch {} try { vm.close(); } catch {} chain.stop(); };
  return { V, dir, ca, chain, D, enclaveId, pins, vm, carrier, operator, operatorKeyHex, config, clock, agentOf, checkpointsAsked, nonceOf, journal, later, stop };
}

test("config: strict and public-only -- every rule refuses rather than repairs", () => {
  const base = { format: AGENT_CONFIG_FORMAT, chainId: "8453", addressBook: "0xab214342d5a490150a4a977063a2f88e21f80907", deployment: "0x" + "11".repeat(32),
    endpoint: "https://api.enclave.host/t/pixel10-pvm-cpu", operator: "0x" + "22".repeat(20), carrier: "https://api.enclave.host/x/" + "11".repeat(32) + "/pvm/evidence",
    maxFeePerGasWei: "2000000000", evidence: { appId: "aa".repeat(32), allowedRuntimeIds: ["bb".repeat(32)], allowedCodeHashes: ["cc".repeat(32)],
    allowedAuthorityHashes: ["dd".repeat(64)], rootPins: ["ee".repeat(32)], instanceIds: ["ff".repeat(32)] } };
  const c = checkAgentConfig(base);
  assert.equal(c.enclaveId, "0xc6a1c08a" + c.enclaveId.slice(10), "the runner id is keccak256 of the endpoint");
  const refuse = (over, re) => assert.throws(() => checkAgentConfig({ ...base, ...over }), re, JSON.stringify(over).slice(0, 80));
  refuse({ chainId: "0x2105" }, /chainId/);
  refuse({ chainId: "08453" }, /chainId/);
  refuse({ addressBook: "0xAB214342d5A490150A4A977063A2f88E21F80907" }, /addressBook must be 0x \+ 40 lowercase/);
  refuse({ addressBook: undefined }, /name an addressBook/);
  refuse({ deployment: "0x11" }, /deployment/);
  refuse({ endpoint: "https://api.enclave.host/x/foo" }, /self-routed/);
  refuse({ operator: "0x" + "00".repeat(20) }, /operator/);
  refuse({ maxFeePerGasWei: undefined }, /fee cap/);
  refuse({ maxFeePerGasWei: "0" }, /fee cap/);
  refuse({ operatorKey: "(a file path in the environment, never here)" }, /unknown key "operatorKey"/);   // a key never belongs in the config
  refuse({ evidence: { ...base.evidence, instanceIds: [] } }, /instanceIds/);
  refuse({ evidence: { ...base.evidence, extra: 1 } }, /evidence must be exactly/);
  refuse({ policy: { vmGapSec: 30 } }, /its own 60 s rate/);
  refuse({ policy: { maxAnchorAgeBlocks: 256 } }, /below 256/);
  refuse({ policy: { confirmations: 0 } }, /confirmations/);
  refuse({ policy: { retries: 9 } }, /unknown policy key/);
});

test("the full path on a local lease: resolve + cross-check, attest, lease, anchor, VM checkpoint verified, simulated, signed locally, journaled, sent, confirmed -- and nothing asked twice",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    agent = await S.agentOf();
    const st = await agent.start();
    assert.equal(st.addresses.proofOfTime, S.chain.addresses.proofOfTime.toLowerCase(), "resolved from the address book");
    assert.equal(st.attested.proofKey, S.vm.proofKey, "the proof key comes from the attested statement");
    assert.equal(st.recovered, null);
    const before = await S.chain.provenUntil(S.D);
    await S.later();
    const a = await agent.tick();
    assert.equal(a.kind, "landed", JSON.stringify(a));
    assert.equal(Number(a.ledgerProvenUntil), await S.chain.provenUntil(S.D));
    assert.ok(Number(a.provenUntil) > before, "provenUntil advanced");
    assert.equal(S.checkpointsAsked(), 1);
    // the journal: signed (simulated) -> tx (raw, BEFORE broadcast) -> done landed, all under one digest
    const j = S.journal(), d = j.find((e) => e.ev === "signed").checkpoint.digest;
    const order = j.filter((e) => (e.digest || (e.checkpoint && e.checkpoint.digest)) === d).map((e) => e.ev + (e.kind ? ":" + e.kind : ""));
    assert.deepEqual(order, ["signed", "tx", "done:landed"]);
    assert.match(j.find((e) => e.ev === "tx").raw, /^0x02/, "an EIP-1559 transaction signed locally");
    assert.equal(pendingFromJournal(j), null);
    // at once again: nothing new to prove in the same chain second, and the VM is not asked
    const b = await agent.tick();
    assert.equal(b.kind, "up-to-date", JSON.stringify(b));
    assert.equal(S.checkpointsAsked(), 1, "the VM was not asked for a proof with nothing to prove");
    // chain time passes but the VM's own 60 s rate has not: the agent paces itself, the VM is not asked
    await S.chain.advance(300);
    const c = await agent.tick();
    assert.equal(c.kind, "vm-rate", JSON.stringify(c));
    assert.equal(S.checkpointsAsked(), 1);
    S.clock.t += 62_000;
    const d2 = await agent.tick();
    assert.equal(d2.kind, "landed", JSON.stringify(d2));
    assert.ok(Number(d2.provenUntil) > Number(a.provenUntil));
    // confirmations: with 3 required, the agent waits (bounded) for blocks after its receipt's block
    agent.close();
    agent = await S.agentOf({ cfg: S.config({ policy: { confirmations: 3, receiptTimeoutMs: 8000, confirmTimeoutMs: 20000, pollMs: 1000 } }) });
    await agent.start();
    await S.later();
    S.clock.mineOnSleep = true;
    const e = await agent.tick();
    S.clock.mineOnSleep = false;
    assert.equal(e.kind, "landed", JSON.stringify(e));
    assert.ok((await S.chain.publicClient.getBlockNumber()) >= BigInt(e.block) + 2n, "landed only after 3 confirmations");
  } finally { if (agent) agent.close(); S.stop(); }
});

test("pins must agree before anything is asked: another chain, another address book entry, another signer, a bound mismatch; one agent per state dir",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  try {
    await assert.rejects(async () => (await S.agentOf({ cfg: S.config({ chainId: "8453" }) })).start(), /serves chain 31337, not the configured 8453/);
    await assert.rejects(async () => (await S.agentOf({ cfg: S.config({ proofOfTime: "0x" + "12".repeat(20) }), stateDir: path.join(S.dir, "s2") })).start(),
                         /config's proofOfTime 0x1212.* is not the address book's/);
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
    await assert.rejects(S.agentOf({ account: privateKeyToAccount(generatePrivateKey()), stateDir: path.join(S.dir, "s3") }), /is not the configured operator/);
    // explicit addresses (no book) that are real contracts but not bound to each other: the prover's own bindings refuse them
    await assert.rejects(async () => (await S.agentOf({ cfg: S.config({ addressBook: undefined, proofOfTime: S.chain.addresses.proofOfTime.toLowerCase(),
      registry: S.chain.addresses.usdc.toLowerCase(), deployments: S.chain.addresses.ledger.toLowerCase() }), stateDir: path.join(S.dir, "s4") })).start(), /reads registry .* not/);
    const a = await S.agentOf({ stateDir: path.join(S.dir, "s5") });
    await assert.rejects(S.agentOf({ stateDir: path.join(S.dir, "s5") }), /holds .*agent\.lock/);
    a.close();
    const b = await S.agentOf({ stateDir: path.join(S.dir, "s5") });   // released: the next agent takes it
    b.close();
    assert.equal(S.checkpointsAsked(), 0);
  } finally { S.stop(); }
});

test("the lease and the key decide whether the VM is asked at all: not our lease, a registered key that is not the attested one, a lapsed lease",
     { skip, timeout: 120000 }, async () => {
  const S = await setup({ register: "0x" + "34".repeat(20) });   // the operator registered a key that is NOT the VM's
  let agent;
  try {
    agent = await S.agentOf();
    await agent.start();
    await S.later();
    const a = await agent.tick();
    assert.equal(a.kind, "proof-key-mismatch", JSON.stringify(a));
    assert.equal(a.attested, S.vm.proofKey);
    assert.equal(S.checkpointsAsked(), 0, "nothing is signed for an entry that publishes another key");
    await S.chain.setProofKey(S.enclaveId, S.vm.proofKey);   // the owner's fix: setProofKey to the attested key
    const b = await agent.tick();
    assert.equal(b.kind, "landed", JSON.stringify(b));
    agent.close();
    // an agent configured for another runner endpoint: the ledger's runner is not ours -> never asks the VM
    const n0 = S.checkpointsAsked();
    agent = await S.agentOf({ cfg: S.config({ endpoint: "https://api.enclave.host/t/another-runner" }), stateDir: path.join(S.dir, "other") });
    const st = await agent.start();
    assert.equal(st.attested, null, "the VM's statement names this lease's runner, not the configured one");
    await S.later();
    const c = await agent.tick();
    assert.equal(c.kind, "not-our-lease", JSON.stringify(c));
    assert.equal(S.checkpointsAsked(), n0);
    agent.close();
    // the lease lapses: nothing more is asked
    agent = await S.agentOf({ stateDir: path.join(S.dir, "lapsed") });
    await agent.start();
    await S.chain.advance(3 * 3600);
    S.clock.t += 62_000;
    const d = await agent.tick();
    assert.equal(d.kind, "lease-ended", JSON.stringify(d));
    assert.equal(S.checkpointsAsked(), n0);
  } finally { if (agent) agent.close(); S.stop(); }
});

test("the registry entry and the deployment must be LIVE: a deregistered entry and an inactive deployment each stop the agent before the VM is asked (the prover checks neither)",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    agent = await S.agentOf();
    await agent.start();
    await S.later();
    assert.equal((await agent.tick()).kind, "landed");
    const n0 = await S.nonceOf(), asked0 = S.checkpointsAsked();
    // the tenant switches the deployment off (the runner and the lease stay on the row)
    await S.chain.setActive(S.D, false); await S.later();
    const a = await agent.tick();
    assert.equal(a.kind, "inactive", JSON.stringify(a));
    await S.chain.setActive(S.D, true); await S.later();
    assert.equal((await agent.tick()).kind, "landed", "switched back on, it proves again");
    const n1 = await S.nonceOf(), asked1 = S.checkpointsAsked();
    // the operator deregisters the entry (its proof key stays published, and the prover would still accept it)
    await S.chain.deregister(S.enclaveId); await S.later();
    const n2 = await S.nonceOf();   // after the operator's own deregister transaction
    assert.equal(n2, n1 + 1);
    const b = await agent.tick();
    assert.equal(b.kind, "registry-mismatch", JSON.stringify(b));
    assert.equal(S.checkpointsAsked(), asked1, "no proof is asked for an inactive entry");
    assert.equal(await S.nonceOf(), n2, "and nothing is sent");
    assert.equal(S.checkpointsAsked() - asked0, 1, "exactly one ask across both refusals: the landing in between");
    assert.equal(n1, n0 + 1);
  } finally { if (agent) agent.close(); S.stop(); }
});

test("the owner's fee cap: a base fee above it means no proof is asked for and nothing is sent", { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    agent = await S.agentOf({ cfg: S.config({ maxFeePerGasWei: "1" }) });
    await agent.start();
    await S.later();
    const n0 = await S.nonceOf();
    const a = await agent.tick();
    assert.equal(a.kind, "fee-cap", JSON.stringify(a));
    assert.match(a.reason, /above the owner's cap 1$/);
    assert.equal(S.checkpointsAsked(), 0, "the VM is not asked for a proof that could not be posted");
    assert.equal(await S.nonceOf(), n0);
  } finally { if (agent) agent.close(); S.stop(); }
});

test("a hostile carrier: a replayed (genuine) checkpoint, another VM's signature, a 503 -- each refused before any chain sees it; the VM refusing is recorded",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent, other;
  try {
    agent = await S.agentOf();
    await agent.start();
    await S.later(100);
    assert.equal((await agent.tick()).kind, "landed");
    const n0 = await S.nonceOf();
    // replay: the carrier returns the previous, genuinely signed checkpoint for a new request
    S.carrier.state.mode = "replay"; await S.later(100);
    const a = await agent.tick();
    assert.equal(a.kind, "checkpoint-refused", JSON.stringify(a));
    assert.match(a.reason, /not the one asked for .*replayed or crossed/);
    // another VM (same pins, another proof key and instance) answers: its signature is refused, and a re-attestation fails at the instance
    S.carrier.state.mode = "honest";
    other = await startFakeVm({ dir: S.dir, ca: S.ca, code: CODE, appId: APP, instance: newInstance(), proofSeed: Buffer.from(sha("another seed"), "hex"), proofPins: S.pins, checkpointEveryMs: 10 });
    S.carrier.state.target = other; await S.later(100);
    const b = await agent.tick();
    assert.equal(b.kind, "checkpoint-refused", JSON.stringify(b));
    assert.match(b.reason, /is signed by 0x[0-9a-f]{40}, not the attested proof key/);
    assert.match(b.reattested, /^failed: .*not one bound/);
    // a replayed STATEMENT (the previous genuine one, for another nonce) when the agent re-attests: refused at the nonce, so a
    // statement for a key the VM may no longer hold can never keep the agent attesting it (the agent's nonce is fresh each time)
    S.carrier.state.target = S.vm; S.carrier.state.mode = "honest";
    assert.equal((await agent.attest()).ok, true, "an honest attestation first (the carrier keeps it)");
    S.carrier.state.mode = "replay-statement"; S.clock.t += 3601_000; await S.later(100);   // past attestEverySec: the tick re-attests
    const asked0 = S.checkpointsAsked();
    const r1 = await agent.tick();
    assert.equal(r1.kind, "attest-failed", JSON.stringify(r1));
    assert.match(r1.reason, /another nonce/);
    assert.equal(S.checkpointsAsked(), asked0, "no proof is asked for on a replayed statement");
    // the anchor swapped: a GENUINE VM signature for the same (upto, anchorBlock) over another anchor hash -- refused before simulate
    S.carrier.state.mode = "honest"; assert.equal((await agent.attest()).ok, true);
    S.carrier.state.mode = "swap-anchor"; await S.later(100);
    const r2 = await agent.tick();
    assert.equal(r2.kind, "checkpoint-refused", JSON.stringify(r2));
    assert.match(r2.reason, /not the one asked for .*replayed or crossed/);
    // the relay refuses: a plain status, no evidence
    S.carrier.state.mode = "503"; await S.later(100);
    const c = await agent.tick();
    assert.ok(["carrier-failed", "attest-failed"].includes(c.kind), JSON.stringify(c));   // the carrier's 503, at whichever request it met first
    assert.match(c.reason, /carrier answered 503/);
    S.carrier.state.mode = "honest";
    // the VM refusing in its own words: its app is not serving
    S.vm.setServing(false); await S.later(100);
    const d = await agent.tick();
    assert.equal(d.kind, "vm-refused", JSON.stringify(d));
    assert.match(d.reason, /not serving/);
    assert.equal(await S.nonceOf(), n0, "no transaction was sent for any refused answer");
    S.vm.setServing(true); await S.later(100);
    assert.equal((await agent.tick()).kind, "landed", "the honest path works again");
  } finally { if (agent) agent.close(); if (other) other.close(); S.stop(); }
});

test("the VM's evidence budget, shared by every caller: its rate refusal is retried promptly, at most twice, each retry journaled -- never taken as an answer; any other error is not retried",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    agent = await S.agentOf();
    const pk = () => S.carrier.state.lines.filter((l) => l.startsWith("PROOFKEY")).length;
    const retries = () => S.journal().filter((e) => e.ev === "rate-retry");
    // two refusals, then the statement: attested on the third try, 2.5 s apart on the agent's clock
    S.carrier.state.rateRefusals = 2; let t0 = S.clock.t, p0 = pk();
    assert.equal((await agent.attest()).ok, true);
    assert.equal(pk() - p0, 3, "exactly three PROOFKEY requests");
    assert.ok(S.clock.t - t0 >= 2 * 2500, `the retries waited (${S.clock.t - t0} ms)`);
    assert.deepEqual(retries().map((e) => [e.request, e.attempt]), [["PROOFKEY", 1], ["PROOFKEY", 2]]);
    // three refusals: the retries run out, and the refusal is journaled as a FAILED attestation -- never a key
    S.carrier.state.rateRefusals = 3; p0 = pk();
    const f = await agent.attest();
    assert.equal(f.ok, false); assert.match(f.reason, /one evidence answer every 2 s/);
    assert.equal(pk() - p0, 3, "no fourth try");
    assert.equal(retries().length, 4);
    const last = S.journal().filter((e) => e.ev === "attest").at(-1);
    assert.equal(last.ok, false); assert.equal(last.proofKey, undefined);
    // a checkpoint refused once for the budget is asked again and lands
    assert.equal((await agent.attest()).ok, true);
    await S.later(100);
    S.carrier.state.rateRefusals = 1; const c0 = S.checkpointsAsked();
    assert.equal((await agent.tick()).kind, "landed");
    assert.equal(S.checkpointsAsked() - c0, 2);
    assert.deepEqual(retries().at(-1) && [retries().at(-1).request, retries().at(-1).attempt], ["CHECKPOINT", 1]);
    // an error that is NOT exactly the payload's budget refusal is judged once, never retried
    S.carrier.state.rateRefusals = 1; S.carrier.state.refusalText = "one evidence answer every 3 s"; p0 = pk(); const r0 = retries().length;
    assert.equal((await agent.attest()).ok, false);
    assert.equal(pk() - p0, 1); assert.equal(retries().length, r0);
    S.carrier.state.refusalText = null;
    // the bound: at most 5 retries, each beyond the VM's own 2 s
    assert.throws(() => checkAgentConfig(S.config({ policy: { rateRetries: 6 } })), /rateRetries is at most 5/);
    assert.throws(() => checkAgentConfig(S.config({ policy: { rateRetries: 1, rateRetryMs: 2000 } })), /2100 ms apart/);
    assert.doesNotThrow(() => checkAgentConfig(S.config({ policy: { rateRetries: 0 } })));
  } finally { if (agent) agent.close(); S.stop(); }
});

test("idempotency: a checkpoint someone else already posted is not paid for twice; a crash after journaling but before broadcast is recovered from the journal",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    // (1) a third party posts the SAME signed checkpoint first (posting is permissionless): simulate says "nothing to prove"
    let frontRun = true;
    const client = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "simulateContract") return async (args) => {
        if (frontRun) { frontRun = false; const [id, enclaveId, upto, anchorBlock, anchorHash, sig] = args.args;
          const r = await S.chain.checkpoint({ id, enclaveId, upto, anchorBlock, anchorHash, sig }); assert.equal(r.ok, true, "the stranger's post landed"); }
        return t.simulateContract(args);
      };
      return t[k];
    } });
    agent = await S.agentOf({ client });
    await agent.start();
    await S.later();
    const n0 = await S.nonceOf();
    const a = await agent.tick();
    assert.equal(a.kind, "already-proven", JSON.stringify(a));
    assert.equal(await S.nonceOf(), n0, "the operator paid nothing for a proof already on chain");
    agent.close();
    // (2) crash window: the raw transaction is journaled, then the broadcast never happens (a node that swallowed it, or a kill)
    let swallow = true, reached = 0, unjournaled = 0;   // counted here and asserted by the test: an assert inside the proxy would be swallowed by the agent's error handling
    const sd = path.join(S.dir, "crash");
    const lossy = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "sendRawTransaction") return async (args) => {
        reached++;
        if (!S.journal(sd).some((e) => e.ev === "tx" && e.hash === S.V.keccak256(args.serializedTransaction))) unjournaled++;
        if (swallow) return "0x" + "00".repeat(32);
        return t.sendRawTransaction(args);
      };
      return t[k];
    } });
    agent = await S.agentOf({ client: lossy, stateDir: sd, cfg: S.config({ policy: { confirmations: 1, receiptTimeoutMs: 4000, confirmTimeoutMs: 4000, pollMs: 1000, maxReplacements: 0 } }) });
    await agent.start();
    await S.later();
    const b = await agent.tick();
    assert.equal(b.kind, "stuck", JSON.stringify(b));
    assert.equal(reached, 1, "the node was reached once");
    assert.equal(unjournaled, 0, "the transaction was journaled BEFORE it reached any node");
    const asked = S.checkpointsAsked();
    agent.close();                                                // the process dies here
    const pend = pendingFromJournal(S.journal(sd));
    assert.ok(pend && pend.txs.length === 1, "the journal names exactly what may be in flight");
    swallow = false;
    agent = await S.agentOf({ stateDir: sd });                    // restart: an honest node
    const st = await agent.start();
    assert.equal(st.recovered.kind, "landed", JSON.stringify(st.recovered));
    assert.equal(st.recovered.hash, pend.txs[0].hash, "the SAME signed bytes were rebroadcast and landed");
    assert.equal(S.checkpointsAsked(), asked, "recovery asked the VM for nothing new");
  } finally { if (agent) agent.close(); S.stop(); }
});

test("a transaction that does not mine is replaced at the same nonce with bumped fees (real mempool replacement), and one landing is all that counts",
     { skip, timeout: 120000 }, async () => {
  const S = await setup();
  let agent;
  try {
    agent = await S.agentOf({ cfg: S.config({ policy: { confirmations: 1, receiptTimeoutMs: 4000, confirmTimeoutMs: 4000, pollMs: 1000, maxReplacements: 3 } }) });
    await agent.start();
    await S.later();
    await S.chain.setAutomine(false);
    let sleeps = 0;
    S.clock.onSleep = async () => { if (++sleeps === 9) { await S.chain.mine(1); } };   // nothing mines until the agent has replaced twice
    const a = await agent.tick();
    S.clock.onSleep = null; await S.chain.setAutomine(true);
    assert.equal(a.kind, "landed", JSON.stringify(a));
    const txs = S.journal().filter((e) => e.ev === "tx");
    assert.ok(txs.length >= 2, `replaced at least once (${txs.length} transactions)`);
    assert.ok(txs.every((t) => t.nonce === txs[0].nonce), "every replacement used the same nonce");
    for (let i = 1; i < txs.length; i++) assert.ok(BigInt(txs[i].maxFeePerGas) * 100n >= BigInt(txs[i - 1].maxFeePerGas) * 125n, "each replacement bid >= 25 % more");
    assert.equal(a.hash, txs.find((t) => t.hash === a.hash).hash);
    const logs = await S.chain.publicClient.getContractEvents({ address: S.chain.addresses.proofOfTime, abi: S.chain.abis.EnclaveProofOfTime.abi, eventName: "Checkpointed", fromBlock: 0n });
    assert.equal(logs.length, 1, "exactly one checkpoint landed");
    assert.equal(await S.nonceOf(), txs[0].nonce + 1);
  } finally { if (agent) agent.close(); S.stop(); }
});

test("a nonce left stuck past its anchor's age is used by a FRESH proof, or cancelled when there is nothing to prove, so it never blocks the operator",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let agent;
  try {
    let swallow = true;   // a node that accepts and never propagates: the nonce looks in flight while blocks pass
    const lossy = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "sendRawTransaction") return async (args) => { if (swallow) return "0x" + "00".repeat(32); return t.sendRawTransaction(args); };
      return t[k];
    } });
    const cfg = S.config({ policy: { confirmations: 1, receiptTimeoutMs: 3000, confirmTimeoutMs: 3000, pollMs: 1000, maxReplacements: 1, maxAnchorAgeBlocks: 20 } });
    agent = await S.agentOf({ client: lossy, cfg });
    await agent.start();
    await S.later();
    const a = await agent.tick();
    assert.equal(a.kind, "stuck", JSON.stringify(a));
    await S.chain.mine(25);   // the anchor ages out
    swallow = false; await S.later();
    const b = await agent.tick();
    assert.equal(b.kind, "landed", JSON.stringify(b));
    assert.equal(b.nonce, a.nonce, "the fresh proof took the stuck nonce");
    const signed = S.journal().filter((e) => e.ev === "signed"), landedDone = S.journal().find((e) => e.ev === "done" && e.kind === "landed");
    assert.notEqual(landedDone.digest, signed[0].checkpoint.digest, "a FRESH proof landed, not the one whose anchor aged out");
    assert.ok(BigInt(signed.find((e) => e.checkpoint.digest === landedDone.digest).checkpoint.anchorBlock) > BigInt(signed[0].checkpoint.anchorBlock));
    const txs = S.journal().filter((e) => e.ev === "tx" && e.nonce === a.nonce);
    assert.ok(BigInt(txs.at(-1).maxFeePerGas) * 100n >= BigInt(txs.at(-2).maxFeePerGas) * 125n, "and outbid what was there");
    // now stuck again, but the lease lapses before the anchor ages out: there is nothing to prove, so the nonce is cancelled
    swallow = true; await S.later();
    const c = await agent.tick();
    assert.equal(c.kind, "stuck", JSON.stringify(c));
    await S.chain.advance(3 * 3600); await S.chain.mine(25);
    swallow = false; S.clock.t += 62_000;
    const d = await agent.tick();
    assert.equal(d.kind, "lease-ended", JSON.stringify(d));
    assert.equal(d.cancel.kind, "cancelled", JSON.stringify(d.cancel));
    assert.equal(await S.nonceOf(), c.nonce + 1, "the nonce is used: the operator's next transaction is not blocked");
  } finally { if (agent) agent.close(); S.stop(); }
});

test("reorganizations: a receipt reorganized away is rebroadcast while its anchor stands; a proof whose ANCHOR was reorganized away is replaced by a fresh one",
     { skip, timeout: 180000 }, async () => {
  const S = await setup();
  let agent;
  try {
    const cfg = S.config({ policy: { confirmations: 3, receiptTimeoutMs: 6000, confirmTimeoutMs: 20000, pollMs: 1000 } });
    // (1) snapshot just before the send; during the confirmation wait, revert to it and build another chain of empty blocks
    let snap = null, reorged = false;
    const client = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "sendRawTransaction") return async (args) => { if (!snap && !reorged) snap = await S.chain.snapshot(); return t.sendRawTransaction(args); };
      return t[k];
    } });
    agent = await S.agentOf({ client, cfg });
    await agent.start();
    await S.later();
    S.clock.onSleep = async () => {
      if (snap && !reorged) { reorged = true; await S.chain.revert(snap); await S.chain.setAutomine(false); await S.chain.dropAll(); await S.chain.mine(2); await S.chain.setAutomine(true); }
      else await S.chain.mine(1);
    };
    const a = await agent.tick();
    S.clock.onSleep = null;
    assert.equal(a.kind, "landed", JSON.stringify(a));
    const j = S.journal(), ro = j.find((e) => e.ev === "reorg");
    assert.ok(ro, "the reorganization was noticed");
    assert.notEqual(ro.was, a.blockHash, "it landed in another block than the one reorganized away");
    assert.equal(ro.hash, a.hash, "the same signed bytes landed again");
    agent.close();
    // (2) the anchor itself is reorganized away: snapshot BEFORE the anchor block exists
    const sd = path.join(S.dir, "reorg2");
    snap = await S.chain.snapshot(); reorged = false;
    await S.chain.mine(2);
    const holder = { snap };
    const client2 = new Proxy(S.chain.publicClient, { get(t, k) {
      if (k === "sendRawTransaction") return async (args) => {
        const h = await t.sendRawTransaction(args);
        if (holder.snap) { const s0 = holder.snap; holder.snap = null; await S.chain.revert(s0); await S.chain.setAutomine(false); await S.chain.dropAll(); await S.chain.mine(4); await S.chain.setAutomine(true); }
        return h;
      };
      return t[k];
    } });
    agent = await S.agentOf({ client: client2, stateDir: sd, cfg: S.config({ policy: { confirmations: 2, receiptTimeoutMs: 4000, confirmTimeoutMs: 8000, pollMs: 1000, maxReplacements: 0 } }) });
    await agent.start();
    await S.later();
    S.clock.mineOnSleep = true;
    const b = await agent.tick();
    assert.ok(["stuck", "reorged-out", "nonce-consumed"].includes(b.kind), JSON.stringify(b));
    if (b.kind === "stuck") assert.equal(b.fresh, true, "a proof whose anchor is gone can only be replaced by a fresh one");
    await S.later(900);   // evm_revert also rewinds chain time: move past the upto the VM already signed
    const c = await agent.tick();
    S.clock.mineOnSleep = false;
    assert.equal(c.kind, "landed", JSON.stringify(c));
  } finally { if (agent) agent.close(); S.stop(); }
});

test("the CLI: secrets only from a 0600 key file and the environment, refusals before anything runs, and one real --once tick on the local lease",
     { skip, timeout: 120000 }, async () => {
  const { spawnSync, spawn } = await import("node:child_process");
  const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "../shielded/anchor/avf/runner/proof-agent-cli.mjs");
  const S = await setup();
  try {
    const cfgFile = path.join(S.dir, "agent.json"); fs.writeFileSync(cfgFile, JSON.stringify(S.config({ policy: { confirmations: 1 } })));
    const keyFile = path.join(S.dir, "operator.key");
    const { generatePrivateKey } = await import("viem/accounts");
    const run = (env, args = ["--config", cfgFile, "--state", path.join(S.dir, "cli-state"), "--once"]) =>
      spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60000 });
    const refused = (env, re, what, args) => { const r = run(env, args); assert.equal(r.status, 2, `${what}: ${r.stderr}${r.stdout}`); assert.match(r.stderr, re, what); };
    refused({}, /PROOF_AGENT_RPC/, "no RPC");
    refused({ PROOF_AGENT_RPC: S.chain.rpc }, /OPERATOR_KEY_FILE must name/, "no key file");
    fs.writeFileSync(keyFile, generatePrivateKey() + "\n", { mode: 0o644 }); fs.chmodSync(keyFile, 0o644);
    refused({ PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: keyFile }, /readable by others \(mode 644\)/, "a group/world-readable key");
    fs.chmodSync(keyFile, 0o600);
    refused({ PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: keyFile }, /is not the configured operator/, "a key that is not the operator's");
    refused({ PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: keyFile }, /usage/, "no state dir", ["--config", cfgFile]);
    fs.writeFileSync(path.join(S.dir, "bad.json"), JSON.stringify({ ...S.config(), operatorKey: "x" }));
    refused({ PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: keyFile }, /unknown key "operatorKey"/, "a key in the config", ["--config", path.join(S.dir, "bad.json"), "--state", path.join(S.dir, "x")]);
    // the real operator key (a fresh test key: this test's own), in a 0600 file; one tick lands a proof
    const opKey = path.join(S.dir, "op.key"); fs.writeFileSync(opKey, S.operatorKeyHex + "\n", { mode: 0o600 });
    await S.chain.advance(300);
    const child = spawn(process.execPath, [CLI, "--config", cfgFile, "--state", path.join(S.dir, "cli-state"), "--once"],
                        { env: { PATH: process.env.PATH, PROOF_AGENT_RPC: S.chain.rpc, OPERATOR_KEY_FILE: opKey }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, err + out);
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.ev === "started" && l.proofKey === S.vm.proofKey), "started, with the attested key");
    assert.ok(lines.some((l) => l.ev === "done" && l.kind === "landed"), out);
    assert.ok(!out.includes(S.operatorKeyHex.slice(2)) && !err.includes(S.operatorKeyHex.slice(2)), "the key never appears in the output");
    assert.ok(!fs.readFileSync(path.join(S.dir, "cli-state", "journal.jsonl"), "utf8").includes(S.operatorKeyHex.slice(2)), "nor in the journal");
    assert.equal(fs.existsSync(path.join(S.dir, "cli-state", "agent.lock")), false, "the lock was released on exit");
  } finally { S.stop(); }
});
