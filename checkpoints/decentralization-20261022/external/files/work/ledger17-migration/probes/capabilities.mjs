import { pinBlock, codeAt } from '../lib/live.mjs';
import { keccak256, toFunctionSelector } from 'viem';
const block = await pinBlock();
const proxy = await codeAt(block, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
console.log('block', block.number, 'create2 proxy bytes', (proxy.length - 2) / 2, 'codeHash', keccak256(proxy));
const sels = { 'execute(address,uint256,bytes)': 0, 'executeBatch((address,uint256,bytes)[])': 0, 'execute(bytes32,bytes)': 0, 'executeBatch(address[],uint256[],bytes[])': 0, 'execute((address,uint256,bytes)[])': 0, 'executeCalls((address,uint256,bytes)[])': 0 };
for (const d of ['0x7179b77479c797bcf93361f0c3fab663d37f28d1', '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b', '0xeca6644333d3a069001203ce5416914a4d830beb']) {
  const c = (await codeAt(block, d)).toLowerCase();
  const found = Object.keys(sels).filter((s) => c.includes('63' + toFunctionSelector(s).slice(2)));
  console.log(d, (c.length - 2) / 2, 'bytes', 'codeHash', c.length > 2 ? keccak256(c) : null, 'exec selectors:', found.join(' | ') || 'none of the probed');
}
