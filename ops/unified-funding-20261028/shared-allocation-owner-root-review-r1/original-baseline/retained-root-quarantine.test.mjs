// durability r2 (AUTHORED, NOT RUN). REQUIRED ACTUAL SHIPPED-CLIENT FIXTURE: the actual chain.mjs -> configuredLeaseSender of the EXACT
// shipped control/windows/node/lease-gas-runtime.bundle.mjs (sha256 159108d1..., byte-identical, NOT hooked, NOT wrapped) -> its real
// lease client (settled authority, policy/quote reads, per-relay /v1/info, authorization, typed-data lease, onSigned, POST, receipt
// verification, findLanded, resolveSigned) -> the ACTUAL owned operator-effects store (Linux backend, genuine /usr/bin/flock).
// Injected EXTERNAL inputs only: the reviewed deployment record + digest (ENCLAVE_LEASE_GAS_* environment, as an installer sets it),
// globalThis.fetch = the in-memory TEST RPC/relay dispatcher (helpers/od-r2-inert-chain.mjs; every non-TEST URL refused: NO LIVE
// NETWORK), chain.mjs's OWN viem imports = an inert TEST account (deterministic 65-byte signature bytes, an inert authorization object;
// no key, nothing verifiable) and inert TEST public/wallet clients for the operator-paid direct path, and a filesystem wrapper that
// triggers a TEST revocation/loss DURING the store's own write. chain.mjs's unrelated ./host-admission.bundle.mjs, ./waf.mjs and
// ./verification-checkpoints.mjs are stubbed as in root boundary-v2. Nothing is signed with a real key, relayed, broadcast or paid.
// The bundle module instance is shared by the fresh chain.mjs instances of one file (a "restart" = owner release + a fresh chain.mjs
// with lost module memory; not an OS crash). Version caveat: the in-memory chain follows the READONLY REFERENCE client (sha 21fece1f...,
// a newer build); if the shipped client asks for something it lacks, that is a fixture gap to adapt in the helper, not a product result.
// Root runs this in isolation; it needs the npm "viem" package (helper only) and Node's global Response.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { initializeOperatorEffects } from "./candidate/control/windows/node/operator-effects.mjs";
import { createInertChain } from "./candidate/test/windows-permit/helpers/od-r2-inert-chain.mjs";

