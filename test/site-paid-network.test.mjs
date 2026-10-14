// The Network tab's hand-encoded EnclaveConnectivity calls (site/js/core/enclave-network.js) are byte-identical to viem's.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {encodeFunctionData} from 'viem';
// the compiled contract's own ABI, so a renamed or re-typed function fails here, not on chain
const abi=JSON.parse(fs.readFileSync(new URL('../contracts/EnclaveConnectivity.abi.json',import.meta.url),'utf8'));
test('providerPolicyDigest and authorizeProviders calldata match the ABI encoding',async()=>{
 globalThis.window??={};globalThis.localStorage??={getItem:()=>null,setItem(){},removeItem(){}};globalThis.location??={search:'',hostname:'localhost',origin:'http://localhost'};
 const {providerPolicyDigestCall,authorizeProvidersCall}=await import('../site/js/core/enclave-network.js');
 const id='0x'+'ab'.repeat(32),providers=['0x'+'01'.repeat(32),'0x'+'02'.repeat(32)],a={id,providers,expires:1791900000,maxPricePerGiB6:50000,budget6:1000000};
 assert.equal(providerPolicyDigestCall(a),encodeFunctionData({abi,functionName:'providerPolicyDigest',args:[id,providers,1791900000n,50000n,1000000n]}));
 const sig='0x'+'cd'.repeat(65);
 assert.equal(authorizeProvidersCall(a,sig),encodeFunctionData({abi,functionName:'authorizeProviders',args:[id,providers,1791900000n,50000n,1000000n,sig]}));
 assert.equal(authorizeProvidersCall({...a,providers:[providers[0]]},sig),encodeFunctionData({abi,functionName:'authorizeProviders',args:[id,[providers[0]],1791900000n,50000n,1000000n,sig]}));
});
