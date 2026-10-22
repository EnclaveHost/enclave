// READ-ONLY: enclavehost.eth's resolver and com.enclave.gateway text record, two Ethereum RPCs agreeing.
const viem = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/index.js');
const ens = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/ens/index.js');
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'];
const node = ens.namehash('enclavehost.eth');
const out = { node, nodeMatchesClientConstant: node.slice(2) === '7be524b52836196883ea721c416d415bf68439a07375d8ac6a236958ace32d7b', rpcs: {} };
for (const url of RPCS) {
  const c = viem.createPublicClient({ transport: viem.http(url, { timeout: 15000 }) });
  const block = await c.getBlockNumber();
  const resolver = await c.readContract({ address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', abi: viem.parseAbi(['function resolver(bytes32) view returns (address)', 'function owner(bytes32) view returns (address)']), functionName: 'resolver', args: [node] });
  const owner = await c.readContract({ address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', abi: viem.parseAbi(['function owner(bytes32) view returns (address)']), functionName: 'owner', args: [node] });
  const text = await c.readContract({ address: resolver, abi: viem.parseAbi(['function text(bytes32,string) view returns (string)']), functionName: 'text', args: [node, 'com.enclave.gateway'] });
  out.rpcs[new URL(url).host] = { block: Number(block), resolver, registryOwner: owner, gatewayRecord: text };
}
console.log(JSON.stringify(out, null, 1));
