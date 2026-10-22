// Unsigned ServiceIndex update: operator 0xC9D0835C... slot 0 (kind directory) from the plain-HTTP :8188 origins to the
// literal-IP HTTPS origins served by the activated Caddy route. Run from the workspace root. NO key is read, nothing is
// signed or sent; every chain value comes from agreeing Base RPCs at one block (network/service-index.mjs agreedRead).
//   node work/directory-https-activation/service-index/prepare.mjs prepare   -> service-index/prepared.json (never replaced)
//   node work/directory-https-activation/service-index/prepare.mjs gates     -> service-index/gates.json; exit 0 only when
//        every activation prerequisite holds AND the prepared request is still exactly applicable (same sequence, fresh).
// Execution (root, after review, with its existing journaled signer flow) must run `gates` immediately before signing and
// sign exactly prepared.data to prepared.to from prepared.from with value 0; then reread the slot from agreeing RPCs.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPublicClient, http, keccak256, encodeFunctionData, formatEther, parseEther} from '../../enclave/node_modules/viem/_esm/index.js';
import {agreedRead, SERVICE_INDEX_ABI, SERVICE_KINDS, AD_VERSION, validateAdInput, validateIndexPin} from '../../enclave/network/service-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), CAND = path.dirname(HERE), WS = path.resolve(CAND, '../..');
const pin = validateIndexPin(JSON.parse(fs.readFileSync(path.join(WS, 'outputs/service-index/pin.json'))));
const OPERATOR = '0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB', SLOT = 0, KIND = 'directory', TTL_SEC = 30 * 86400;
const IPS = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];
const HOSTS = ['us-west', 'eu-central', 'ap-southeast', 'ca-east'];
const CURRENT_ENDPOINTS = IPS.map(ip => `http://${ip}:8188/`);
const NEXT_ENDPOINTS = IPS.map(ip => `https://${ip}/`);
const PREPARED = path.join(HERE, 'prepared.json'), GATES = path.join(HERE, 'gates.json');
const MAX_FEE = 12000000n, FEE_CAP = parseEther('0.00001'), EXECUTE_WITHIN_MS = 24 * 3600 * 1000;

// Proof guard: no Enclave origin, minipc/Nan or mutable address book participates in these reads.
let forbidden = 0;
const guarded = (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input.url || input);
  if (u.hostname === 'enclave.host' || u.hostname.endsWith('.enclave.host') || u.hostname === '62.238.4.214' ||
      String(init?.body || '').toLowerCase().includes('ab214342d5a490150a4a977063a2f88e21f80907')) { forbidden++; throw Error('denied by proof guard'); }
  return fetch(input, init);
};
const urls = ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base.public.blockpi.network/v1/rpc/public', 'https://mainnet.base.org'];
const peers = urls.map(url => ({label: new URL(url).origin, client: createPublicClient({transport: http(url, {fetchFn: guarded, retryCount: 0, timeout: 8000})})}));
const json = v => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x)));
const save = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', {flag: 'wx'}); fs.renameSync(tmp, file); };

async function readSlot() {
  const r = await agreedRead({peers, chainId: pin.chainId, read: async (c, blockNumber, call) => {
    const code = await call('code', () => c.getCode({address: pin.address, blockNumber}));
    if (!code || keccak256(code) !== pin.codeHash) throw Error('service-index runtime differs from the reviewed pin');
    const ad = await call('get', () => c.readContract({address: pin.address, abi: SERVICE_INDEX_ABI, functionName: 'get', args: [OPERATOR, SLOT], blockNumber}));
    const sequence = await call('sequenceOf', () => c.readContract({address: pin.address, abi: SERVICE_INDEX_ABI, functionName: 'sequenceOf', args: [OPERATOR, SLOT], blockNumber}));
    const balance = await call('balance', () => c.getBalance({address: OPERATOR, blockNumber}));
    return json({codeHash: keccak256(code), ad, sequence, balance});
  }});
  const agreeing = r.evidence.peers.filter(p => p.status === 'agreed').map(p => p.label);
  if (agreeing.length < 2) throw Error('fewer than two agreeing RPCs');
  return {block: String(r.blockNumber), blockHash: r.blockHash, timestamp: String(r.timestamp), agreeing, ...r.value};
}