const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const url = new URL("./candidate/control/windows/node/chain.mjs", import.meta.url);
const S = globalThis.__odR2Shipped = { chain: null, writes: [], writeError: false, signs: { auth: 0, typed: 0 }, pendingExtra: 0, headTs: 0n };
const modules = {
  viem: `const s=globalThis.__odR2Shipped;
  export const createPublicClient=()=>({simulateContract:async()=>{},getTransactionCount:async({blockTag})=>blockTag==='latest'?s.chain.S.accountNonce:s.chain.S.accountNonce+s.pendingExtra,
    waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async()=>null,getBlock:async()=>({timestamp:s.headTs})});
  export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push([o.functionName,o.nonce]);if(s.writeError)throw Error('TEST broadcast response lost');s.chain.S.accountNonce=o.nonce+1;return '0x'+'ab'.repeat(32);}});
  export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": `export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no key',
  signTypedData:async()=>{const s=globalThis.__odR2Shipped;s.signs.typed++;return '0x'+'ee'.repeat(64)+s.signs.typed.toString(16).padStart(2,'0');},
  signAuthorization:async(x)=>{const s=globalThis.__odR2Shipped;s.signs.auth++;return {address:x.contractAddress,contractAddress:x.contractAddress,chainId:x.chainId,nonce:x.nonce,r:'0x'+'01'.repeat(32),s:'0x'+'02'.repeat(32),yParity:0,TEST:'inert authorization'};}});`,
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
};   // NOTE: "./lease-gas-runtime.bundle.mjs" is deliberately ABSENT: the shipped bundle loads unmodified
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL?.split("?")[0] !== url.href || !Object.hasOwn(modules, spec)) return next(spec, ctx);
  return { url: "data:text/javascript;base64," + Buffer.from(modules[spec]).toString("base64"), shortCircuit: true };
} });
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r2-shipped-"));
const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
globalThis.fetch = (u, i) => (S.chain ? S.chain.fetch(u, i) : Promise.reject(Error("TEST: no live network")));
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__odR2Shipped; globalThis.fetch = savedFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});
const ACCOUNT = "0x" + "11".repeat(20), OWNER = "0x" + "0e".repeat(20), DEP = "0x" + "22".repeat(32), DEP2 = "0x" + "24".repeat(32), HOST = "0x" + "33".repeat(32);
const RELAY_A = "https://relay-a.od-r2.test", RELAY_B = "https://relay-b.od-r2.test";
let serial = 0;
async function instance(file, options = {}) {
  for (const k of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(k)) delete process.env[k];
  Object.assign(process.env, S.chain.env, { NODE_OPERATOR_KEY: "0x" + "11".repeat(32) });   // read by chain.mjs at import / loadOperator
  const m = await import(`${url.href}?od-r2-shipped-${++serial}`);
  m.loadOperator(); m.addresses.deployments = S.chain.A.ledger; m.addresses.registry = S.chain.A.registry;
  m.setOperatorEffects(file, options); m.setLeaseRelayPolicy(null);   // explicit "policy off": configured relays only, no pinned/discovered relay
  delete process.env.NODE_OPERATOR_KEY;
  live.add(m); return m;
}
const restart = async (m) => { await m.releaseOperatorEffects("TEST process restart"); live.delete(m); };
/** fs wrapper for the store: after a state write matching `when` lands, `then()` runs ONCE (a TEST revocation/loss during persistence) */
function persistTrigger() {
  const t = { when: null, then: null, fired: false };
  t.fsImpl = { ...fs, writeFileSync(target, data, ...rest) {
    const r = fs.writeFileSync(target, data, ...rest);
    if (!t.fired && t.when && typeof data === "string" && data.includes('"records"') && t.when(data)) { t.fired = true; t.then(); }
    return r;
  } };
  return t;
}
async function rig(name, options = {}) {
  const file = path.join(dir, name);
  await initializeOperatorEffects(file, { domain: { account: ACCOUNT, chainId: 8453 } });
  S.chain = createInertChain({ dir: fs.mkdtempSync(path.join(dir, "chain-")), operator: ACCOUNT, owner: OWNER });
  Object.assign(S, { writes: [], writeError: false, signs: { auth: 0, typed: 0 }, pendingExtra: 0, headTs: 0n });
  return { file, c: await instance(file, options) };
}
const outcome = (p) => p.then((v) => ({ value: v }), (e) => ({ error: e }));
const opts = { skip: !flock && "needs Linux /usr/bin/flock (genuine owner)", timeout: 120_000 };
const view = (c) => c.sponsoredObligations().map((r) => ({ fn: r.fn, id: r.id, posts: r.posts, intents: r.intents.length,
  auth: r.authorizations.map((a) => a.state), signings: r.signings.map((s) => s.state), leaseOutcome: r.leaseOutcome ?? null }));


// ROOT regression: no new work may consume an unresolved authorization merely because its tuple matches.
// Actual shipped client, inert external signer/chain, genuine Linux store. Mined advancement is an independent TEST observation.
for (const mode of ['withheld', 'posted-unknown']) {
 test(`ROOT cross-deployment identical authorization stays quarantined: ${mode}`, opts, async () => {
  const t=persistTrigger(); const {file,c}=await rig(`root-${mode}.journal`,{fsImpl:t.fsImpl}); let allowed=true;
  if(mode==='withheld') {t.when=d=>d.includes('"signature":"0xee');t.then=()=>{allowed=false;};}
  else {S.chain.S.relayMode[RELAY_A]='land-silent';S.chain.S.onPost=()=>{allowed=false;};}
  const first=await outcome(c.renewDeployment(DEP,{gate:()=>allowed?null:'TEST revoked'}));
  assert.ok(first.error?.pending===true,first.error?.message);
  if(mode==='withheld') assert.equal(first.error.signedWithheld,true);
  else assert.equal(first.error.unknownOutcome,true);
  const counts={...S.signs},posts=[...S.chain.S.posts],gets=[...S.chain.S.gets],n=S.chain.S.accountNonce;
  await restart(c);const cold=await instance(file);
  S.chain.S.onPost=null;S.chain.S.relayMode[RELAY_A]='land';
  const next=await outcome(cold.claimDeployment(DEP2,HOST,{gate:()=>null}));
  assert.deepEqual(S.signs,counts,'no additional authorization or lease signature while account nonce remains held');
  assert.deepEqual(S.chain.S.posts,posts,'no new relay POST consumes a quarantined authorization');
  assert.deepEqual(S.chain.S.gets,gets,'refused before relay contact');
  assert.ok(next.error?.pending===true && next.error.notSent===true,next.error?.message);
  assert.equal(S.chain.S.accountNonce,n,'no new submission creates its own fence');
  assert.ok(cold.sponsoredObligations().some(x=>x.id===DEP),'old obligation retained');
  S.pendingExtra=1;
  assert.equal((await outcome(cold.claimDeployment(DEP2,HOST,{gate:()=>null}))).error?.pending,true,'pending count alone cannot clear');
  S.pendingExtra=0;S.chain.S.accountNonce=n+1; // external mined fence, NOT a recovery submission
  assert.match(await cold.claimDeployment(DEP2,HOST,{gate:()=>null}),/^0x[0-9a-f]{64}$/,'positive after independent fence');
  assert.deepEqual(S.signs,{auth:counts.auth+1,typed:counts.typed+1});
  assert.equal(S.chain.S.posts.length,posts.length+1);
  assert.ok(cold.sponsoredObligations().some(x=>x.id===DEP),'account fence is not proof old lease succeeded');
  await restart(cold);
 });
}
