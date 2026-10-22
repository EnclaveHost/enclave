// READ-ONLY ENS diagnosis of enclavehost.eth on ETHEREUM MAINNET (chainId 1; not Base). Public keyless RPCs only;
// every value is read at ONE agreed block whose hash must match across the providers, and a value counts only when
// every answering provider returns the same bytes. No key, wallet, signature or transaction. Uses main's viem.
//   node ens-resolve.mjs > out/resolve.json
import { createRequire } from 'node:module';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http, namehash, labelhash, keccak256, toHex, toBytes, parseAbi, encodeFunctionData,
  decodeFunctionResult, decodeEventLog, bytesToHex, hexToBytes, getAddress } = require('viem');

const NAME = 'enclavehost.eth';
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth.llamarpc.com',
  'https://cloudflare-eth.com', 'https://rpc.flashbots.net'];
const ENS = {
  registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',   // ENSRegistryWithFallback
  baseRegistrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
  nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
};
const ABI = parseAbi([
  'function owner(bytes32) view returns (address)', 'function resolver(bytes32) view returns (address)',
  'function ttl(bytes32) view returns (uint64)', 'function recordExists(bytes32) view returns (bool)',
  'function ownerOf(uint256) view returns (address)', 'function nameExpires(uint256) view returns (uint256)',
  'function available(uint256) view returns (bool)',
  'function getData(uint256) view returns (address owner, uint32 fuses, uint64 expiry)',
  'function supportsInterface(bytes4) view returns (bool)', 'function contenthash(bytes32) view returns (bytes)',
  'function addr(bytes32) view returns (address)', 'function text(bytes32,string) view returns (string)',
  'function name(bytes32) view returns (string)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'event Transfer(bytes32 indexed node, address owner)', 'event NewResolver(bytes32 indexed node, address resolver)',
  'event NewTTL(bytes32 indexed node, uint64 ttl)',
  'event ContenthashChanged(bytes32 indexed node, bytes hash)', 'event AddrChanged(bytes32 indexed node, address a)',
  'event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)',
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key)',
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)',
  'event VersionChanged(bytes32 indexed node, uint64 newVersion)', 'event NameChanged(bytes32 indexed node, string name)',
  'event ABIChanged(bytes32 indexed node, uint256 indexed contentType)', 'event PubkeyChanged(bytes32 indexed node, bytes32 x, bytes32 y)',
  'event DNSRecordChanged(bytes32 indexed node, bytes name, uint16 resource, bytes record)',
  'event NameWrapped(bytes32 indexed node, bytes name, address owner, uint32 fuses, uint64 expiry)',
  'event NameUnwrapped(bytes32 indexed node, address owner)', 'event FusesSet(bytes32 indexed node, uint32 fuses)',
  'event ExpiryExtended(bytes32 indexed node, uint64 expiry)',
  'event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)',
  'event NameRenewed(uint256 indexed id, uint256 expires)',
]);
const IFACES = { 'ERC-165': '0x01ffc9a7', 'contenthash (ENSIP-7)': '0xbc1c58d1', 'text (ENSIP-5)': '0x59d1d43c',
  'addr (ENSIP-1)': '0x3b3b57de', 'addr multicoin (ENSIP-9)': '0xf1cb7e06', 'IExtendedResolver (ENSIP-10)': '0x9061b923',
  'name': '0x691f3431', 'dnsRecord': '0xa8fa5682' };
const TEXT_KEYS = ['url', 'description', 'avatar', 'header', 'email', 'notice', 'keywords', 'location', 'name', 'display',
  'com.github', 'com.twitter', 'org.telegram', 'com.discord', 'dnslink', 'ipfs', 'api', 'site'];

// DNS wire format of the name (ENSIP-10): length-prefixed labels, then a zero byte
const dnsEncode = (n) => bytesToHex(Uint8Array.from([...n.split('.').flatMap((l) => [l.length, ...new TextEncoder().encode(l)]), 0]));
const node = namehash(NAME), label = labelhash('enclavehost'), dnsName = dnsEncode(NAME);
const clients = RPCS.map((url) => ({ url, c: createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 1 }) }) }));
const out = { name: NAME, chain: 'ethereum mainnet (chainId 1)', node, labelhash: label, dnsEncodedName: dnsName, rpcs: {},
  at: new Date().toISOString() };

