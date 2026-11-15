// Local signing page for step 5 of the one-hop release: the owner's "One hop, no guard" for one app, signed with the
// owner's browser wallet.   node ops/one-hop-20261115/sign/server.mjs <deployment id> [port]
//
// It does what the hosted Network tab does and nothing else: the app's current policy as the relay holds it, with
// enclaveNetwork.guard false, the next nonce and the time; the owner signs networkPolicyMessage(policy) (a message,
// not a transaction) and this server posts {envelope:{policy,signature}} to the relay. The server holds no key. Who
// must sign is read from Base: the ledger's owner, or, where that is a session vault, the vault's owner (the relay
// accepts that wallet for the vault, network/owner-signature.mjs). The page refuses while the app's host does not
// report that it allows one hop: a host from before the setting refuses the whole policy and the app would have no
// network there. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, fallback, http as viemHttp, parseAbi, recoverMessageAddress } from 'viem';
import { base } from 'viem/chains';
import { validateNetworkPolicy, networkPolicyMessage } from '../../../network/network-policy-core.mjs';
import { LEDGER_ABI } from '../../../rpc/snp/owner-sign/abi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [id, port = '42295'] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(id || '')) { console.error('usage: server.mjs <deployment id> [port]'); process.exit(2); }
const RELAY = process.env.ONE_HOP_RELAY || 'https://api.enclave.host', LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const pub = createPublicClient({ chain: base, transport: fallback(['https://mainnet.base.org', 'https://base-rpc.publicnode.com'].map((u) => viemHttp(u, { timeout: 15000 }))) });

// the wallet whose signature the relay accepts for this app
async function signer() {
  const d = await pub.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: 'get', args: [id] });
  if (/^0x0{40}$/.test(d.owner)) throw new Error('the ledger has no such deployment');
  const code = await pub.getCode({ address: d.owner });
  if (!code || code === '0x') return { owner: d.owner, wallet: d.owner, vault: false };
  const wallet = await pub.readContract({ address: d.owner, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' });
  const wcode = await pub.getCode({ address: wallet });
  if (wcode && wcode !== '0x') throw new Error('the owner is a contract whose own owner is a contract: sign in the hosted Network tab instead');
  return { owner: d.owner, wallet, vault: true };
}
async function relay(p, init) {
  const r = await fetch(RELAY + p, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`relay ${r.status}: ${b.error || b.message || 'refused'}`);
  return b;
}
// what would be signed now: the relay's current policy with guard false, the next nonce and the time
async function proposal() {
  const [who, cur, status] = await Promise.all([signer(), relay('/v1/network/policy/' + id), relay('/v1/network/status/' + id)]);
  const p = validateNetworkPolicy(cur.policy), hostAllows = typeof status.host?.oneHop === 'boolean' ? status.host.oneHop : null;
  const out = { id, ...who, current: p, set: !!cur.envelope, hostAllows, hostReportedAt: status.hostReportedAt || null,
    circuits: (status.host?.circuits || []).filter((c) => (c.kind || 'network') === 'network').map((c) => ({ guard: c.guard?.region || null, exit: c.exit?.region || null, healthy: !!c.healthy })) };
  if (!p.enclaveNetwork) return { ...out, blocked: 'this app does not use the Enclave network, so there is no guard to give up' };
  if (p.enclaveNetwork.guard === false) return { ...out, done: true };
  if (hostAllows !== true) return { ...out, blocked: hostAllows === false ? "this app's host does not allow one hop" : "this app's host has not reported whether it allows one hop" };
  const next = validateNetworkPolicy({ ...p, nonce: p.nonce + 1, issuedAt: Math.floor(Date.now() / 1000), enclaveNetwork: { ...p.enclaveNetwork, guard: false } });
  return { ...out, next, message: networkPolicyMessage(next) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(403, { error: 'local only' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/proposal') return send(200, await proposal());
    if (req.method === 'POST' && req.url === '/submit') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(400, { error: 'json only' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 8192) throw new Error('too large'); }
      const { policy, signature } = JSON.parse(body), now = await proposal();
      // only the one change this page offers, on the policy the relay holds now, signed by the wallet read from Base
      if (!now.next) return send(409, { error: now.done ? 'already set' : now.blocked });
      if (!same({ ...policy, issuedAt: 0 }, { ...now.next, issuedAt: 0 }) || Math.abs(policy.issuedAt - now.next.issuedAt) > 600) return send(409, { error: 'the policy changed since the page was loaded; reload and sign again' });
      const from = await recoverMessageAddress({ message: networkPolicyMessage(policy), signature });
      if (from.toLowerCase() !== now.wallet.toLowerCase()) return send(403, { error: `signed by ${from}, but the owner's wallet is ${now.wallet}` });
      const out = await relay('/v1/network/policy/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { policy, signature } }) });
      console.log(JSON.stringify({ event: 'published', at: new Date().toISOString(), nonce: out.policy?.nonce, guard: out.policy?.enclaveNetwork?.guard }));
      return send(200, { ok: true, policy: out.policy });
    }
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e.shortMessage || e.message).slice(0, 300) }); }
}).listen(Number(port), '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', url: `http://127.0.0.1:${port}/` })));
