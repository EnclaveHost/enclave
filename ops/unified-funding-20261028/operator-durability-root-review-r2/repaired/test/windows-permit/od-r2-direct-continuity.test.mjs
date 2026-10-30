// durability r2 (AUTHORED, NOT RUN). The ACTUAL chain.mjs serialized direct sender over the ACTUAL owned operator-effects store (Linux
// backend: genuine /usr/bin/flock owner + owned-durable-state files in a private temp dir). Carries root boundary-v2's three FAIL cases
// (evidence/root-operator-r1/root-boundary-v2.test.mjs; that file stays unchanged executed evidence) and adds continuity, cached-read,
// restart, discharge and account-nonce (EIP-7702 authorization -> direct) cases. TEST, labelled: the public TEST account (no signer),
// inert viem RPC/wallet doubles for chain.mjs only (nothing signed, broadcast or paid; no network). The lease bundle is replaced by a
// refusing TEST stub here ONLY because these cases are direct-path cases with app-funded leases off; the sponsored direction runs
// against the SHIPPED bundle in od-r2-shipped-client.test.mjs. A fresh module instance after releaseOperatorEffects models a process
// restart (module memory lost, owner released); it is NOT an OS crash or power loss. Globals/env are restored after the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { initializeOperatorEffects, openOperatorEffects, canonicalBounded } from "../../control/windows/node/operator-effects.mjs";