// 1. providers, chain id, head; the agreed block = min head - 8, and its hash must match
const live = [];
for (const r of clients) {
  try {
    const [id, head] = await Promise.all([r.c.getChainId(), r.c.getBlockNumber()]);
    out.rpcs[r.url] = { chainId: id, head: Number(head) };
    if (id === 1) live.push({ ...r, head });
  } catch (e) { out.rpcs[r.url] = { error: String(e.shortMessage || e.message).slice(0, 160) }; }
}
const B = live.reduce((m, r) => (r.head < m ? r.head : m), live[0].head) - 8n;
const hashes = {};
for (const r of live) { try { hashes[r.url] = (await r.c.getBlock({ blockNumber: B })).hash; } catch (e) { hashes[r.url] = 'error ' + String(e.shortMessage || e.message).slice(0, 80); } }
const byHash = {};
for (const [u, h] of Object.entries(hashes)) (byHash[h] ||= []).push(u);
const [agreedHash, agreeing] = Object.entries(byHash).filter(([h]) => h.startsWith('0x')).sort((a, b) => b[1].length - a[1].length)[0];
out.block = { number: Number(B), hash: agreedHash, agreeing, perRpc: hashes };
if (agreeing.length < 2) { out.error = 'fewer than 2 providers agree on the block'; console.log(JSON.stringify(out, null, 1)); process.exit(2); }
const Q = live.filter((r) => agreeing.includes(r.url));

// a read at B on every agreeing provider; the value counts only if all answers are identical
async function q(label, to, fn, args) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const answers = {};
  for (const r of Q) {
    try { const res = await r.c.call({ to, data, blockNumber: B }); answers[r.url] = { ok: true, data: res.data ?? '0x' }; }
    catch (e) { answers[r.url] = { ok: false, error: String(e.shortMessage || e.details || e.message).slice(0, 200), revert: e.cause?.data ?? e.data ?? null }; }
  }
  const keys = new Set(Object.values(answers).map((a) => JSON.stringify(a.ok ? a.data : 'REVERT')));
  const first = Object.values(answers)[0];
  let value = null;
  if (first.ok && first.data !== '0x') { try { value = decodeFunctionResult({ abi: ABI, functionName: fn, data: first.data }); } catch (e) { value = 'undecodable: ' + first.data; } }
  return { label, agree: keys.size === 1, ok: first.ok, raw: first.ok ? first.data : null, value: typeof value === 'bigint' ? value.toString() : value,
    error: first.ok ? null : first.error, perRpc: keys.size === 1 ? undefined : answers };
}
const R = {};
const set = (k, v) => { R[k] = v; return v; };
const regOwner = set('registry.owner', await q('registry.owner(node)', ENS.registry, 'owner', [node]));
const resolver = set('registry.resolver', await q('registry.resolver(node)', ENS.registry, 'resolver', [node]));
set('registry.ttl', await q('registry.ttl(node)', ENS.registry, 'ttl', [node]));
set('registry.recordExists', await q('registry.recordExists(node)', ENS.registry, 'recordExists', [node]));
set('registry.owner(eth)', await q('registry.owner(namehash(eth))', ENS.registry, 'owner', [namehash('eth')]));
set('baseRegistrar.ownerOf', await q('baseRegistrar.ownerOf(labelhash)', ENS.baseRegistrar, 'ownerOf', [BigInt(label)]));
const exp = set('baseRegistrar.nameExpires', await q('baseRegistrar.nameExpires(labelhash)', ENS.baseRegistrar, 'nameExpires', [BigInt(label)]));
set('baseRegistrar.available', await q('baseRegistrar.available(labelhash)', ENS.baseRegistrar, 'available', [BigInt(label)]));
if (regOwner.value && getAddress(regOwner.value) === getAddress(ENS.nameWrapper)) {
  set('nameWrapper.getData', await q('nameWrapper.getData(node)', ENS.nameWrapper, 'getData', [BigInt(node)]));
  set('nameWrapper.ownerOf', await q('nameWrapper.ownerOf(node)', ENS.nameWrapper, 'ownerOf', [BigInt(node)]));
}
// the ENS-operated name resolver.eth names the current public resolver (chain-authoritative, no docs needed)
const rr = await q('registry.resolver(resolver.eth)', ENS.registry, 'resolver', [namehash('resolver.eth')]);
R['resolver.eth resolver'] = rr;
if (rr.value && rr.value !== '0x0000000000000000000000000000000000000000') R['resolver.eth addr (current public resolver)'] = await q('addr(resolver.eth)', rr.value, 'addr', [namehash('resolver.eth')]);
const RES = resolver.value;
out.reads = R;
const rec = {};
if (RES && RES !== '0x0000000000000000000000000000000000000000') {
  rec.supports = {};
  for (const [k, id] of Object.entries(IFACES)) { const r = await q('supportsInterface ' + k, RES, 'supportsInterface', [id]); rec.supports[k] = r.ok ? r.value : 'revert'; }
  rec.contenthash = await q('contenthash(node)', RES, 'contenthash', [node]);
  rec.addr = await q('addr(node)', RES, 'addr', [node]);
  rec.name = await q('name(node)', RES, 'name', [node]);
  rec.text = {};
  for (const k of TEXT_KEYS) { const r = await q('text ' + k, RES, 'text', [node, k]); if (!r.ok || (r.value && r.value !== '')) rec.text[k] = r; }
  // ENSIP-10 path (what wildcard/CCIP-aware clients call): resolve(dnsName, contenthash(node)); ccipRead is not followed
  const inner = encodeFunctionData({ abi: ABI, functionName: 'contenthash', args: [node] });
  rec.ensip10ResolveContenthash = await q('resolve(dnsName, contenthash(node))', RES, 'resolve', [dnsName, inner]);
}
out.records = rec;

