import test from 'node:test';import assert from 'node:assert/strict';import {encodeAbiParameters,keccak256,hashMessage} from 'viem';
import {networkAmount6,showNetworkAmount,networkPolicyDigest,networkPasskeyDigest,verifyNetworkPrepare} from '../site/js/core/network-controls.js';
import {directPolicyFromLease,assertDirectChoice} from '../network/connectivity-control.mjs';
test('browser bandwidth signature commits to the exact owner, contract, nonce and limits',()=>{
 const v={connectivity:'0x'+'11'.repeat(20),ledger:'0x'+'22'.repeat(20),id:'0x'+'aa'.repeat(32),owner:'0x'+'33'.repeat(20),nonce:4n,expires:1800000000,maxPricePerGiB6:1000000n,budget6:2500000n};
 const types=['string','uint256','address','address','bytes32','address','uint64','uint64','uint64','uint128'].map(type=>({type}));
 assert.equal(networkPolicyDigest(v),keccak256(encodeAbiParameters(types,['EnclaveConnectivity.policy.v1',8453n,v.connectivity,v.ledger,v.id,v.owner,v.nonce,BigInt(v.expires),v.maxPricePerGiB6,v.budget6])));
 assert.notEqual(networkPolicyDigest(v),networkPolicyDigest({...v,budget6:2500001n}));
});
test('bandwidth limits use exact USDC decimals and reject exponent or excess precision',()=>{
 for(const s of ['0','0.000001','1','1000','2.123456'])assert.equal(showNetworkAmount(networkAmount6(s)),s);
 for(const s of ['1e6','-1','0.0000001','NaN','Infinity',' 1'])assert.throws(()=>networkAmount6(s));
});
test('on-chain owner choice survives file-free enrollment and cannot be fabricated or replayed after revocation',()=>{
 const lease={id:'0x'+'ab'.repeat(32),owner:'0x'+'11'.repeat(20),connectivity:{address:'0x'+'22'.repeat(20),owner:'0x'+'11'.repeat(20),nonce:1,expires:200,maxPricePerGiB6:0,budget6:0}};
 const policy=directPolicyFromLease(lease,100000);assert.equal(policy.mode,'direct');assertDirectChoice(policy,lease,100000);
 assert.throws(()=>assertDirectChoice({...policy,budget6:'1'},lease,100000),/authorization/);
 lease.connectivity.expires=0;assert.equal(directPolicyFromLease(lease,100000),null);assert.throws(()=>assertDirectChoice(policy,lease,100000),/authorization/);
});

test('passkey challenge matches ERC-1271 and refuses substituted budgets or destinations',()=>{
 const current={address:'0x'+'11'.repeat(20),ledger:'0x'+'22'.repeat(20),id:'0x'+'aa'.repeat(32),owner:'0x'+'33'.repeat(20),nonce:3n};
 const intent={expires:'1800000000',maxPricePerGiB6:'1000000',budget6:'2500000'};
 const raw=networkPolicyDigest({...current,connectivity:current.address,nonce:4n,...intent});
 const digest=networkPasskeyDigest(raw);assert.equal(digest,hashMessage({raw}));
 const prep={...current,vault:current.owner,chainId:8453,nonce:'4',...intent,digest};
 assert.equal(verifyNetworkPrepare(prep,current,intent),digest);
 for(const change of [{budget6:'2500001'},{nonce:'5'},{address:current.owner},{digest:'0x'+'00'.repeat(32)}])assert.throws(()=>verifyNetworkPrepare({...prep,...change},current,intent));
});

test('expired direct authorization remains a blocked direct choice until the owner explicitly revokes it',()=>{
 const lease={id:'0x'+'ab'.repeat(32),owner:'0x'+'11'.repeat(20),connectivity:{address:'0x'+'22'.repeat(20),owner:'0x'+'11'.repeat(20),nonce:1,expires:100,maxPricePerGiB6:0,budget6:0}};
 const expired=directPolicyFromLease(lease,200000);assert.equal(expired.mode,'direct');assert.throws(()=>assertDirectChoice(expired,lease,200000),/authorization/);
});

