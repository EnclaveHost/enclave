// read-only: the legacy session vault's free balance (what withdraw can release) at an agreed block
import { pinBlock, readMany } from '../lib/live.mjs';
import { parseAbi } from 'viem';
const V = '0xB794C4DD0e1C5E6B72281799F282BfdE7654345D', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const block = await pinBlock();
const abi = parseAbi(['function locked6() view returns (uint256)', 'function owner() view returns (address)', 'function balanceOf(address) view returns (uint256)']);
const r = await readMany(block, [{ address: V, abi, functionName: 'locked6', allowFailure: true }, { address: V, abi, functionName: 'owner' }, { address: USDC, abi, functionName: 'balanceOf', args: [V] }]);
console.log(JSON.stringify({ block: String(block.number), locked6: r[0].ok ? String(r[0].value) : 'no getter', owner: r[1].value, usdc6: String(r[2].value) }));