const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const url = new URL("../../control/windows/node/chain.mjs", import.meta.url);
const S = { writes: [], nonce: 0, mined: 0, writeError: false, receipts: new Map() };
globalThis.__odR2Direct = S;
const modules = {
  viem: `const s=globalThis.__odR2Direct;
  export const createPublicClient=()=>({simulateContract:async()=>{},getTransactionCount:async({blockTag})=>blockTag==='latest'?s.mined:s.nonce,
    waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async({hash})=>s.receipts.get(hash)??null,getBlock:async()=>({timestamp:0n})});
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
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r2-direct-"));
const saved = { key: process.env.NODE_OPERATOR_KEY };
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__odR2Direct;
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  fs.rmSync(dir, { recursive: true, force: true });
});
const ACCOUNT = "0x" + "11".repeat(20), dep = "0x" + "22".repeat(32), depB = "0x" + "23".repeat(32);
const sha = (s) => createHash("sha256").update(s).digest("hex");
let serial = 0;
async function instance(file, options = {}) {
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try {
    const m = await import(`${url.href}?od-r2-${++serial}`);
    m.loadOperator(); m.addresses.deployments = "0x" + "44".repeat(20); m.addresses.registry = "0x" + "55".repeat(20);
    if (file) m.setOperatorEffects(file, options);
    live.add(m); return m;
  } finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
}
const restart = async (m) => { await m.releaseOperatorEffects("TEST process restart"); live.delete(m); };
async function established(name) { const file = path.join(dir, name); await initializeOperatorEffects(file, { domain: { account: ACCOUNT, chainId: 8453 } }); return file; }
const reset = (o) => Object.assign(S, { writes: [], writeError: false, receipts: new Map() }, o);
const opts = { skip: !flock && "needs Linux /usr/bin/flock (genuine owner)" };
const outcome = (p) => p.then((v) => ({ value: v }), (e) => ({ error: e }));
/** an owned sponsored record holding ONE recorded EIP-7702 authorization (no lease signature, intent or POST), written through the
 *  actual store by its actual owner, which is then released (a reconstructed earlier process). Nothing is signed. */
async function heldAuthorization(file, { id = dep, nonce = 70, chainId = 8453, signer = ACCOUNT, state = "returned" } = {}) {
  const store = await openOperatorEffects(file, { domain: { account: ACCOUNT, chainId: 8453 } });
  const key = `s:claim:${id}:${Date.now()}-${++serial}`;
  const bindings = canonicalBounded({ chainId: 8453, ledger: "0x" + "44".repeat(20), registry: "0x" + "55".repeat(20) });
  const request = canonicalBounded({ chainId, contractAddress: "0x" + "77".repeat(20), nonce });
  store.put(key, { type: "sponsored", key, account: ACCOUNT, chainId: 8453, fn: "claim", id, state: "authorizing", bindings: { canonical: bindings, sha256: sha(bindings) },
    authorizations: [{ at: Date.now(), state, request, sha256: sha(request), signer, signature: null }], signings: [], intents: [], posts: 0, refused: null, at: Date.now() });
  await store.release("TEST reconstructed earlier process with an unresolved authorization");
  return key;
}

// ---- 1. final store continuity (root boundary-v2 cases 1 and 2, then restart) ----
for (const suffix of ["", ".established"]) {
  test(`od-r2 ROOT boundary-v2: the final gate sees the established ${suffix || "state"} removed after the intent persisted -> 0 inert writes, latched, retained; restart refuses`, opts, async () => {
    const file = await established(`boundary${suffix || "-state"}.journal`);
    reset({ nonce: 60, mined: 60 }); const c = await instance(file); let removed = false;
    const gate = () => { if (!removed && c.operatorEffectsStatus().ownership === "live" && c.ambiguousOperatorWrite()) { fs.unlinkSync(file + suffix); removed = true; } return null; };
    const r = await outcome(c.renewDeployment(dep, { gate }));
    assert.equal(removed, true, "external loss occurs after the intent was persisted");
    assert.equal(S.writes.length, 0, JSON.stringify({ writes: S.writes, error: r.error?.message }));
    assert.ok(r.error?.notSent === true && r.error.pending === true && r.error.unsentRetained === true, "unsent, but its record could not be discharged: retained, never reported cleared");
    assert.throws(() => c.ambiguousOperatorWrite(), /failed|missing|lost|unavailable/i, "cached state cannot bypass loss");
    assert.match(c.operatorEffectsStatus().ownership, /failed|lost/);
    await restart(c);
    const cold = await instance(file);
    const again = await outcome(cold.renewDeployment(dep, { gate: () => null }));
    assert.equal(S.writes.length, 0, "a fresh process never re-creates or replays around the lost evidence");
    assert.ok(again.error?.notSent === true && again.error.pending === true);
    assert.equal(fs.existsSync(file + suffix), false, "nothing is re-created by a normal open");
  });
}

test("od-r2 continuity: a REPLACED state file (same bytes, new inode) after persistence -> 0 writes; the cached records refuse", opts, async () => {
  const file = await established("replaced.journal");
  reset({ nonce: 61, mined: 61 }); const c = await instance(file); let replaced = false;
  const gate = () => {
    if (!replaced && c.operatorEffectsStatus().ownership === "live" && c.ambiguousOperatorWrite()) {
      fs.copyFileSync(file, file + ".copy"); fs.renameSync(file + ".copy", file); replaced = true;   // TEST external replacement
    }
    return null;
  };
  const r = await outcome(c.renewDeployment(dep, { gate }));
  assert.equal(replaced, true); assert.equal(S.writes.length, 0, r.error?.message);
  assert.ok(r.error?.notSent === true && r.error.pending === true);
  assert.throws(() => c.ambiguousOperatorWrite(), /failed|changed|lost/i);
});

test("od-r2 continuity: store-level cached reads (records/get/assertLive) refuse after the marker or state is lost while the lock is held", opts, async () => {
  for (const victim of [".established", ""]) {
    const file = await established(`cached${victim || "-state"}.journal`);
    const s = await openOperatorEffects(file, { domain: { account: ACCOUNT, chainId: 8453 } });
    s.put("w:5", { type: "write", key: "w:5", account: ACCOUNT, chainId: 8453, nonce: 5, address: "0x" + "44".repeat(20), functionName: "renew",
      request: canonicalBounded({ a: 1 }), requestSha256: sha(canonicalBounded({ a: 1 })), state: "sending", hash: null, error: null, at: Date.now() });
    assert.equal(s.records().length, 1);
    fs.unlinkSync(file + victim);
    assert.throws(() => s.records(), (e) => e.uncertain === true);
    assert.throws(() => s.get("w:5"), (e) => e.uncertain === true, "the latch holds for every later read");
    assert.throws(() => s.assertLive(), (e) => e.uncertain === true);
    assert.throws(() => s.remove("w:5", "TEST"), (e) => e.uncertain === true, "never discarded as success");
    await s.release();
  }
});

test("od-r2 continuity: exact known-unsent discharge stays available with intact storage; unchanged positive at the SAME nonce", opts, async () => {
  const file = await established("discharge.journal");
  reset({ nonce: 15, mined: 15 }); const c = await instance(file);
  const gate = () => { try { return c.ambiguousOperatorWrite() ? "TEST refusal after intent persisted" : null; } catch { return null; } };
  const r = await outcome(c.renewDeployment(dep, { gate }));
  assert.equal(S.writes.length, 0); assert.ok(r.error?.notSent === true && !r.error.unsentRetained);
  assert.equal(c.ambiguousOperatorWrite(), null, "exactly this attempt was discharged (durably)");
  assert.equal(await c.renewDeployment(dep, { gate: () => null }), "0x" + "ab".repeat(32));
  assert.deepEqual(S.writes, [["renew", 15]]);
  await restart(c);
});

// ---- 2. account nonce: an unresolved sponsored EIP-7702 authorization fences the actual direct sender ----
test("od-r2 ROOT boundary-v2 case 3: an established unresolved authorization (account nonce 70) fences the direct sender after owner release + fresh process; pending is not a fence; exact mined fence -> unchanged positive", opts, async () => {
  const file = await established("cross-kind.journal");
  reset({ nonce: 71, mined: 70 });   // pending count 71 (not a fence), mined 70
  await heldAuthorization(file, { id: dep, nonce: 70 });
  const c = await instance(file);
  for (const p of [c.renewDeployment(depB, { gate: () => null }), c.setPrices("0x" + "99".repeat(32), 1, 0)]) {   // another deployment id; another function
    const r = await outcome(p);
    assert.ok(r.error?.notSent === true && r.error.pending === true && r.error.code === "AmbiguousPriorWrite", r.error?.message);
  }
  assert.equal(S.writes.length, 0);
  const held = await c.resolvePendingReleases();
  assert.match(JSON.stringify(held), /held: .*account nonce 70/, "never settled 'unsent' merely because no lease signature exists");
  assert.equal(c.sponsoredObligations().length, 1);
  await restart(c);
  const cold = await instance(file);
  assert.ok((await outcome(cold.renewDeployment(depB, { gate: () => null }))).error?.pending === true);
  assert.equal(S.writes.length, 0, "unchanged mined count: still held after restart");
  S.mined = 71; S.nonce = 71;   // TEST chain: the mined account nonce passed 70 (a fence, not proof the authorization was used)
  assert.equal(await cold.renewDeployment(depB, { gate: () => null }), "0x" + "ab".repeat(32));
  assert.deepEqual(S.writes, [["renew", 71]]);
  const fenced = await cold.resolvePendingReleases();
  assert.deepEqual(fenced.map((x) => x.outcome), ["no lease signed"]);
  assert.equal(cold.sponsoredObligations().length, 0, "settled by the mined fence, read-only");
  await restart(cold);
});

test("od-r2 account nonce: an authorization naming another chain or another signer is UNKNOWN -> held even past its nonce; a sign-threw/unsent one is no exposure", opts, async () => {
  for (const [name, o, blocks] of [["other-chain", { chainId: 1 }, true], ["other-signer", { signer: "0x" + "12".repeat(20) }, true],
                                    ["sign-threw", { state: "sign-threw" }, false], ["unsent", { state: "unsent" }, false]]) {
    const file = await established(`unknown-${name}.journal`);
    reset({ nonce: 80, mined: 80 });
    await heldAuthorization(file, { nonce: 3, ...o });   // nonce 3 < mined 80: a KNOWN authorization would already be fenced
    const c = await instance(file);
    const r = await outcome(c.renewDeployment(depB, { gate: () => null }));
    if (blocks) { assert.ok(r.error?.pending === true && /unknown account-nonce/.test(r.error.message), name); assert.equal(S.writes.length, 0, name); }
    else { assert.equal(r.value, "0x" + "ab".repeat(32), name); assert.deepEqual(S.writes, [["renew", 80]], name); }
    await restart(c);
  }
});
