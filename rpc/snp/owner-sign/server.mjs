// Local signing page for the owner's wallet (Trezor via the browser wallet) to release the SNP
// RPC app: node rpc/snp/owner-sign/server.mjs PLAN.json [PORT]
//
// PLAN.json (rpc/snp/owner-sign/plan.mjs writes it for a first release, upgrade-plan.mjs for a new
// version of a running deployment, topup-plan.mjs for ETH to a host's operator key, vault-version-plan.mjs for a
// new version of an app the owner's session vault publishes and holds, placement-plan.mjs for pinning a deployment
// to one host) lists each owner
// transaction with its exact calldata and the
// decoded arguments shown to the owner. The page sends a step only when the
// owner clicks it, from the owner's own wallet; this server signs and sends nothing. /status
// reads Base so the page can show which steps are already done and which are ready.
// Listens on 127.0.0.1 only. Submitted hashes are appended to PLAN.json's journal file.
// One step of a vault-version plan is a message, not a transaction: the owner signs enclave-upload:<sha256>:<expiry>
// and POST /upload trades it at the relay for an upload token and pins the plan's component (vault-version.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, fallback, formatEther, http as viemHttp } from 'viem';
import { base } from 'viem/chains';
import { CATALOG_ABI, LEDGER_ABI } from './abi.mjs';
import { simulateTopup } from './topup.mjs';
import { placementStatus } from './placement.mjs';
import { upload, vaultVersionStatus } from './vault-version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [planPath, port = '42290'] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const pub = createPublicClient({ chain: base, transport: fallback(plan.rpcs.map((u) => viemHttp(u, { timeout: 15000 }))) });
const ABI = {
  numVersions: [{ type: 'function', name: 'numVersions', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] }],
  regGet: [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' },
    { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' },
    { name: 'active', type: 'bool' }, { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' },
    { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] }],
};

