// The Network tab's EIP-191 hash (site/js/core/eip191.js) must equal what wallets and vault contracts compute.
import test from 'node:test';import assert from 'node:assert/strict';
import {hashMessage} from 'viem';
import {eip191Hash} from '../site/js/core/eip191.js';
import {networkPolicyMessage,defaultNetworkPolicy} from '../network/network-policy-core.mjs';
test('eip191Hash matches viem hashMessage, including multi-byte text and a real policy message',()=>{
 for(const m of ['','hello','ünïcödé ✓',networkPolicyMessage(defaultNetworkPolicy('0x'+'ab'.repeat(32))),'x'.repeat(1000)])
  assert.equal(eip191Hash(m).toLowerCase(),hashMessage(m).toLowerCase(),m.slice(0,20));
});
