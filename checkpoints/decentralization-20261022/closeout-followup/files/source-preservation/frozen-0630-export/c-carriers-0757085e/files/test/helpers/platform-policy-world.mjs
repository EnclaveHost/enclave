// Test-only world for the platform host policy in REAL processes (supervisor.js, the packaged relay): three loopback
// JSON-RPC servers that answer the policy facts (AddressBook owner/anchor/registry, registry rows, EnclaveHostOwnership
// accepted owners) with fresh blocks and a switchable outage, and an HTTPS mirror (its own test CA, handed to children via
// NODE_EXTRA_CA_CERTS) serving admin-signed policies. The admin "anchors" by setting the book's two anchor values - what
// the unsigned setMany does on Base. Nothing here touches a real chain or key.
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
  { type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' },
    { name: 'measurement', type: 'bytes32' }, { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' }, { name: 'active', type: 'bool' }] }] }];
export const BOOK = '0x' + 'b0'.repeat(20), REGISTRY = '0x' + 'e0'.repeat(20), OWNERSHIP = '0x' + 'c0'.repeat(20);
const REGISTRY_KEY = toHex('registry', { size: 32 });

export async function platformPolicyWorld(t, { hosts = {} } = {}) {
  const admin = privateKeyToAccount(generatePrivateKey());
  const state = { hi: ZA, lo: ZA, down: false, hosts };
  const t0 = Date.now();
  // A numbered block must stay immutable when a quorum read crosses a wall-clock second.
  const blockAt = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1, { size: 32 })), timestamp: toHex(Math.floor(t0 / 1000) + (n - 1000)),
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
  const rpcServer = () => http.createServer((req, res) => {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      if (state.down) { res.writeHead(503); return res.end('down'); }
      let body; try { body = JSON.parse(Buffer.concat(c)); } catch { res.writeHead(400); return res.end(); }
      const one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: answer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: String(e.message) } }; } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  const rpcs = [rpcServer(), rpcServer(), rpcServer()];
  await Promise.all(rpcs.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  // the mirror: HTTPS with a throwaway CA (openssl), serving <digest>.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-world-'));
  const ossl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=policy-world-ca');
  ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=127.0.0.1');
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n');
  ossl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');
  const docs = new Map(), served = [];
  const mirror = https.createServer({ key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) }, (req, res) => {
    served.push(req.url); const m = /^\/policy\/(0x[0-9a-f]{64})\.json$/.exec(req.url || '');
    if (!m || !docs.has(m[1]) || state.mirrorDown) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(docs.get(m[1])));
  });
  await new Promise((r) => mirror.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of [...rpcs, mirror]) { s.closeAllConnections?.(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });
  const mirrorOrigin = `https://127.0.0.1:${mirror.address().port}/policy`;
  let seq = 0;
  // sign + publish + ANCHOR a non-expiring policy (what the admin does: sign, mirror, setMany)
  async function publish({ mode = 'denylist', deny = [], admit = [] } = {}) {
    seq++;
    const p = { format: POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REGISTRY, hostOwnership: OWNERSHIP, sequence: seq, issuedAt: Math.floor(Date.now() / 1000) - 5,
                expiresAt: 0, maxStaleSec: 0, previousDigest: Z32, mode, deny, admit };
    const digest = policyDigest(p);
    docs.set(digest, { document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) });
    const a = encodeAnchor(digest); state.hi = a.hi; state.lo = a.lo;
    return digest;
  }
  return {
    state, admin, served, publish,
    // the signed { document, signature } of a published digest (what a carrier would hold), and re-anchoring an older one
    document: (digest) => docs.get(digest) || null,
    anchor: (digest) => { const a = encodeAnchor(digest); state.hi = a.hi; state.lo = a.lo; },
    rpcs: rpcs.map((s) => `http://127.0.0.1:${s.address().port}`), mirrorOrigin, ca: path.join(dir, 'ca.pem'),
    config: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [mirrorOrigin] },
    env: (extra = {}) => ({ ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: BOOK, hostOwnership: OWNERSHIP, mirrors: [mirrorOrigin] }),
      ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rpcs.map((s) => `http://127.0.0.1:${s.address().port}`).join(','), NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem'), ...extra }),
    setDown: (v) => { state.down = !!v; },
    unanchor: () => { state.hi = ZA; state.lo = ZA; },
  };
}
