// Actual signed protocol -> actual app ingress/broker -> loopback TLS fixture. Synthetic authority/readiness/manager; not guest hardware, attestation or production wiring.
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import {execFileSync} from 'node:child_process';
import {createAppBroker} from '../network/app-broker.mjs';
import {createAppIngress} from '../network/app-ingress.mjs';
import {spliceAppBroker} from '../network/broker-client.mjs';
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
  return { S, W, gate, reopenGate, runtime, collectPermit, snapshot, policy, dir };
}
async function startServing(w) {
  await w.runtime.ensureStaged(ID, w.snapshot('queued'));     // fresh queued origin = explicit handoff to the current host authority
  await w.runtime.serve(ID, w.snapshot('running'));
}
const record = (seq, hostAuthority) => { const s = Math.floor(Date.now() / 1000);
  return { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: seq, issuedAt: s, validUntil: s + 20, hostAuthority }; };

function event(socket,name){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('TEST timeout '+name)),3000);socket.once(name,x=>{clearTimeout(timeout);resolve(x);});});}
async function ingressWorld(t){
 const w=world(t);await startServing(w);
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',w.dir+'/tls.key','-out',w.dir+'/tls.cert','-days','1','-subj','/CN=independent.example'],{stdio:'ignore',timeout:10000});
 const key=fs.readFileSync(w.dir+'/tls.key'),cert=fs.readFileSync(w.dir+'/tls.cert'),connections=new Set();
 const guest=tls.createServer({key,cert},socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));socket.on('error',()=>{});socket.pipe(socket);});
 await new Promise((r,j)=>{guest.once('error',j);guest.listen(0,'127.0.0.1',r);});
 t.after(()=>{for(const socket of connections)socket.destroy();guest.close();});
 const authorize=id=>{try{w.gate.assert(id,{host:HOST,generation:3,hostAuthority:w.S.ctx.digest});return true;}catch{return false;}};
 let forwarded=0;
 const broker=await createAppBroker({socketPath:w.dir+'/app.sock',deploymentId:ID,authorize,forward:(stream,id)=>{
  assert.equal(id,ID);forwarded++;
  const upstream=net.connect({host:'127.0.0.1',port:guest.address().port});connections.add(upstream);upstream.once('close',()=>connections.delete(upstream));
  upstream.on('error',()=>stream.destroy());stream.once('close',()=>upstream.destroy());stream.pipe(upstream).pipe(stream);
 }});t.after(()=>broker.close());
 const ingress=await createAppIngress({deploymentId:ID,names:['independent.example'],authorize,forward:s=>spliceAppBroker(s,w.dir+'/app.sock')});t.after(()=>ingress.close());
 w.gate.track(ID,{host:HOST,generation:3,hostAuthority:w.S.ctx.digest},()=>{broker.revoke();ingress.revoke();});
 const connect=(servername='independent.example')=>{const c=tls.connect({host:'127.0.0.1',port:ingress.port,servername,ca:cert});c.on('error',()=>{});t.after(()=>c.destroy());return c;};
 const client=connect();await event(client,'secureConnect');
 const echo=async value=>{const got=event(client,'data');client.write(value);assert.equal((await got).toString(),value);};
 return {...w,client,connect,echo,forwarded:()=>forwarded};
}
test('real signed permit serves opaque TLS with an independent hostname; foreign SNI cannot select this app',async t=>{
 const w=await ingressWorld(t);await w.echo('real signed permission over app-bound TLS');assert.equal(w.forwarded(),1);
 const foreign=w.connect('foreign.example');await event(foreign,'close');assert.equal(w.forwarded(),1);
 await w.echo('same correct app remains open');
});
test('authenticated same-generation Offline closes actual active TLS streams and denies new connections',async t=>{
 const w=await ingressWorld(t);await w.echo('before offline');const closed=event(w.client,'close');
 assert.equal(w.gate.observeHostEvidence({context:w.S.ctx,status:'offline',proofVerified:true,blockHash:H('e2'),blockNumber:'101'}),'recorded');
 await closed;assert.equal(w.client.destroyed,true);
 const retry=w.connect();await event(retry,'close');assert.equal(w.forwarded(),1,'no fresh broker stream after Offline');
 assert.throws(()=>w.gate.assert(ID,{host:HOST,generation:3,hostAuthority:w.S.ctx.digest}));
});
test('another host authority update cannot close this host app TLS',async t=>{
 const w=await ingressWorld(t);await w.echo('before foreign host update');
 const foreign=hostAuthorityContextOf(hr({owner:A('2e')}),{chainId:8453,hostId:H('a9'),registryCodeHash:CODE});
 assert.equal(w.gate.observeHostAuthority(foreign),'advance');
 assert.equal(w.gate.observeHostEvidence({context:foreign,status:'offline',proofVerified:true,blockHash:H('e2'),blockNumber:'101'}),'recorded');
 await w.echo('this owner still serves');assert.equal(w.client.destroyed,false);
});
