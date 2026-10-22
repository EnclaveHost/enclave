// Read-only production audit. RPC transport rejects every write/sign method.
import fs from 'node:fs';
import {createPublicClient, http, parseAbi, keccak256, encodeFunctionData, stringToHex} from './enclave/node_modules/viem/_esm/index.js';
import {agreedRead} from './enclave/network/service-index.mjs';
const profile = JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/network-profile-base.json'));
const admin = '0x0b2d009c0c9af05b12100d77f3c815fea822ee61';
const stranger = '0x000000000000000000000000000000000000dead';
const methods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode']);
const counts = {};
const safeFetch = (input, init) => {
  const messages = JSON.parse(init.body);
  for (const m of Array.isArray(messages) ? messages : [messages]) {
    if (!methods.has(m.method)) throw Error('audit forbids RPC method ' + m.method);
    counts[m.method] = (counts[m.method] || 0) + 1;
  }
  return fetch(input, init);
};
const urls = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.public.blockpi.network/v1/rpc/public'];
const peers = urls.map(url => ({label: new URL(url).origin, client: createPublicClient({
  batch: {multicall: {wait: 0}}, transport: http(url, {fetchFn: safeFetch, retryCount: 0, timeout: 12000}),
})}));
const owned = parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)']);
const operations = {
  deployments: ['function setPayout(address)', 'setPayout', [admin]],
  appCatalog: ['function setMaxFee(uint256)', 'setMaxFee', [1389n]],
  proofOfTime: ['function setProofWindow(uint64)', 'setProofWindow', [600n]],
  enclavePay: ['function setPayout(address)', 'setPayout', [admin]],
  keyAttestations: ['function setAttestor(address,bool)', 'setAttestor', [stranger, false]],
};
const json = v => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x));
const results = {};
for (const [name, [signature, fn, args]] of Object.entries(operations)) {
  const contract = profile.contracts[name], abi = parseAbi([signature]);
  const result = await agreedRead({peers, chainId: 8453, deadlineMs: 60000, requestTimeoutMs: 12000,
    read: async (c, blockNumber, call) => {
      const [owner, pending, code] = await Promise.all([
        call('owner', () => c.readContract({address: contract.address, abi: owned, functionName: 'owner', blockNumber})),
        call('pendingOwner', () => c.readContract({address: contract.address, abi: owned, functionName: 'pendingOwner', blockNumber})),
        call('code', () => c.getCode({address: contract.address, blockNumber})),
      ]);
      if (owner.toLowerCase() !== admin || !/^0x0{40}$/i.test(pending)) throw Error(name + ': admin ownership differs');
      if (!code || keccak256(code) !== contract.codeHash) throw Error(name + ': runtime differs');
      const data = encodeFunctionData({abi, functionName: fn, args});
      await call('admin simulation', () => c.call({account: admin, to: contract.address, data, blockNumber}));
      let denied = false;
      try { await call('stranger simulation', () => c.call({account: stranger, to: contract.address, data, blockNumber})); }
      catch (e) { if (/revert/i.test(e.message)) denied = true; else throw e; }
      if (!denied) throw Error(name + ': unauthorized caller unexpectedly accepted');
      return {address: contract.address, owner: owner.toLowerCase(), pendingOwner: pending,
        codeHash: keccak256(code), simulatedAdminFunction: fn, adminAccepted: true, unauthorizedCallerRejected: true};
    }});
  results[name] = {block: String(result.blockNumber), ...result.value,
    agreeingRPCs: result.evidence.peers.filter(p => p.status === 'agreed').map(p => p.label)};
  console.log(JSON.stringify({contract: name, block: String(result.blockNumber), adminAccepted: true, unauthorizedCallerRejected: true}));
}
const report = {at: new Date().toISOString(), mode: 'read-only eth_call simulations; no transaction signed or sent',
  admin, contracts: results, rpcMethodCounts: counts,
  limits: ['Covers ownership, runtime identity and one real admin operation per listed contract.',
    'Does not yet prove every UI/CLI admin feature or platform-wide host-ban enforcement.']};
fs.mkdirSync('outputs/admin-control-audit', {recursive: true});
fs.writeFileSync('outputs/admin-control-audit/live.json', JSON.stringify(json(report), null, 2) + '\n');
