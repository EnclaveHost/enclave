// Test-only policy world for a MEASURED guest (adapted from the frozen test/helpers/platform-policy-world.mjs, whose answer
// logic it keeps): the measured guest enforces ENCLAVE_PLATFORM_HOST_POLICY=production, so this world answers at the
// PRODUCTION book and hostOwnership addresses, and its three JSON-RPC origins are HTTPS (the measured config takes https RPCs
// with distinct hosts only): https://127.0.0.1, https://localhost and https://[::1], each with a throwaway CA handed to the
// supervisor via NODE_EXTRA_CA_CERTS. A plain-HTTP policy-mirror PEER (another host's role) serves <digest>.json documents.
// The admin "anchors" by setting the book's two anchor values. Nothing touches a real chain, key or network.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS, POLICY_FORMAT } from '../../network/platform-host-policy.mjs';

const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'authority', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' },
    { name: 'measurement', type: 'bytes32' }, { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' }, { name: 'active', type: 'bool' }] }] }];
// the production platform host policy (network/platform-host-policy-config.mjs PRODUCTION_HOST_POLICY)
export const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907', OWNERSHIP = '0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7';
export const REGISTRY = '0x' + 'e0'.repeat(20);
const REGISTRY_KEY = toHex('registry', { size: 32 });

export async function measuredPolicyWorld(t, { hosts = {} } = {}) {
  const admin = privateKeyToAccount(generatePrivateKey());
  const state = { hi: ZA, lo: ZA, hosts };
  const t0 = Date.now();
  const blockAt = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1, { size: 32 })), timestamp: toHex(Math.floor(Date.now() / 1000)),
    transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', logsBloom: '0x' + '00'.repeat(256), miner: ZA, nonce: '0x0000000000000000',
    sha3Uncles: Z32, stateRoot: Z32, receiptsRoot: Z32, transactionsRoot: Z32, extraData: '0x', size: '0x1', uncles: [], mixHash: Z32, totalDifficulty: '0x0' });
  const head = () => 1000 + Math.floor((Date.now() - t0) / 1000);
  const byHash = new Map();
  const answer = ({ method, params }) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_blockNumber') return toHex(head());
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? head() : Number(params[0]); const b = blockAt(n); byHash.set(b.hash, n); return b; }
    if (method === 'eth_getBlockByHash') { const n = byHash.get(params[0]); return n === undefined ? null : blockAt(n); }
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_call') {
      const { to, data } = params[0]; const T = String(to).toLowerCase();
      const { functionName, args } = decodeFunctionData({ abi: ABI, data });
      let r;
      if (T === BOOK && functionName === 'owner') r = admin.address;
      else if (T === BOOK && functionName === 'addr') r = args[0] === ANCHOR_KEYS.hi ? state.hi : args[0] === ANCHOR_KEYS.lo ? state.lo : args[0] === REGISTRY_KEY ? REGISTRY : ZA;
      else if (T === REGISTRY && functionName === 'get') { const h = state.hosts[String(args[0]).toLowerCase()];
        r = { endpoint: h?.endpoint || '', repo: '', measurement: Z32, operator: h?.operator || ZA, registeredAt: 1n, lastSeen: 1n, active: !!h?.active }; }
      else if (T === OWNERSHIP && functionName === 'authority') { const h = state.hosts[String(args[0]).toLowerCase()]; r = [h?.owner || ZA, ZA, 1n, Z32]; }
      else throw Error(`unscripted ${T} ${functionName}`);
      return encodeFunctionResult({ abi: ABI, functionName, result: r });
    }
    throw Error('unsupported ' + method);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measured-policy-world-'));
  const ossl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=measured-policy-world-ca');
  ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost');
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost,IP:::1\nbasicConstraints=CA:FALSE\n');
  ossl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');
  const tlsOpts = { key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) };
  const rpcCalls = [];
  const rpcServer = () => https.createServer(tlsOpts, (req, res) => {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(c)); } catch { res.writeHead(400); return res.end(); }
      const one = (q) => { rpcCalls.push(q.method); try { return { jsonrpc: '2.0', id: q.id, result: answer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: String(e.message) } }; } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  // three DISTINCT hosts, as the measured config requires: 127.0.0.1, localhost (dual stack), [::1]
  const binds = [['127.0.0.1', '127.0.0.1'], ['localhost', '::'], ['[::1]', '::1']];
  const rpcs = binds.map(() => rpcServer());
  await Promise.all(rpcs.map((s, i) => new Promise((r, no) => { s.once('error', no); s.listen(0, binds[i][1], r); })));
  // the PEER: another host's policy-mirror role (http; the bytes self-verify), <base>/<digest>.json
  const docs = new Map(), served = [];
  const peer = http.createServer((req, res) => {
    served.push(req.url); const m = /^\/platform-policy\/(0x[0-9a-f]{64})\.json$/.exec(req.url || '');
    if (!m || !docs.has(m[1])) { res.writeHead(404); return res.end(); }
    const v = docs.get(m[1]); res.writeHead(200, { 'content-type': 'application/json' }); res.end(typeof v === 'string' ? v : JSON.stringify(v));
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of [...rpcs, peer]) { s.closeAllConnections?.(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });
  /** sign (by `signer`, default the book's owner) a non-expiring document; anchor=true sets the book's anchor to it */
  async function sign({ sequence, deny = [], mode = 'denylist', admit = [], signer = admin, anchor = true }) {
    const p = { format: POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REGISTRY, hostOwnership: OWNERSHIP, sequence, issuedAt: Math.floor(Date.now() / 1000) - 5,
                expiresAt: 0, maxStaleSec: 0, previousDigest: Z32, mode, deny, admit };
    const digest = policyDigest(p), entry = { document: JSON.stringify(p), signature: await signer.signTypedData(policyTypedData(p)) };
    if (anchor) { const a = encodeAnchor(digest); state.hi = a.hi; state.lo = a.lo; }
    return { digest, entry, policy: p };
  }
  return {
    state, admin, sign, docs, served, rpcCalls, ca: path.join(dir, 'ca.pem'),
    rpcs: rpcs.map((s, i) => `https://${binds[i][0]}:${s.address().port}`),
    peerBase: `http://127.0.0.1:${peer.address().port}/platform-policy`,
  };
}
