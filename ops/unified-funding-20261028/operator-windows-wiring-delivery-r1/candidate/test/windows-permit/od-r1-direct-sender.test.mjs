// durability r1 (AUTHORED, NOT RUN). The ACTUAL chain.mjs serialized direct sender over the ACTUAL owned operator-effects store
// (Linux backend: genuine /usr/bin/flock owner + owned-durable-state files in a private temp dir). Carries both root r12
// durable-gaps FAILs (evidence/root-r12/root-durable-gaps.test.mjs tests 4 and 5) in meaning; that file stays unchanged executed
// evidence and targets the removed r12 JSON format. TEST, labelled: the public TEST account (no signer), inert viem RPC/wallet doubles
// (nothing signed, broadcast or paid). A fresh module instance after releaseOperatorEffects models a process restart (module memory
// lost, owner released as at process death); it is NOT an OS crash or power loss. Every global/env mutation is restored after the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { initializeOperatorEffects } from "../../control/windows/node/operator-effects.mjs";

const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const url = new URL("../../control/windows/node/chain.mjs", import.meta.url);
const S = { writes: [], nonce: 0, mined: 0, writeError: false, receipts: new Map() };
globalThis.__odR1Direct = S;
const modules = {
  viem: `const s=globalThis.__odR1Direct;
  export const createPublicClient=()=>({simulateContract:async()=>{},getTransactionCount:async({blockTag})=>blockTag==='latest'?s.mined:s.nonce,
    waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async({hash})=>s.receipts.get(hash)??null});
  export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push([o.functionName,o.nonce]);if(s.writeError)throw Error('TEST broadcast response lost');return '0x'+'ab'.repeat(32);}});
  export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": "export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no signer'});",
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
  "./lease-gas-runtime.bundle.mjs": "export const leaseGasConfigured=()=>false,loadLeaseGasConfig=()=>{throw Error('TEST no sponsored path');},configuredLeaseSender=()=>{throw Error('TEST no sponsored path');},openReleaseJournal=()=>null;",
};
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL?.split("?")[0] !== url.href || !Object.hasOwn(modules, spec)) return next(spec, ctx);
  return { url: "data:text/javascript;base64," + Buffer.from(modules[spec]).toString("base64"), shortCircuit: true };
} });
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r1-direct-"));
const saved = { key: process.env.NODE_OPERATOR_KEY, fx: process.env.ENCLAVE_OPERATOR_EFFECTS };
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__odR1Direct;
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  if (saved.fx === undefined) delete process.env.ENCLAVE_OPERATOR_EFFECTS; else process.env.ENCLAVE_OPERATOR_EFFECTS = saved.fx;
  fs.rmSync(dir, { recursive: true, force: true });
});
const ACCOUNT = "0x" + "11".repeat(20), dep = "0x" + "22".repeat(32);
let serial = 0;
async function instance(file, options = {}) {
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try {
    const m = await import(`${url.href}?od-r1-${++serial}`);
    m.loadOperator(); m.addresses.deployments = "0x" + "44".repeat(20);
    if (file) m.setOperatorEffects(file, options);
    live.add(m); return m;
  } finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
}
const restart = async (m) => { await m.releaseOperatorEffects("TEST process restart"); live.delete(m); };
async function established(name, account = ACCOUNT) { const file = path.join(dir, name); await initializeOperatorEffects(file, { domain: { account, chainId: 8453 } }); return file; }
const reset = (o) => Object.assign(S, { writes: [], writeError: false, receipts: new Map() }, o);
const opts = { skip: !flock && "needs Linux /usr/bin/flock (genuine owner)" };

test("od-r1: no configured store -> no write (fail closed)", opts, async () => {
  delete process.env.ENCLAVE_OPERATOR_EFFECTS; reset({ nonce: 0, mined: 0 });
  const c = await instance(null);
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.code === "NoOperatorEffects");
  assert.deepEqual(S.writes, []);
});

test("od-r1: a configured but never-initialized store is NOT first use: refused, nothing created, no write", opts, async () => {
  reset({ nonce: 0, mined: 0 });
  const file = path.join(dir, "never-initialized.journal");
  const c = await instance(file);
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.pending === true);
  assert.deepEqual(S.writes, []);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + ".established"), false);
  assert.match(c.operatorEffectsStatus().ownership, /refused/);
});

test("od-r1: uncertain write -> same module refuses; a SECOND owner is refused; fresh process after restart refuses; mined fence -> new nonce", opts, async () => {
  const file = await established("restart.journal");
  reset({ nonce: 12, mined: 12, writeError: true });
  const first = await instance(file);
  await assert.rejects(first.renewDeployment(dep, { gate: () => null }), (e) => e.unknownOutcome === true && e.nonce === 12 && e.pending === true);
  assert.deepEqual(S.writes, [["renew", 12]]);
  await assert.rejects(first.renewDeployment(dep, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite" && e.notSent === true);
  S.writeError = false;
  const second = await instance(file);   // another module/process-owner while the first still holds the store
  await assert.rejects(second.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && /owner lock unavailable|in use/.test(e.message));
  assert.deepEqual(S.writes, [["renew", 12]], "the second owner neither loaded, overwrote, settled nor sent");
  await restart(first); live.delete(second);
  const cold = await instance(file);
  await assert.rejects(cold.renewDeployment(dep, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite" && e.notSent === true);
  assert.deepEqual(S.writes, [["renew", 12]], "unchanged pending count is not absence: the restarted sender sent nothing");
  const rec = cold.ambiguousOperatorWrite();
  assert.equal(rec.nonce, 12); assert.equal(rec.functionName, "renew");
  assert.deepEqual(JSON.parse(rec.request).args, [dep], "the COMPLETE request is recorded, never truncated");
  S.mined = 13; S.nonce = 13;   // nonce 12 mined (ours or another's): a FENCE, not proof of success
  await cold.renewDeployment(dep, { gate: () => null });
  assert.deepEqual(S.writes, [["renew", 12], ["renew", 13]], "never the recorded nonce again, never a replacement");
  assert.equal(cold.ambiguousOperatorWrite(), null);
  await restart(cold);
});

test("od-r1 ROOT gap 1: an established store DELETED after an uncertain write -> a fresh process refuses; no second write", opts, async () => {
  const file = await established("deleted.journal");
  reset({ nonce: 20, mined: 20, writeError: true });
  const first = await instance(file);
  await assert.rejects(first.renewDeployment(dep, { gate: () => null }), (e) => e.unknownOutcome === true);
  assert.equal(S.writes.length, 1);
  await restart(first);
  fs.unlinkSync(file); S.writeError = false;
  const cold = await instance(file);
  const outcome = await cold.renewDeployment(dep, { gate: () => null }).then(() => null, (e) => e);
  assert.equal(S.writes.length, 1, "missing established obligations cannot authorize a second inert write");
  assert.ok(outcome?.notSent && outcome.pending);
  assert.equal(fs.existsSync(file), false, "never re-created as empty by a normal open");
});

test("od-r1 ROOT gap 2: final post-persist refusal -> 0 writes, exact discharge (durable), later unchanged-permission positive at the SAME nonce", opts, async () => {
  const file = await established("unsent.journal");
  reset({ nonce: 15, mined: 15 });
  const c = await instance(file);
  // refuses exactly when this attempt's own "sending" record exists (i.e. after it was persisted, before the wallet call)
  const gate = () => { try { return c.ambiguousOperatorWrite() ? "TEST refusal after intent persisted" : null; } catch { return null; } };
  await assert.rejects(c.renewDeployment(dep, { gate }), (e) => e.notSent === true && e.superseded === true && !e.unsentRetained && !e.unknownOutcome);
  assert.deepEqual(S.writes, []);
  assert.equal(c.ambiguousOperatorWrite(), null, "the provably unsent attempt does not wait for a nonce it never broadcast");
  await restart(c);
  const cold = await instance(file);
  await cold.renewDeployment(dep, { gate: () => null });
  assert.deepEqual(S.writes, [["renew", 15]], "no nonce was spent by the refused attempt; no replacement/cancellation/new-nonce workaround");
  await restart(cold);
});

test("od-r1: a later refused attempt never discharges an earlier unresolved write (discharge is exact to its own attempt)", opts, async () => {
  const file = await established("earlier.journal");
  reset({ nonce: 30, mined: 30, writeError: true });
  const c = await instance(file);
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.unknownOutcome === true);
  S.writeError = false; S.nonce = 31;   // pending count moved, mined did not: still unresolved
  await assert.rejects(c.renewDeployment(dep, { gate: () => "TEST refused" }), (e) => e.notSent === true);
  assert.equal(c.ambiguousOperatorWrite().nonce, 30, "the earlier effect is preserved");
  assert.deepEqual(S.writes, [["renew", 30]]);
  await restart(c);
});

test("od-r1: owner loss (lock file replaced) latches refusal; the recorded obligation stays on disk", opts, async () => {
  const file = await established("lost.journal");
  reset({ nonce: 40, mined: 40, writeError: true });
  const c = await instance(file);
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.unknownOutcome === true);
  fs.unlinkSync(file + ".lock"); fs.writeFileSync(file + ".lock", "");   // TEST external replacement of the lock inode
  S.writeError = false; S.mined = 41; S.nonce = 41;
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.pending === true);
  assert.deepEqual(S.writes, [["renew", 40]], "a lost owner settles nothing and sends nothing");
  assert.match(fs.readFileSync(file, "utf8"), /"w:40"/, "the obligation is retained for the next owner");
  live.delete(c);
});

test("od-r1: a foreign-domain store and a storage failure before the effect leave no unauthorized write", opts, async () => {
  const foreign = await established("foreign.journal", "0x" + "99".repeat(20));
  reset({ nonce: 50, mined: 50 });
  const c = await instance(foreign);
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && /not this operator domain|another operator/.test(e.message));
  assert.deepEqual(S.writes, []);
  live.delete(c);
  // fsync failure while persisting the intent (TEST fs wrapper: the primitive's fsImpl injection point): nothing sent; the store latches
  const file = await established("fsync.journal");
  const F = { after: null };
  const testFs = { ...fs, fsyncSync: (fd) => { if (F.after !== null && F.after-- <= 0) throw Object.assign(Error("TEST EIO"), { code: "EIO" }); return fs.fsyncSync(fd); } };
  const d = await instance(file, { fsImpl: testFs });
  await d.renewDeployment(dep, { gate: () => null });   // opens the owner; positive control
  assert.deepEqual(S.writes, [["renew", 50]]);
  S.nonce = 51; S.mined = 51; F.after = 2;
  await assert.rejects(d.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.pending === true && e.code === "OperatorEffectsUncertain");
  F.after = null;
  await assert.rejects(d.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true);
  assert.deepEqual(S.writes, [["renew", 50]], "no write after an uncertain persistence");
  await restart(d);
  const cold = await instance(file);
  await assert.rejects(cold.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true, "uncertain state refuses after restart until explicit owned recovery");
  assert.deepEqual(S.writes, [["renew", 50]]);
});