test('TUNA browser and passkey authorizations bind the complete provider path',async()=>{
 const {networkTunaPolicyDigest,encodeTunaAuthorization}=await import('../site/js/core/network-controls.js');
 const {encodeFunctionData,parseAbi}=await import('viem');
 const current={address:'0x'+'11'.repeat(20),ledger:'0x'+'22'.repeat(20),id:'0x'+'aa'.repeat(32),owner:'0x'+'33'.repeat(20),nonce:3n};
 const intent={mode:'tuna',providers:['0x'+'bb'.repeat(32),'0x'+'cc'.repeat(32)],expires:'1800000000',maxPricePerGiB6:'1000000',budget6:'2500000'};
 const raw=networkTunaPolicyDigest({...current,connectivity:current.address,nonce:4n,...intent});
 const types=['string','uint256','address','address','bytes32','address','uint64','bytes32[]','uint64','uint64','uint128'].map(type=>({type}));
 assert.equal(raw,keccak256(encodeAbiParameters(types,['EnclaveConnectivity.tuna-policy.v1',8453n,current.address,current.ledger,current.id,current.owner,4n,intent.providers,1800000000n,1000000n,2500000n])));
 const signature='0x'+'12'.repeat(65);
 assert.equal(encodeTunaAuthorization(current.id,intent.providers,intent.expires,intent.maxPricePerGiB6,intent.budget6,signature),encodeFunctionData({abi:parseAbi(['function authorizeTuna(bytes32,bytes32[],uint64,uint64,uint128,bytes)']),functionName:'authorizeTuna',args:[current.id,intent.providers,1800000000n,1000000n,2500000n,signature]}));
 const prep={...current,vault:current.owner,chainId:8453,nonce:'4',...intent,digest:hashMessage({raw})};
 assert.equal(verifyNetworkPrepare(prep,current,intent),prep.digest);
 for(const change of [{mode:'direct'},{providers:intent.providers.slice().reverse()},{providers:[intent.providers[0]]}])assert.throws(()=>verifyNetworkPrepare({...prep,...change},current,intent));
 assert.throws(()=>networkTunaPolicyDigest({...current,connectivity:current.address,nonce:4n,...intent,providers:[intent.providers[0],intent.providers[0]]}));
});
test('USDC TUNA authorization cannot turn into free direct or native-NKN fallback',async()=>{
 const {appPolicy}=await import('../network/route-publisher.mjs');
 const lease={id:'0x'+'ab'.repeat(32),owner:'0x'+'11'.repeat(20),connectivity:{viaTuna:true,address:'0x'+'22'.repeat(20),owner:'0x'+'11'.repeat(20),nonce:1,expires:100,maxPricePerGiB6:1,budget6:1}};
 assert.equal(directPolicyFromLease(lease),null);
 await assert.rejects(appPolicy({deploymentId:lease.id},lease,{}),/USDC TUNA transport/);
});


test('relay TUNA authorization uses the same provider list and bounds as the browser',async()=>{
 const {networkArgs}=await import('../relay/vaultsvc.js');
 const intent={id:'0x'+'aa'.repeat(32),mode:'tuna',providers:['0x'+'bb'.repeat(32)],expires:'1800000000',maxPricePerGiB6:'1000000',budget6:'2500000'};
 assert.deepEqual(networkArgs(intent),[intent.id,intent.providers,1800000000n,1000000n,2500000n]);
 for(const changes of [{providers:[]},{providers:[intent.providers[0],intent.providers[0]]},{mode:'direct'},{mode:'revoke',providers:undefined},{maxPricePerGiB6:String(1n<<64n)},{budget6:String(1n<<128n)}])assert.throws(()=>networkArgs({...intent,...changes}));
});