// The current ad must be exactly the reviewed sequence-1 plain-HTTP ad: no silent fallback, no changed authority.
function checkCurrent(s, {expectSequence} = {}) {
  const a = s.ad, problems = [];
  if (a.operator.toLowerCase() !== OPERATOR.toLowerCase()) problems.push('slot holder is not the reviewed operator');
  if (Number(a.slot) !== SLOT || Number(a.kind) !== SERVICE_KINDS[KIND] || Number(a.version) !== AD_VERSION) problems.push('slot/kind/version changed');
  if (String(a.sequence) !== String(s.sequence)) problems.push('get().sequence differs from sequenceOf()');
  if (expectSequence !== undefined && String(s.sequence) !== String(expectSequence)) problems.push(`sequence is ${s.sequence}, prepared for ${expectSequence}`);
  if (BigInt(a.expiresAt) <= BigInt(s.timestamp)) problems.push('current ad expired');
  return problems;
}

async function prepare() {
  if (fs.existsSync(PREPARED)) throw Error('a prepared request exists; review it (or delete it deliberately), never replace it silently');
  const s = await readSlot();
  const problems = checkCurrent(s);
  if (JSON.stringify(s.ad.endpoints) !== JSON.stringify(CURRENT_ENDPOINTS)) problems.push('current endpoints are not the reviewed plain-HTTP origins: ' + JSON.stringify(s.ad.endpoints));
  if (problems.length) throw Error('refused: ' + problems.join('; '));
  const ad = validateAdInput({slot: SLOT, kind: KIND, ttlSec: TTL_SEC, descriptor: s.ad.descriptor, endpoints: NEXT_ENDPOINTS});
  const sequence = BigInt(s.sequence) + 1n, expiresAt = BigInt(Math.floor(Date.now() / 1000) + ad.ttlSec);
  const args = [ad.slot, ad.kind, AD_VERSION, sequence, expiresAt, ad.descriptor, ad.endpoints];
  const data = encodeFunctionData({abi: SERVICE_INDEX_ABI, functionName: 'publish', args});
  const gas = await peers[0].client.estimateGas({account: OPERATOR, to: pin.address, data});
  const gasLimit = gas * 130n / 100n;
  if (gasLimit * MAX_FEE > FEE_CAP) throw Error('gas budget exceeds the reviewed cap');
  const at = new Date();
  const p = {
    schema: 'enclave-service-index-unsigned-publish/1', at: at.toISOString(), unsigned: true, signed: false, broadcast: false,
    chainId: pin.chainId, to: pin.address, codeHash: pin.codeHash, from: OPERATOR, value: '0', function: 'publish(uint8,uint16,uint16,uint64,uint64,bytes32,string[])',
    current: {block: s.block, blockHash: s.blockHash, blockTimestamp: s.timestamp, agreeingRPCs: s.agreeing, sequence: String(s.sequence), expiresAt: String(s.ad.expiresAt),
      updatedAt: String(s.ad.updatedAt), observedTtlSec: Number(BigInt(s.ad.expiresAt) - BigInt(s.ad.updatedAt)), descriptor: s.ad.descriptor, endpoints: s.ad.endpoints},
    next: {operator: OPERATOR, slot: SLOT, kind: KIND, kindId: ad.kind, version: AD_VERSION, sequence: String(sequence), expiresAt: String(expiresAt), ttlSec: ad.ttlSec,
      descriptor: ad.descriptor, endpoints: ad.endpoints},
    data, dataKeccak: keccak256(data), gasEstimate: String(gas), gasLimit: String(gasLimit), maxFeePerGas: String(MAX_FEE), maxPriorityFeePerGas: '1000000',
    maxExecutionFeeETH: formatEther(gasLimit * MAX_FEE), operatorBalanceWei: String(s.balance), operatorBalanceSufficient: BigInt(s.balance) >= gasLimit * MAX_FEE,
    executeNotAfter: new Date(at.getTime() + EXECUTE_WITHIN_MS).toISOString(),
    preconditions: [
      'A1: activation/journal.jsonl shows verified-active for all four hosts under the reviewed manifest sha256 (host before-hash guard, caddy validate, reload, local readback)',
      'A2: live public readback (activation/public-readback.mjs --expect active) passes for all four https origins at gate time',
      'A3: agreeing RPCs still show sequence ' + String(s.sequence) + ', the same operator/slot/kind/version/descriptor and endpoints ' + JSON.stringify(CURRENT_ENDPOINTS),
      'A4: executed before executeNotAfter (else re-prepare: expiresAt would no longer carry the reviewed 30-day TTL)',
      'A5: signed by the same operator key with the reviewed fee caps; the transaction publishes exactly `data`; reread from agreeing RPCs after the receipt'],
    notice: 'Same operator, same slot, sequence+1, same descriptor and 30-day TTL as sequence 1; only the endpoints change to the HTTPS origins. These remain Enclave-operated directories advertised as untrusted candidates; one operator is one participant whatever number of endpoints it lists.'};
  save(PREPARED, p);
  console.log(JSON.stringify({...p, data: `[${data.length} hex chars, keccak ${p.dataKeccak}]`}, null, 2));
}

