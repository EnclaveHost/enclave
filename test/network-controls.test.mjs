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
