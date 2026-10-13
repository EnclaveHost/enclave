// The Network tab's hand-encoded EnclaveConnectivity calls (site/js/core/enclave-network.js) are byte-identical to viem's.
import test from 'node:test';import assert from 'node:assert/strict';
import {encodeFunctionData,parseAbi} from 'viem';
const abi=parseAbi(['function tunaPolicyDigest(bytes32,bytes32[],uint64,uint64,uint128) view returns (bytes32)','function authorizeTuna(bytes32,bytes32[],uint64,uint64,uint128,bytes)']);
test('tunaPolicyDigest and authorizeTuna calldata match the ABI encoding',async()=>{
 globalThis.window??={};globalThis.localStorage??={getItem:()=>null,setItem(){},removeItem(){}};globalThis.location??={search:'',hostname:'localhost',origin:'http://localhost'};
 const {tunaPolicyDigestCall,authorizeTunaCall}=await import('../site/js/core/enclave-network.js');
 const id='0x'+'ab'.repeat(32),providers=['0x'+'01'.repeat(32),'0x'+'02'.repeat(32)],a={id,providers,expires:1791900000,maxPricePerGiB6:50000,budget6:1000000};
 assert.equal(tunaPolicyDigestCall(a),encodeFunctionData({abi,functionName:'tunaPolicyDigest',args:[id,providers,1791900000n,50000n,1000000n]}));
 const sig='0x'+'cd'.repeat(65);
 assert.equal(authorizeTunaCall(a,sig),encodeFunctionData({abi,functionName:'authorizeTuna',args:[id,providers,1791900000n,50000n,1000000n,sig]}));
 assert.equal(authorizeTunaCall({...a,providers:[providers[0]]},sig),encodeFunctionData({abi,functionName:'authorizeTuna',args:[id,[providers[0]],1791900000n,50000n,1000000n,sig]}));
});