async function status() {
  const s = plan.status;
  const [bal, versions, entry] = await Promise.all([
    pub.getBalance({ address: s.runner }),
    pub.readContract({ address: s.catalog, abi: ABI.numVersions, functionName: 'numVersions', args: [s.appId] }),
    pub.readContract({ address: s.registry, abi: ABI.regGet, functionName: 'get', args: [s.enclaveId] })]);
  const registered = entry.operator.toLowerCase() === s.runner.toLowerCase() && entry.active;
  const journal = fs.existsSync(plan.journal) ? fs.readFileSync(plan.journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return {
    fund: bal >= BigInt(s.runnerMinWei), publish: versions > BigInt(s.versionIndex),
    payout: registered && entry.payoutWallet.toLowerCase() === plan.owner.toLowerCase(),
    create: journal.some((j) => j.step === 'create' && j.hash),
    ready: { fund: true, publish: true, payout: registered, create: versions > BigInt(s.versionIndex) && registered && entry.payoutWallet.toLowerCase() === plan.owner.toLowerCase() },
    runnerBalanceWei: String(bal), versions: String(versions), runnerRegistered: registered, journal,
  };
}

// Is the host set up to launch the image the new version measures? The stop is offered only then: a host still
// bound to the old image would refuse the new version's claim and leave the deployment down.
function hostReady(s) {
  try {
    const b = JSON.parse(fs.readFileSync(s.managerConfig, 'utf8')).bindings?.[s.deployment];
    if (!b) return 'the host’s VM manager has no binding for this deployment';
    const root = JSON.parse(fs.readFileSync(path.join(b.image, 'IMAGE.json'), 'utf8')).rootHash;
    return root === s.imageRootHash ? null : 'the host’s VM manager is still bound to another image; run the host preparation first';
  } catch (e) { return 'the host’s VM manager config could not be read: ' + e.code; }
}

// An upgrade plan: publish, stop, start. A step is ready only while the chain is in the state it expects and the
// transaction simulates from the owner's address.
async function upgradeStatus() {
  const s = plan.status, now = BigInt(Math.floor(Date.now() / 1000));
  const [versions, d] = await Promise.all([
    pub.readContract({ address: s.catalog, abi: CATALOG_ABI, functionName: 'numVersions', args: [s.appId] }),
    pub.readContract({ address: s.ledger, abi: LEDGER_ABI, functionName: 'get', args: [s.deployment] })]);
  const published = versions > BigInt(s.versionIndex);
  const v = published ? await pub.readContract({ address: s.catalog, abi: CATALOG_ABI, functionName: 'getVersion', args: [s.appId, BigInt(s.versionIndex)] }) : null;
  const versionProblem = !published ? `version ${s.versionIndex} is not published yet`
    : v.cid !== s.cid || v.config !== s.versionConfig ? `version ${s.versionIndex} on chain is not this release`
    : v.approval !== 1 || v.yanked ? `version ${s.versionIndex} is not approved` : null;
  const onNew = d.appRef === s.newAppRef, leased = !/^0x0+$/.test(d.runner) && d.leaseUntil > now;
  const host = hostReady(s);
  const blocked = {
    publish: null,
    stop: versionProblem || host || (d.appRef !== s.oldAppRef ? `the deployment runs ${d.appRef}` : !d.active ? (leased ? 'stopping: the host is shutting the VM down and releasing its lease' : null) : null),
    start: versionProblem || host || (onNew ? null : d.active ? 'the deployment is still switched on' : leased ? 'the host still holds the lease; it releases it once the VM has stopped' : null),
  };
  const done = { publish: published, stop: onNew || (!d.active && !leased), start: onNew && d.active };
  const ready = {};
  for (const step of plan.steps) {
    ready[step.id] = !done[step.id] && !blocked[step.id];
    if (!ready[step.id]) continue;
    try { await pub.call({ account: plan.owner, to: step.to, data: step.data }); }
    catch (e) { ready[step.id] = false; blocked[step.id] = 'it would revert: ' + String(e.shortMessage || e.message).slice(0, 160); }
  }
  const journal = fs.existsSync(plan.journal) ? fs.readFileSync(plan.journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...done, ready, blocked, appRef: d.appRef, active: d.active, leased, leaseUntil: String(d.leaseUntil), versions: String(versions), journal };
}

// A top-up plan: one transaction. It is done once a submitted one is included, and is offered again only if every
// submitted one failed or none was, so a second click cannot send it twice. Before it is offered it is simulated
// again: the operator's balance must rise by exactly the amount.
async function topupStatus() {
  const s = plan.status, step = plan.steps[0];
  const journal = fs.existsSync(plan.journal) ? fs.readFileSync(plan.journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const [operatorBal, ownerBal, receipts] = await Promise.all([
    pub.getBalance({ address: s.operator }), pub.getBalance({ address: plan.owner }),
    Promise.all(journal.filter((j) => j.step === step.id).map((j) => pub.getTransactionReceipt({ hash: j.hash }).catch(() => null)))]);
  const done = receipts.some((r) => r?.status === 'success'), pending = receipts.some((r) => r === null);
  let blocked = pending ? 'sent, waiting for it to be included' : ownerBal <= BigInt(step.value) ? `your wallet holds ${formatEther(ownerBal)} ETH on Base` : null;
  if (!done && !blocked) {
    await simulateTopup(plan.rpcs, plan.owner, s.operator, { ...(step.to ? { to: step.to } : {}), data: step.data, value: step.value })
      .catch((e) => { blocked = 'the simulation refuses it: ' + String(e.shortMessage || e.message).slice(0, 160); });
  }
  return { [step.id]: done, ready: { [step.id]: !done && !blocked }, blocked: { [step.id]: blocked },
    note: { [step.id]: `The operator key holds ${formatEther(operatorBal)} ETH now.` }, operatorBalanceWei: String(operatorBal), journal };
}

const readJournal = () => (fs.existsSync(plan.journal) ? fs.readFileSync(plan.journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const servedCache = {};
const STATUS = { upgrade: upgradeStatus, topup: topupStatus, placement: () => placementStatus(plan, pub, { journal: readJournal() }),
  'vault-version': () => vaultVersionStatus(plan, pub, { cache: servedCache, journal: readJournal() }) };

http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/app.js') return send(200, fs.readFileSync(path.join(HERE, 'app.js')), 'text/javascript');
    if (req.method === 'GET' && req.url === '/plan') return send(200, { chainId: plan.chainId, owner: plan.owner, steps: plan.steps, title: plan.title, lead: plan.lead });
    if (req.method === 'GET' && req.url === '/status') return send(200, await (STATUS[plan.kind] || status)());
    if (req.method === 'POST' && req.url === '/submitted') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) throw new Error('too large'); }
      const { step, hash } = JSON.parse(body);
      if (!plan.steps.some((s) => s.id === step) || !/^0x[0-9a-f]{64}$/.test(hash)) return send(400, { error: 'bad submission' });
      fs.appendFileSync(plan.journal, JSON.stringify({ step, hash, at: new Date().toISOString() }) + '\n');
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/upload') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) throw new Error('too large'); }
      const { step, expiry, signature } = JSON.parse(body);
      if (!plan.steps.some((s) => s.id === step && s.upload)) return send(400, { error: 'bad submission' });
      const cid = await upload(plan.status.upload, plan.owner, { expiry, signature });
      fs.appendFileSync(plan.journal, JSON.stringify({ step, cid, at: new Date().toISOString() }) + '\n');
      return send(200, { ok: true, cid });
    }
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e.shortMessage || e.message).slice(0, 300) }); }
}).listen(Number(port), '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', url: `http://127.0.0.1:${port}/` })));