// 2. record history (logs) for this node: resolver, registry, wrapper; registrar by labelhash id
async function logs(address, topics, label, from = 0n) {
  const res = {};
  for (const r of Q) {
    try {
      const raw = await r.c.request({ method: 'eth_getLogs', params: [{ address, topics, fromBlock: toHex(from), toBlock: toHex(B) }] });
      res[r.url] = raw; break;                          // one provider that serves the full range is enough for history
    } catch (e) { res[r.url] = 'error ' + String(e.shortMessage || e.details || e.message).slice(0, 140); }
  }
  const got = Object.entries(res).find(([, v]) => Array.isArray(v));
  const decoded = got ? got[1].map((l) => {
    let ev = null; try { const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); ev = { event: d.eventName, args: JSON.parse(JSON.stringify(d.args, (k, v) => typeof v === 'bigint' ? v.toString() : v)) }; } catch { ev = { event: 'unknown', topic0: l.topics[0] }; }
    return { block: Number(l.blockNumber), tx: l.transactionHash, ...ev };
  }) : null;
  return { label, servedBy: got ? got[0] : null, attempts: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Array.isArray(v) ? `${v.length} log(s)` : v])), logs: decoded };
}
const H = {};
if (RES && RES !== '0x0000000000000000000000000000000000000000') H.resolver = await logs(RES, [null, node], 'resolver events for the node');
H.registry = await logs(ENS.registry, [null, node], 'registry events for the node');
H.registryNewOwner = await logs(ENS.registry, [null, namehash('eth'), label], 'registry NewOwner(eth, label)');
H.nameWrapper = await logs(ENS.nameWrapper, [null, node], 'NameWrapper events for the node');
H.baseRegistrar = await logs(ENS.baseRegistrar, [null, label], 'base registrar events for the label id');
out.history = H;
out.expiry = exp.value ? { nameExpires: Number(exp.value), iso: new Date(Number(exp.value) * 1000).toISOString(),
  gracePeriodEndsIso: new Date((Number(exp.value) + 90 * 86400) * 1000).toISOString() } : null;
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
