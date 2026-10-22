// READ-ONLY: runtime code and implementation/book bindings of the reviewed session factories at one agreed block.
// Writes evidence/session-factory-identity.json and the public runtime bytes as a test fixture for the candidate.
import fs from 'node:fs';
import { keccak256, encodeFunctionData, decodeFunctionResult } from 'viem';
import { pinBlock, codeAt, agree } from '../../ledger17-migration/lib/live.mjs';
const abi = [{ type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
             { type: 'function', name: 'book', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const block = await pinBlock(), tag = '0x' + block.number.toString(16);
const call = async (to, fn) => decodeFunctionResult({ abi, functionName: fn, data: await agree('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn }) }, tag]) });
const out = { block: String(block.number), blockHash: block.hash, factories: {} }, fixture = {};
for (const f of ['0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c', '0xec9277a32f98ad3108747fe3da78c35e1bee097b']) {
  const impl = (await call(f, 'implementation')).toLowerCase();
  const [fc, ic] = [await codeAt(block, f), await codeAt(block, impl)];
  const book = (await call(impl, 'book')).toLowerCase();
  out.factories[f] = { codeHash: keccak256(fc), runtimeBytes: (fc.length - 2) / 2, implementation: impl, implementationCodeHash: keccak256(ic), implementationRuntimeBytes: (ic.length - 2) / 2, book };
  fixture[f] = fc; fixture[impl] = ic;
}
fs.writeFileSync(new URL('../evidence/session-factory-identity.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
fs.writeFileSync(new URL('../candidate/tree/test/fixtures/session-factory-runtimes.json', import.meta.url), JSON.stringify({ block: out.block, codes: fixture }) + '\n');
console.log(JSON.stringify(out, null, 1));
