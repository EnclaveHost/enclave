import fs from 'node:fs';
import {createPublicClient, http, keccak256} from './enclave/node_modules/viem/_esm/index.js';
import {agreedRead} from './enclave/network/service-index.mjs';
import {readSessionAuthority} from './enclave/network/session-authority.mjs';
const profile=JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/network-profile-base.json')).contracts;
const allowed=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call']);
const safeFetch=(url,init)=>{
  for(const r of [JSON.parse(init.body)].flat())if(!allowed.has(r.method))throw Error('audit forbids '+r.method);
  return fetch(url,init);
};
const peers=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public']
  .map(url=>({label:url,client:createPublicClient({transport:http(url,{fetchFn:safeFetch,timeout:12000,retryCount:0})})}));
const expected={deployments:profile.deployments.address,appCatalog:profile.appCatalog.address,usdc:profile.usdc.address};
const r=await agreedRead({peers,chainId:8453,deadlineMs:60000,requestTimeoutMs:12000,read:async(c,b)=>{
  const results={};
  for(const [name,implementationName] of [['legacySessionVaultFactory','legacySessionVaultImplementation'],
    ['sessionVaultFactory','sessionVaultImplementation']]){
    const value=await readSessionAuthority(c,b,{...expected,factory:profile[name].address});
    for(const n of [name,implementationName]){
      const code=await c.getCode({address:profile[n].address,blockNumber:b});
      if(!code||keccak256(code)!==profile[n].codeHash)throw Error(n+' code mismatch');
    }
    if(value.implementation.toLowerCase()!==profile[implementationName].address.toLowerCase())throw Error('wrong implementation');
    results[name]=value;
  }
  return results;
}});
const report={at:new Date().toISOString(),mode:'read-only, no signing or transactions',block:String(r.blockNumber),
  agreeingRPCs:r.evidence.peers.filter(p=>p.status==='agreed').map(p=>p.label),factories:r.value,
  scope:'Fresh binding resolution and runtime hashes for existing and optional factory/implementation; no production session opened.'};
fs.mkdirSync('outputs/existing-contract-sessions',{recursive:true});
fs.writeFileSync('outputs/existing-contract-sessions/live.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({block:report.block,factories:Object.keys(r.value),result:'pass'}));
