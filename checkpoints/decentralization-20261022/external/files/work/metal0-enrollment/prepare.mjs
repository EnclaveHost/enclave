import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,http,keccak256,toHex} from '../enclave/node_modules/viem/_esm/index.js';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
import {authorityReads} from '../enclave/scripts/independent-authorities.mjs';
import {prepareHostPolicy} from '../enclave/scripts/network/prepare-host-policy.mjs';
const deployed=JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/independent-authorities-base.json'));
const endpoint=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json')).publicUrl;
const owner=deployed.inputs.enclaveOwner.toLowerCase(),registry=deployed.inputs.registry.toLowerCase();
const policy={version:1,chainId:8453,ownershipContract:deployed.addresses.EnclaveHostOwnership.toLowerCase(),hostId:keccak256(toHex(endpoint)),requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]};
const clients=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'].map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
const quorum=createQuorumReader({clients,minAgree:3,chainId:8453,confirmations:2,timeoutMs:20000});
const reader={agreed:fn=>quorum((client,block)=>{
 const bound=authorityReads(client,block.blockHash);
 return fn({getCode:({address})=>bound.code(address),readContract:({address,abi,functionName,args=[]})=>bound.read(address,abi,functionName,args)},block.blockNumber);
})};
const prepared=await prepareHostPolicy({policy,owner,registry,reader});
assert.equal(prepared.observation.endpoint,endpoint);
// Compare against the previously verified deployment runtime hash.
const expected=deployed.verified.contracts.EnclaveHostOwnership;
assert.equal(prepared.observation.ownershipCodeHash,expected.codeHash);
const dir='outputs/metal0-host-enrollment';fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+'/transactions.json',JSON.stringify(prepared,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
fs.writeFileSync(dir+'/'+prepared.policyHash+'.json',JSON.stringify(policy,null,2)+'\n');
console.log(JSON.stringify({status:prepared.status,endpoint,hostId:policy.hostId,owner:prepared.observation.owner,pendingOwner:prepared.observation.pendingOwner,operator:prepared.observation.operator,steps:prepared.transactions.map(t=>t.purpose),block:String(prepared.observation.blockNumber)}));
