// READ-ONLY history and cross-checks for enclavehost.eth on ETHEREUM MAINNET:
//   - agreement of more independent keyless RPCs at one agreed block (eth_call capable only);
//   - when each current value became current (binary search over archive state; assumes no A->B->A in between), the
//     value just before, and the exact transaction (eth_getLogs on that single block);
//   - DNS records stored in ENS for the name (EnclaveDNS answers those first);
//   - runtime code identity of the name's resolver vs the resolver ENS itself names at resolver.eth.
import { createRequire } from 'node:module';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http, namehash, labelhash, keccak256, toHex, parseAbi, encodeFunctionData, decodeFunctionResult, decodeEventLog, bytesToHex } = require('viem');
const NAME = 'enclavehost.eth', node = namehash(NAME), label = labelhash('enclavehost');
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io', 'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io', 'https://rpc.mevblocker.io', 'https://eth.blockrazor.xyz', 'https://ethereum.rpc.subquery.network/public'];
const REG = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', BASE = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
const RES = '0xF29100983E058B709F3D539b0c765937B804AC15', ENS_PUBLIC = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
const ABI = parseAbi(['function owner(bytes32) view returns (address)', 'function resolver(bytes32) view returns (address)',
  'function contenthash(bytes32) view returns (bytes)', 'function text(bytes32,string) view returns (string)', 'function addr(bytes32) view returns (address)',
  'function nameExpires(uint256) view returns (uint256)', 'function dnsRecord(bytes32,bytes32,uint16) view returns (bytes)',
  'function hasDNSRecords(bytes32,bytes32) view returns (bool)', 'function zonehash(bytes32) view returns (bytes)',
  'event Transfer(bytes32 indexed node, address owner)', 'event NewResolver(bytes32 indexed node, address resolver)',
  'event NewOwner(bytes32 indexed node, bytes32 indexed label, address owner)',
  'event ContenthashChanged(bytes32 indexed node, bytes hash)', 'event AddrChanged(bytes32 indexed node, address a)',
  'event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)',
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)',
  'event VersionChanged(bytes32 indexed node, uint64 newVersion)', 'event DNSRecordChanged(bytes32 indexed node, bytes name, uint16 resource, bytes record)',
  'event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)', 'event NameRenewed(uint256 indexed id, uint256 expires)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const out = { name: NAME, node, at: new Date().toISOString(), rpcs: {} };
const clients = RPCS.map((url) => ({ url, c: createPublicClient({ transport: http(url, { timeout: 25_000, retryCount: 1 }) }) }));

// 1. agreement: every eth_call-capable provider at one block (min head - 8), same block hash, same answers
const live = [];
for (const r of clients) { try { const [id, h] = await Promise.all([r.c.getChainId(), r.c.getBlockNumber()]); out.rpcs[r.url] = { chainId: id, head: Number(h) }; if (id === 1) live.push({ ...r, head: h }); } catch (e) { out.rpcs[r.url] = { error: String(e.shortMessage || e.message).slice(0, 120) }; } }
const B = live.reduce((m, r) => (r.head < m ? r.head : m), live[0].head) - 8n;
const call = async (c, to, fn, args, blockNumber) => { const data = encodeFunctionData({ abi: ABI, functionName: fn, args }); const r = await c.call({ to, data, blockNumber }); return r.data ? decodeFunctionResult({ abi: ABI, functionName: fn, data: r.data }) : null; };
const probes = { owner: [REG, 'owner', [node]], resolver: [REG, 'resolver', [node]], contenthash: [RES, 'contenthash', [node]], addr: [RES, 'addr', [node]],
  'text name': [RES, 'text', [node, 'name']], 'text avatar': [RES, 'text', [node, 'avatar']], 'text url': [RES, 'text', [node, 'url']], nameExpires: [BASE, 'nameExpires', [BigInt(label)]] };
const agree = { block: Number(B), perRpc: {} };
for (const r of live) {
  const row = agree.perRpc[r.url] = {};
  try { row.blockHash = (await r.c.getBlock({ blockNumber: B })).hash; } catch (e) { row.blockHash = 'error'; }
  for (const [k, [to, fn, args]] of Object.entries(probes)) { try { const v = await call(r.c, to, fn, args, B); row[k] = typeof v === 'bigint' ? v.toString() : v; } catch (e) { row[k] = 'ERR ' + String(e.shortMessage || e.message).slice(0, 80); } }
}
const capable = Object.entries(agree.perRpc).filter(([, v]) => !String(v.owner).startsWith('ERR') && v.blockHash !== 'error');
const sig = (v) => JSON.stringify(Object.fromEntries(Object.entries(v)));
const groups = {}; for (const [u, v] of capable) (groups[sig(v)] ||= []).push(u);
agree.capableProviders = capable.map(([u]) => u);
agree.identicalAnswerGroups = Object.values(groups);
agree.allCapableAgree = Object.keys(groups).length === 1;
out.agreement = agree;

// 2. history: when did each current value become current (archive eth_call), and by which transaction
// the first capable provider that serves ARCHIVE state at the search floor
let H = null; out.archiveProbe = {};
for (const [u] of capable) { const c = live.find((r) => r.url === u).c; try { await call(c, BASE, 'nameExpires', [BigInt(label)], 18_000_000n); H = c; out.archiveProvider = u; break; } catch (e) { out.archiveProbe[u] = String(e.shortMessage || e.message).slice(0, 80); } }
if (!H) { H = live.find((r) => r.url === capable[0][0]).c; out.archiveProvider = 'none (history unavailable)'; }
const hist = {};
async function since(key, to, fn, args, lo) {
  const cur = JSON.stringify(await call(H, to, fn, args, B), (k, v) => typeof v === 'bigint' ? v.toString() : v);
  const at = async (b) => { try { return JSON.stringify(await call(H, to, fn, args, BigInt(b)), (k, v) => typeof v === 'bigint' ? v.toString() : v); } catch (e) { return 'ERR ' + String(e.shortMessage || e.message).slice(0, 60); } };
  const atLo = await at(lo);
  if (atLo.startsWith('ERR')) return { key, error: 'archive state not served at ' + lo + ': ' + atLo };
  if (atLo === cur) return { key, current: cur, sinceBlock: `<= ${lo} (unchanged since the search floor)` };
  let a = lo, b = Number(B);                                     // value(a) != cur, value(b) == cur
  while (b - a > 1) { const m = Math.floor((a + b) / 2); if ((await at(m)) === cur) b = m; else a = m; }
  const before = await at(a);
  let tx = null;
  try {
    const logs = await H.request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(b), toBlock: toHex(b) }] });
    tx = logs.filter((l) => [REG, RES, BASE].map((x) => x.toLowerCase()).includes(l.address.toLowerCase()) && (l.topics.includes(node) || l.topics.includes(label)))
      .map((l) => { let ev; try { const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); ev = { event: d.eventName, args: JSON.parse(JSON.stringify(d.args, (k, v) => typeof v === 'bigint' ? v.toString() : v)) }; } catch { ev = { event: 'undecoded', topic0: l.topics[0] }; }
        return { tx: l.transactionHash, contract: l.address, ...ev }; });
  } catch (e) { tx = 'logs error ' + String(e.shortMessage || e.message).slice(0, 80); }
  let txFrom = null;
  if (Array.isArray(tx) && tx[0]) { try { const t = await H.getTransaction({ hash: tx[0].tx }); const blk = await H.getBlock({ blockNumber: BigInt(b) }); txFrom = { from: t.from, to: t.to, blockTime: new Date(Number(blk.timestamp) * 1000).toISOString() }; } catch {} }
  return { key, current: cur, becameCurrentAtBlock: b, valueBefore: before, events: tx, tx: txFrom };
}
const FLOOR = 18_000_000;                                        // 2023-08; F291.. and this registration are later
for (const [k, [to, fn, args]] of Object.entries(probes)) hist[k] = await since(k, to, fn, args, FLOOR);
out.history = hist;

