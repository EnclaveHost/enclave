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

test("od-r2 shipped client: UNCHANGED POSITIVE renew - authorization + lease signed once, onSigned durable BEFORE the POST, verified receipt, record settled by receipt AND mined account nonce", opts, async () => {
  const { c } = await rig("positive.journal");
  let atPost = null;
  S.chain.S.onPost = () => { atPost = view(c); };
  const n0 = S.chain.S.accountNonce;
  const hash = await c.renewDeployment(DEP, { gate: () => null });
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(S.signs, { auth: 1, typed: 1 });
  assert.deepEqual(S.chain.S.posts, [RELAY_A]);
  assert.deepEqual(atPost, [{ fn: "renew", id: DEP, posts: 1, intents: 1, auth: ["returned"], signings: ["returned"], leaseOutcome: null }],
    "the signed intent (the client's own onSigned) and the planned POST were durable when the relay saw the POST");
  assert.equal(S.chain.S.accountNonce, n0 + 1, "TEST chain: the landed transaction consumed the authorization's account nonce");
  assert.deepEqual(c.sponsoredObligations(), []);
  assert.deepEqual(S.writes, [], "the operator-paid sender is never used");
  await restart(c);
});

test("od-r2 shipped client: permission REVOKED DURING the POST plan's persistence -> 0 POSTs, exactly that planned POST discharged, signature retained (pending), latched; direct send then held by the authorization", opts, async () => {
  const t = persistTrigger();
  const { c } = await rig("post-revoked.journal", { fsImpl: t.fsImpl });
  let allowed = true;
  t.when = (d) => d.includes('"posts":1'); t.then = () => { allowed = false; };
  const r = await outcome(c.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST permission revoked during the POST plan's persistence") }));
  assert.equal(t.fired, true);
  assert.deepEqual(S.chain.S.posts, [], "the relay never saw a POST");
  assert.deepEqual(S.signs, { auth: 1, typed: 1 }, "no next-relay signature after the latched refusal");
  assert.deepEqual(S.chain.S.gets, [RELAY_A], "relay B is never contacted");
  assert.ok(r.error?.superseded === true && r.error.notSent === true && r.error.pending === true && r.error.leaseGas === true, r.error?.message);
  assert.notEqual(r.error.unknownOutcome, true);
  const [rec] = view(c);
  assert.deepEqual({ posts: rec.posts, intents: rec.intents, auth: rec.auth, signings: rec.signings }, { posts: 0, intents: 1, auth: ["returned"], signings: ["returned"] });
  assert.match(c.sponsoredObligations()[0].refused, /planned relay POST was refused before invocation/);
  allowed = true;   // a restored Boolean never revives the operation; the authorization still holds account nonce
  const d = await outcome(c.setPrices("0x" + "99".repeat(32), 1, 0));
  assert.ok(d.error?.pending === true && /EIP-7702 authorization/.test(d.error.message), d.error?.message);
  assert.deepEqual(S.writes, []);
  await restart(c);
});

test("od-r2 shipped client: owner/continuity LOST DURING the POST plan's persistence -> 0 POSTs, latched, retained (unsentRetained); restart refuses every effect, nothing re-created", opts, async () => {
  const t = persistTrigger();
  const { file, c } = await rig("post-owner-lost.journal", { fsImpl: t.fsImpl });
  t.when = (d) => d.includes('"posts":1'); t.then = () => fs.unlinkSync(file + ".established");
  const r = await outcome(c.renewDeployment(DEP, { gate: () => null }));
  assert.equal(t.fired, true);
  assert.deepEqual(S.chain.S.posts, []); assert.deepEqual(S.signs, { auth: 1, typed: 1 });
  assert.ok(r.error?.notSent === true && r.error.pending === true && r.error.unsentRetained === true, r.error?.message);
  assert.throws(() => c.sponsoredObligations(), /failed|lost|marker/i);
  await restart(c);
  const cold = await instance(file);
  const again = await outcome(cold.claimDeployment(DEP2, HOST, { gate: () => null }));
  assert.ok(again.error?.notSent === true && again.error.pending === true);
  const direct = await outcome(cold.setPrices("0x" + "99".repeat(32), 1, 0));
  assert.ok(direct.error?.notSent === true && direct.error.pending === true);
  assert.deepEqual(S.signs, { auth: 1, typed: 1 }, "zero additional signatures"); assert.deepEqual(S.chain.S.posts, []); assert.deepEqual(S.writes, []);
  assert.equal(fs.existsSync(file + ".established"), false);
  await restart(cold);
});

test("od-r2 shipped client: RETURNED lease signature withheld when permission ends during its result's persistence; restart; another deployment is refused until an independently observed mined fence; direct send then unchanged positive; deadline settles the withheld lease", opts, async () => {
  const t = persistTrigger();
  const { file, c } = await rig("withheld.journal", { fsImpl: t.fsImpl });
  let allowed = true;
  t.when = (d) => d.includes('"signature":"0xee'); t.then = () => { allowed = false; };
  const n0 = S.chain.S.accountNonce;
  const r = await outcome(c.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST permission ended during the signature result's persistence") }));
  assert.equal(t.fired, true);
  assert.ok(r.error?.signedWithheld === true && r.error.superseded === true && r.error.notSent === true && r.error.pending === true, r.error?.message);
  assert.deepEqual(S.signs, { auth: 1, typed: 1 }); assert.deepEqual(S.chain.S.posts, []);
  const rec = c.sponsoredObligations()[0];
  assert.equal(rec.signings[0].state, "withheld"); assert.match(rec.signings[0].signature, /^0x(ee){64}01$/);
  assert.equal(rec.intents.length, 0, "never handed to onSigned, never POSTed");
  assert.deepEqual(JSON.parse(rec.authorizations[0].request), { chainId: 8453, contractAddress: S.chain.A.executor, nonce: n0 }, "exact account nonce/chain/delegate recorded");
  assert.ok((await outcome(c.setPrices("0x" + "99".repeat(32), 1, 0))).error?.pending === true, "unresolved authorization -> direct send refused");
  await restart(c);
  const cold = await instance(file);
  assert.ok((await outcome(cold.setPrices("0x" + "99".repeat(32), 1, 0))).error?.pending === true, "still held after restart (mined count unchanged)");
  assert.match(cold.releaseHold(DEP), /unresolved/);
  const refused = await outcome(cold.claimDeployment(DEP2, HOST, { gate: () => null }));
  assert.ok(refused.error?.pending && refused.error.notSent, refused.error?.message);
  assert.deepEqual(S.signs, { auth: 1, typed: 1 }); assert.deepEqual(S.chain.S.posts, []);
  assert.equal(S.chain.S.accountNonce, n0, "quarantine cannot create its own nonce fence");
  S.chain.S.accountNonce = n0 + 1; // independent TEST mined observation, not a new recovery submission
  const hash = await cold.claimDeployment(DEP2, HOST, { gate: () => null });
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(S.signs, { auth: 2, typed: 2 });
  assert.equal(S.chain.S.accountNonce, n0 + 2, "the new operation uses only the next account nonce after the independent fence");
  assert.equal(await cold.setPrices("0x" + "99".repeat(32), 1, 0), "0x" + "ab".repeat(32), "unchanged positive after the exact mined fence");
  assert.deepEqual(S.writes, [["setPrices", n0 + 2]]);
  assert.equal(cold.sponsoredObligations().length, 1, "the withheld lease signature still holds DEP until its recorded deadline");
  S.headTs = 10n ** 12n;   // TEST chain head past the recorded lease deadline
  const out = await cold.resolvePendingReleases();
  assert.ok(out.some((x) => x.id === DEP && x.outcome === "expired"), JSON.stringify(out));
  assert.deepEqual(cold.sponsoredObligations(), []);
  await restart(cold);
});

test("od-r2 shipped client: an earlier POST (answer lost) then refusal -> unknown outcome, 0 further signatures/POSTs; direct held; restart reconciles BY RECORDED IDENTITY (resolveSigned) once included", opts, async () => {
  const { file, c } = await rig("posted.journal");
  let allowed = true;
  S.chain.S.relayMode[RELAY_A] = "land-silent";
  S.chain.S.onPost = () => { allowed = false; };
  const r = await outcome(c.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST withdrawn after relay A's POST") }));
  assert.ok(r.error?.unknownOutcome === true && r.error.pending === true && r.error.notSent === false, r.error?.message);
  assert.deepEqual(S.chain.S.posts, [RELAY_A], "relay B is never POSTed to");
  assert.deepEqual(S.signs, { auth: 1, typed: 1 }, "no lease signature for relay B");
  assert.equal(view(c)[0].posts, 1);
  assert.ok((await outcome(c.setPrices("0x" + "99".repeat(32), 1, 0))).error?.pending === true);
  await restart(c);
  const cold = await instance(file);
  assert.equal((await outcome(cold.renewDeployment(DEP, { gate: () => null }))).error?.code, "SponsoredPending");
  assert.deepEqual(S.signs, { auth: 1, typed: 1 });
  const held = await cold.resolvePendingReleases();
  assert.ok(held.some((x) => x.id === DEP && /pending|held/.test(x.outcome)), JSON.stringify(held));
  S.chain.reveal();   // TEST chain: relay A's transaction is included now (answer was lost)
  const out = await cold.resolvePendingReleases();
  assert.ok(out.some((x) => x.id === DEP && x.outcome === "landed"), JSON.stringify(out));
  assert.deepEqual(cold.sponsoredObligations(), []);
  assert.equal(await cold.setPrices("0x" + "99".repeat(32), 1, 0), "0x" + "ab".repeat(32));
  await restart(cold);
});

test("od-r2 shipped client: an unresolved DIRECT write refuses a sponsored claim of another deployment before any signature or relay contact, also after restart; the exact mined fence then admits it", opts, async () => {
  const { file, c } = await rig("direct-first.journal");
  const n0 = S.chain.S.accountNonce;
  S.writeError = true;
  assert.ok((await outcome(c.setPrices("0x" + "99".repeat(32), 1, 0))).error?.unknownOutcome === true);
  assert.deepEqual(S.writes, [["setPrices", n0]]);
  S.writeError = false;
  for (const m of [c, null]) {
    const x = m ?? await instance(file);
    const r = await outcome(x.claimDeployment(DEP2, HOST, { gate: () => null }));
    assert.ok(r.error?.code === "AccountNoncePending" && r.error.pending === true && r.error.notSent === true, r.error?.message);
    assert.deepEqual(S.signs, { auth: 0, typed: 0 }); assert.deepEqual(S.chain.S.gets, []); assert.deepEqual(S.chain.S.posts, []);
    if (m) await restart(m); else live.add(x), (globalThis.__odR2Cold = x);
  }
  const cold = globalThis.__odR2Cold; delete globalThis.__odR2Cold;
  S.pendingExtra = 1;   // a pending count above the nonce is NOT a fence
  assert.equal((await outcome(cold.claimDeployment(DEP2, HOST, { gate: () => null }))).error?.code, "AccountNoncePending");
  S.chain.S.accountNonce = n0 + 1; S.pendingExtra = 0;   // TEST chain: nonce n0 mined (a fence, not proof the write succeeded)
  assert.match(await cold.claimDeployment(DEP2, HOST, { gate: () => null }), /^0x[0-9a-f]{64}$/);
  assert.deepEqual(S.signs, { auth: 1, typed: 1 });
  assert.equal(cold.ambiguousOperatorWrite(), null);
  await restart(cold);
});
