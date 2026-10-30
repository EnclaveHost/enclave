// permit r11 (AUTHORED, NOT RUN). Actual protected-supervisor policy predicates and actual chain.mjs serialized direct sender + sponsored
// leaseSend wrappers. TEST public account, inert RPC/wallet doubles, TEST lease-client emulator (labelled below); no network, signing,
// relay, transaction or funds. Carries the root r10 failing cases (root-policy-refresh / root-chain-send-boundary) in meaning.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { ENROLLMENT_SCHEMA, enrolledByPolicy, enrollmentState, establishedEnrolledDeployments, policyNewWorkRefusal,
  TEST_resetProtectedComposition } from "../../control/windows/node/protected-supervisor.mjs";

const H = (b) => "0x" + b.repeat(32);
const ID = H("aa"), NEIGHBOR = H("bb");
function policyFixture(t) {
  TEST_resetProtectedComposition();
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "r11-policy-"));
  const file = path.join(dir, "policy.json");
  const bytes = Buffer.from(JSON.stringify({ schema: ENROLLMENT_SCHEMA, host: H("cc"), manager: "http://127.0.0.1:41", controlKeyFile: path.join(dir, "TEST-key"), deployments: [ID], stagingMs: 30000 }));
  fs.writeFileSync(file, bytes);
  const env = { ENCLAVE_PROTECTED_ENROLLMENT: file, ENCLAVE_PROTECTED_ENROLLMENT_SHA256: createHash("sha256").update(bytes).digest("hex") };
  t.after(() => { TEST_resetProtectedComposition(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(enrolledByPolicy(ID, env), true); assert.equal(enrolledByPolicy(NEIGHBOR, env), false); assert.equal(enrollmentState(env), "valid");
  return { file, env, bytes };
}

// ---- dynamic policy validity ------------------------------------------------------------------------------------------------------------
test("r11 policy: unchanged valid policy keeps the unenrolled neighbour usable on every call", (t) => {
  const { env } = policyFixture(t);
  for (let i = 0; i < 3; i++) assert.equal(enrolledByPolicy(NEIGHBOR, env), false);
  assert.equal(policyNewWorkRefusal(env), null);
});
test("r11 policy (root r10 FAIL carried): corruption after the first successful read is unknown at the final predicate", (t) => {
  const { file, env } = policyFixture(t);
  fs.writeFileSync(file, "{}");
  assert.equal(enrolledByPolicy(NEIGHBOR, env), undefined);
  assert.equal(enrollmentState(env), "unknown");
  assert.match(policyNewWorkRefusal(env), /unreadable/);
  assert.deepEqual(establishedEnrolledDeployments(), [ID], "the established enrollment stays known for withdrawal/cold recovery");
});
test("r11 policy (root r10 FAIL carried): a missing policy after the first read is unknown", (t) => {
  const { file, env } = policyFixture(t);
  fs.unlinkSync(file);
  assert.equal(enrollmentState(env), "unknown");
  assert.equal(enrolledByPolicy(ID, env), undefined);
});
test("r11 policy: a changed configured path/sha after establishment is unknown, even with a valid new file", (t) => {
  const { file, env, bytes } = policyFixture(t);
  const other = file + ".2"; fs.writeFileSync(other, bytes);
  assert.equal(enrollmentState({ ...env, ENCLAVE_PROTECTED_ENROLLMENT: other }), "unknown");
  assert.equal(enrolledByPolicy(NEIGHBOR, { ...env, ENCLAVE_PROTECTED_ENROLLMENT: other }), undefined);
  assert.equal(enrollmentState(env), "valid", "the established configuration itself is still valid");
});
test("r11 policy: previous no-policy state does not authorize legacy once a policy is configured", (t) => {
  const { env } = policyFixture(t);
  TEST_resetProtectedComposition();
  assert.equal(enrollmentState({}), "none"); assert.equal(enrolledByPolicy(ID, {}), false);
  assert.equal(enrolledByPolicy(ID, env), undefined, "none -> configured is a change: unknown, never legacy");
  assert.equal(enrollmentState(env), "unknown");
});
test("r11 policy POSITIVE control: initially corrupt policy refuses (root r10 PASS carried)", (t) => {
  const { file, env } = policyFixture(t);
  fs.writeFileSync(file, "{}"); TEST_resetProtectedComposition();
  assert.equal(enrolledByPolicy(NEIGHBOR, env), undefined); assert.equal(enrollmentState(env), "unknown");
});

// ---- actual chain.mjs: inert TEST viem + TEST lease-client emulator ---------------------------------------------------------------------
const url = new URL("../../control/windows/node/chain.mjs", import.meta.url);
const S = globalThis.__r11Send = { writes: [], writeImpl: null, simulate: async () => {}, pending: 0, latest: 0, sponsored: false, client: null, journal: null };
const modules = {
  viem: `const s=globalThis.__r11Send;
 export const createPublicClient=()=>({simulateContract:(o)=>s.simulate(o),getTransactionCount:async({blockTag})=>blockTag==='latest'?s.latest:s.pending,waitForTransactionReceipt:async()=>({status:'success'})});
 export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push([o.functionName,o.nonce]);if(s.writeImpl)return s.writeImpl(o);return '0x'+'ab'.repeat(32);}});
 export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": `export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account',
 signTypedData:async(x)=>{const s=globalThis.__r11Send;s.signs=(s.signs||0)+1;if(s.duringSign)s.duringSign();return '0xTESTsig'+s.signs;},
 signAuthorization:async()=>({TEST:'authorization'})});`,
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
  // TEST lease-client emulator (NOT the shipped bundle): the reference createLeaseClient run() order per relay (lease-executor-client.mjs
  // 788-822): authorize -> signTypedData -> onSigned -> POST, a failed relay moves to the next one. It uses ONLY the account/fetchImpl
  // chain.mjs hands configuredLeaseSender (the shipped bundle forwards both: ...s, account:t). Root: rerun with the actual bundle.
  "./lease-gas-runtime.bundle.mjs": `const s=globalThis.__r11Send;
 export const leaseGasConfigured=()=>s.sponsored,loadLeaseGasConfig=()=>({TEST:true});
 export const openReleaseJournal=()=>s.journal;
 export const configuredLeaseSender=({account,fetchImpl,onSigned})=>{s.client={account,fetchImpl};
  const run=async(kind,id)=>{const errors=[];
   for(const relay of s.relays){try{
     await account.signAuthorization({});
     const signature=await account.signTypedData({message:{id,kind,relay}});
     if(onSigned)await onSigned({nonce:1n,deadline:9n,payee:relay,kind,lease:{id},fromBlock:1n,operator:account.address,reserve:'r',executor:'x',chainId:8453,ledger:'l'});
     const ans=await fetchImpl(relay+'/v1/lease',{method:'POST',body:JSON.stringify({signature})});
     if(ans&&ans.ok)return {hash:'0x'+'cd'.repeat(32),receipt:{status:'success'}};
     errors.push(relay);
   }catch(e){errors.push(String(e.message));}}
   const e=Error('NotRelayed: '+errors.join('; '));e.code='NotRelayed';throw e;};
  return {claim:(id)=>run('claim',id),renew:(id)=>run('renew',id),release:(id)=>run('release',id),renewLeadMs:async(i,f)=>f,resolveSigned:async()=>({state:'pending'})};};`,
};
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL !== url.href || !Object.hasOwn(modules, spec)) return next(spec, ctx);
  return { url: "data:text/javascript;base64," + Buffer.from(modules[spec]).toString("base64"), shortCircuit: true };
} });
test.after(() => { hooks.deregister(); delete globalThis.__r11Send; });
const prior = process.env.NODE_OPERATOR_KEY; process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
const chain = await import(url.href); chain.loadOperator();
if (prior === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = prior;
const DEP = H("22"), HOST = H("33");
chain.addresses.deployments = "0x" + "44".repeat(20);
const direct = () => Object.assign(S, { sponsored: false, writes: [], writeImpl: null, simulate: async () => {}, pending: 5, latest: 5 });

test("r11 direct (root r10 FAIL carried): claim and release carry the caller gate into the actual sender", async () => {
  direct();
  await assert.rejects(chain.claimDeployment(DEP, HOST, { gate: () => "TEST policy unknown" }), (e) => e.notSent === true && e.superseded === true);
  await assert.rejects(chain.releaseDeployment(DEP, { gate: () => "TEST policy unknown" }), (e) => e.notSent === true);
  assert.deepEqual(S.writes, []);
});
test("r11 direct (root r10 FAIL carried): permission ending during simulation sends nothing", async () => {
  direct(); let allowed = true;
  S.simulate = async () => { await Promise.resolve(); allowed = false; };
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST changed during simulation") }), /not sent/);
  assert.deepEqual(S.writes, []);
});
test("r11 direct: permission ending during the nonce read sends nothing and spends no nonce", async () => {
  direct(); let allowed = true, reads = 0;
  const gate = () => (allowed ? null : "TEST ownership revoked during nonce read");
  S.simulate = async () => {};
  Object.defineProperty(S, "pending", { configurable: true, get() { reads++; allowed = false; return 5; } });
  await assert.rejects(chain.releaseDeployment(DEP, { gate }), /not sent/);
  delete S.pending; S.pending = 5;
  assert.equal(reads, 1); assert.deepEqual(S.writes, []);
  await chain.renewDeployment(DEP, { gate: () => null });
  assert.deepEqual(S.writes, [["renew", 5]], "the refused request advanced no nonce bookkeeping");
});
test("r11 direct: a pre-write transient retry is a new decision point (gate re-asked after the backoff)", async () => {
  direct(); let allowed = true, sims = 0;
  S.simulate = async () => { if (++sims === 1) { allowed = false; throw Object.assign(Error("missing or invalid parameters"), { shortMessage: "missing or invalid parameters" }); } };
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST withdrawn during backoff") }), /not sent/);
  assert.equal(sims, 1); assert.deepEqual(S.writes, []);
});
test("r11 direct: an ambiguous post-write error is never resent, never given a new nonce, and blocks later sends until mined", async () => {
  direct(); S.pending = 7; S.latest = 7;
  S.writeImpl = () => { throw Object.assign(Error("already known"), { shortMessage: "already known" }); };
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => null }), (e) => e.unknownOutcome === true && e.nonce === 7 && e.pending === true);
  assert.deepEqual(S.writes, [["renew", 7]], "exactly one write, no retry");
  assert.equal(chain.ambiguousOperatorWrite().nonce, 7);
  S.writeImpl = null;
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite" && e.notSent === true);
  assert.deepEqual(S.writes, [["renew", 7]], "no duplicate/new-nonce/replacement send while unresolved");
  S.latest = 8; S.pending = 8;   // the chain mined nonce 7 (whichever transaction): settled from the chain
  await chain.renewDeployment(DEP, { gate: () => null });
  assert.deepEqual(S.writes, [["renew", 7], ["renew", 8]]);
  assert.equal(chain.ambiguousOperatorWrite(), null);
});
test("r11 direct POSITIVE: an unchanged permission sends exactly once", async () => {
  direct(); S.pending = 9; S.latest = 9;
  const hash = await chain.claimDeployment(DEP, HOST, { gate: () => null });
  assert.equal(hash, "0x" + "ab".repeat(32)); assert.deepEqual(S.writes, [["claim", 9]]);
});

// ---- sponsored (app-funded) path through the gated account/fetch ------------------------------------------------------------------------
function journal() {
  const rows = new Map();
  return { rows, corrupt: () => false, hold: (id) => (rows.has(id) ? "TEST release pending" : null),
    begin: (id) => rows.set(id, { id, intents: [], settled: null }), signed: (id, s) => rows.get(id).intents.push(s),
    settle: (id, outcome) => { rows.get(id).settled = outcome; rows.delete(id); }, pending: () => [...rows.values()] };
}
function sponsored(relays = ["https://relay-a.TEST", "https://relay-b.TEST"]) {
  Object.assign(S, { sponsored: true, writes: [], relays, signs: 0, duringSign: null, posts: [], journal: journal() });
  chain.setLeaseJournal("/TEST/unused");   // TEST openReleaseJournal returns the in-memory journal above
  chain.setLeaseRelayPolicy(null);
  globalThis.fetch = async (u, init) => { S.posts.push(u); return { ok: S.postOk ?? true, status: S.postOk === false ? 502 : 200, json: async () => ({}) }; };
  chain.withheldLeaseSignatures.length = 0;
}
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test("r11 sponsored: permission ending DURING the lease signature keeps the signature and POSTs to no relay", async () => {
  sponsored(); let allowed = true; S.duringSign = () => { allowed = false; };
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST owner revoked during signing") }),
    (e) => e.superseded === true && e.notSent === true && e.signedWithheld === true);
  assert.equal(S.signs, 1, "no next-relay signature after the refusal"); assert.deepEqual(S.posts, []);
  assert.equal(chain.withheldLeaseSignatures.length, 1);
});
test("r11 sponsored release: a signature made while permission ended is journaled before the refused POST and stays pending", async () => {
  sponsored(); let allowed = true; S.duringSign = () => { allowed = false; };
  await assert.rejects(chain.releaseDeployment(DEP, { gate: () => (allowed ? null : "TEST policy corrupt during signing") }), (e) => e.pending === true && e.notSent === true);
  assert.deepEqual(S.posts, []);
  const row = S.journal.rows.get(DEP.toLowerCase());
  assert.ok(row && row.intents.length === 1 && row.settled === null, "never settled unsent while a signed lease exists");
});
test("r11 sponsored: refusal after an earlier relay's POST reports an unknown outcome, not unsent", async () => {
  sponsored(); S.postOk = false; let allowed = true;
  globalThis.fetch = async (u) => { S.posts.push(u); allowed = false; return { ok: false, status: 502, json: async () => ({}) }; };
  await assert.rejects(chain.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST withdrawn after relay A") }),
    (e) => e.unknownOutcome === true && e.pending === true && e.notSent === false);
  assert.equal(S.posts.length, 1, "relay B is never signed for or contacted"); assert.equal(S.signs, 1);
  S.postOk = undefined;
});
test("r11 sponsored: queue-entry refusal signs nothing (claim)", async () => {
  sponsored();
  await assert.rejects(chain.claimDeployment(DEP, HOST, { gate: () => "TEST unknown policy" }), (e) => e.notSent === true);
  assert.equal(S.signs, 0); assert.deepEqual(S.posts, []);
});
test("r11 sponsored POSITIVE: unchanged permission signs once, POSTs once and lands", async () => {
  sponsored();
  const hash = await chain.renewDeployment(DEP, { gate: () => null });
  assert.equal(hash, "0x" + "cd".repeat(32)); assert.equal(S.signs, 1); assert.equal(S.posts.length, 1);
  assert.deepEqual(S.writes, [], "never the operator-paid sender");
});