// 3. DNS records stored in ENS (dnsRecord: node, keccak256(DNS-wire name), RR type) for the apex and api/mcp
const wire = (n) => bytesToHex(Uint8Array.from([...n.split('.').flatMap((l) => [l.length, ...new TextEncoder().encode(l)]), 0]));
const dns = {};
for (const n of ['enclavehost.eth', 'api.enclavehost.eth', 'mcp.enclavehost.eth', '_dnslink.enclavehost.eth']) {
  const nh = keccak256(wire(n)); dns[n] = {};
  try { dns[n].hasDNSRecords = await call(H, RES, 'hasDNSRecords', [node, nh], B); } catch (e) { dns[n].hasDNSRecords = 'ERR ' + String(e.shortMessage || e.message).slice(0, 60); }
  for (const [t, code] of [['A', 1], ['AAAA', 28], ['TXT', 16], ['CNAME', 5]]) { try { const v = await call(H, RES, 'dnsRecord', [node, nh, code], B); if (v && v !== '0x') dns[n][t] = v; } catch (e) { dns[n][t] = 'ERR'; } }
}
try { dns.zonehash = await call(H, RES, 'zonehash', [node], B); } catch (e) { dns.zonehash = 'ERR'; }
for (const n of ['api.enclavehost.eth', 'mcp.enclavehost.eth', 'app.enclavehost.eth']) { try { dns['registry.owner ' + n] = await call(H, REG, 'owner', [namehash(n)], B); dns['registry.resolver ' + n] = await call(H, REG, 'resolver', [namehash(n)], B); } catch {} }
out.dnsInEns = dns;

// 4. resolver code identity
const code = async (a) => { const c = await H.getCode({ address: a, blockNumber: B }); return { bytes: (c.length - 2) / 2, keccak: keccak256(c) }; };
out.resolverCode = { nameResolver: { address: RES, ...(await code(RES)) }, resolverEthNamedPublicResolver: { address: ENS_PUBLIC, ...(await code(ENS_PUBLIC)) } };
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