function manifestDigest() {
  const r = spawnSync('python3', [path.join(CAND, 'activation/activate.py'), 'plan'], {encoding: 'utf8'});
  const m = /manifest sha256 ([0-9a-f]{64})/.exec(r.stdout || ''); if (!m) throw Error('activation manifest unavailable');
  return m[1];
}

async function gates() {
  const p = JSON.parse(fs.readFileSync(PREPARED, 'utf8')), out = {at: new Date().toISOString(), gates: {}}, problems = [];
  const expected = encodeFunctionData({abi: SERVICE_INDEX_ABI, functionName: 'publish',
    args: [p.next.slot, p.next.kindId, p.next.version, BigInt(p.next.sequence), BigInt(p.next.expiresAt), p.next.descriptor, p.next.endpoints]});
  if (expected !== p.data || keccak256(p.data) !== p.dataKeccak || p.to !== pin.address || p.from !== OPERATOR || JSON.stringify(p.next.endpoints) !== JSON.stringify(NEXT_ENDPOINTS))
    problems.push('prepared request altered');
  // A1
  const digest = manifestDigest();
  let rows = []; try { rows = fs.readFileSync(path.join(CAND, 'activation/journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const verified = HOSTS.filter(h => { const last = rows.filter(r => r.host === h).at(-1); return last?.event === 'verified-active' && rows.some(r => r.host === h && r.run === last.run && r.manifest === digest); });
  out.gates.A1 = {manifest: digest, verifiedHosts: verified, ok: verified.length === HOSTS.length};
  // A2
  out.gates.A2 = {hosts: {}};
  // The active-mode readback sends an invalid POST; before A1 holds that would reach the production control API. Skip.
  if (!out.gates.A1.ok) { out.gates.A2 = {skipped: 'A1 not met: no live POST probe before activation', ok: false}; }
  else for (const ip of IPS) {
    const r = spawnSync('node', [path.join(CAND, 'activation/public-readback.mjs'), ip, '--expect', 'active'], {encoding: 'utf8', timeout: 180000,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)))});
    let res = null; try { res = JSON.parse(r.stdout); } catch {}
    out.gates.A2.hosts[ip] = {ok: !!res?.ok, checks: res?.checks, error: res?.error};
  }
  if (out.gates.A1.ok) out.gates.A2.ok = Object.values(out.gates.A2.hosts).every(h => h.ok);
  // A3
  const s = await readSlot();
  const cur = checkCurrent(s, {expectSequence: p.current.sequence});
  if (JSON.stringify(s.ad.endpoints) !== JSON.stringify(p.current.endpoints) || s.ad.descriptor !== p.current.descriptor) cur.push('current ad changed since preparation');
  out.gates.A3 = {block: s.block, blockHash: s.blockHash, agreeingRPCs: s.agreeing, sequence: String(s.sequence), problems: cur, ok: cur.length === 0};
  // A4
  out.gates.A4 = {executeNotAfter: p.executeNotAfter, ok: Date.now() < Date.parse(p.executeNotAfter)};
  out.ok = !problems.length && forbidden === 0 && ['A1', 'A2', 'A3', 'A4'].every(g => out.gates[g].ok);
  out.problems = problems; out.forbiddenAttempts = forbidden;
  fs.writeFileSync(GATES, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'prepare') await prepare(); else if (mode === 'gates') await gates(); else { console.error('mode: prepare | gates'); process.exit(2); }
if (forbidden) { console.error('forbidden dependency attempted'); process.exit(3); }
