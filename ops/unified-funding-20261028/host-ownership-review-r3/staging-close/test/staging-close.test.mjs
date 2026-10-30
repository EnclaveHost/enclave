// Actual frozen runtime/gate/journals; synthetic authority/plan/readiness/manager. No hardware or production operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { hashTypedData } from 'viem';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { servingPermitTypedData, verifyServingPermit } from '../network/deployment-serving-permit.mjs';
import { openHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf, isHostAuthorityPermit, checkPermitHostAuthority, servingContextOf, compareHostAuthority } from '../network/deployment-host-authority.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const HOST = H('a1'), ID = H('a2'), CTRL = '0x' + 'c7'.repeat(20), REG = A('ab'), CODE = H('23');
const PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: 'independent-host-registry-r1' } });
const V1PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hap-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sorted = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const reporters = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))).map(a => a.address.toLowerCase());
// canonical lifecycle exactly as the adapter's hostLifecycleState exposes it (exact decimal strings)
const hr = (over = {}) => ({ scope: 'host', registry: REG, codeConsistent: true, status: 'online', online: true, generation: '1',
  hardwareId: H('b1'), descriptorDigest: H('b2'), qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'),
  owner: A('1d'), revision: '1', policyHash: H('55'), reporters: { keys: reporters, threshold: 2, revision: '1' }, ...over });
const ctxOf = over => hostAuthorityContextOf(hr(over), { chainId: 8453, hostId: HOST, registryCodeHash: CODE });

function world(t, { now = () => Date.now() } = {}) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey());
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), status: 'online', block: H('e1'), appGen: 2, delayAfterHealth: null, allows: [] };
  const evidence = () => ({ context: S.ctx, status: S.status, blockHash: S.block, proofVerified: true });
  const assignment = () => ({ deployment: ID, host: HOST, operator: operator.address, state: 'running', generation: S.appGen + 1,
    policyRevision: 1, admitted: true, funded: true, authorityTier: 'finalized', proofVerified: true,
    observedAt: Math.floor(now() / 1000), blockTimestamp: Math.floor(now() / 1000), blockHash: S.block });
  // TEST DOUBLE: each witness's own authenticated chain reader (same block for assignment and host evidence)
  const authority = { async read() { return { assignment: assignment(), policy, hostAuthority: evidence(), hostAdmitted: true }; } };
  const health = { async verify(id, host, generation) { if (S.delayAfterHealth) await S.delayAfterHealth();
    return { verified: true, deployment: id, host, generation, ready: true, validUntil: Math.floor(now() / 1000) + 60 }; } };
  const W = witnesses.map((w, i) => new DeploymentLifecycleWitness({ pins: PINS, account: w, journal: openLifecycleJournal(path.join(dir, `w${i}.json`)),
    authority, health, now, hostAuthorityJournal: openHostAuthorityJournal(path.join(dir, `w${i}-ha.json`)) }));
  // TEST DOUBLE transport: the real collector's fetch is delivered to the real witness in process
  const fetchImpl = async (url, { body }) => { const i = Number(new URL(url).hostname.slice(1, 2)), req = JSON.parse(body);
    try { const reply = await W[i].permit(req.record, req.operatorSignature); return { ok: true, body: [Buffer.from(JSON.stringify(reply))] }; }
    catch { return { ok: false, body: [] }; } };
  const collectPermit = createPermitCollector({ pins: PINS, account: operator, fetchImpl,
    endpoints: witnesses.map((w, i) => ({ url: `https://w${i}.witness.test/`, address: w.address })) });
  const hostFile = path.join(dir, 'host.json'), haFile = path.join(dir, 'gate-ha.json');
  const journal = openLifecycleJournal(hostFile);                      // ONE host journal shared by gate and runtime (permit sequence)
  const gate = new DeploymentPermitGate({ pins: PINS, journal, now, hostAuthority: openHostAuthorityJournal(haFile) });
  const reopenGate = () => new DeploymentPermitGate({ pins: PINS, journal: openLifecycleJournal(hostFile), now, hostAuthority: openHostAuthorityJournal(haFile) });
  const vms = new Map();
  const client = { async findByName(id) { return vms.get(id) ?? null; },
    async spawn(body) { const view = { id: 'vm-1', name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const boundaries = { async hold(id) { return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { S.allows.push(grant); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  const runtime = createIsolationLifecycleRuntime({ client, gate, journal, collectPermit, boundaries, host: HOST, now,
    plans: { async read(id) { return { verified: true, host: HOST, body: { name: id }, stagingEnforced: true }; } },
    readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: now() + 60000 }; } } });
  const snapshot = state => ({ schema: 2, id: ID, verified: true, proofVerified: true, authorityTier: 'finalized', blockAt: now(), blockHash: S.block, thisHost: HOST,
    enabled: true, admitted: true, funded: true, policy, hostAuthorityEvidence: evidence(),
    assignment: { state, host: HOST, operator: operator.address, generation: state === 'running' ? S.appGen + 1 : S.appGen, revision: 1 } });
  t.after(()=>{gate.close();W.forEach(w=>w.close());});
  return { S, W, gate, reopenGate, runtime, collectPermit, snapshot, policy, client, vms };
}
async function startServing(w) {
  await w.runtime.ensureStaged(ID, w.snapshot('queued'));     // fresh queued origin = explicit handoff to the current host authority
  await w.runtime.serve(ID, w.snapshot('running'));
}
const record = (seq, hostAuthority) => { const s = Math.floor(Date.now() / 1000);
  return { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: seq, issuedAt: s, validUntil: s + 20, hostAuthority }; };

test('control: open gate stages a real runtime through the TEST manager',async t=>{
 const w=world(t);const result=await w.runtime.ensureStaged(ID,w.snapshot('queued'));
 assert.equal(result.ready,true);assert.equal(w.vms.size,1);
});
test('gate closed while initial manager lookup awaits must prevent a subsequent spawn',async t=>{
 const w=world(t);let unblock,enter;const held=new Promise(r=>{unblock=r;}),reached=new Promise(r=>{enter=r;});
 const originalFind=w.client.findByName,originalSpawn=w.client.spawn;let first=true,spawns=0;
 w.client.findByName=async id=>{if(first){first=false;enter();await held;}return originalFind(id);};
 w.client.spawn=async body=>{spawns++;return originalSpawn(body);};
 const operation=w.runtime.ensureStaged(ID,w.snapshot('queued')).then(value=>({value}),error=>({error}));
 try{
  await reached;w.gate.close('TEST owner withdrawn before spawn');unblock();const outcome=await operation;
  console.log('ROOT closed-gate staging result',JSON.stringify({spawns,ready:outcome.value?.ready,error:outcome.error?.message,instances:w.vms.size}));
  assert.equal(spawns,0,'no new manager create after authorization was closed');
  assert.equal(w.vms.size,0);
 }finally{unblock();}
});
