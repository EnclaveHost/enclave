import fs from 'node:fs';
import {parseAbi,stringToHex,keccak256,decodeFunctionData,decodeFunctionResult} from './enclave/node_modules/viem/_esm/index.js';
import {LeaseReader} from './enclave/network/lease-reader.mjs';
const p=JSON.parse(fs.readFileSync('outputs/adapter-release/transactions.json')),h=JSON.parse(fs.readFileSync('outputs/host-ownership-release/transaction.json'));
const ca=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveAppCatalog.abi.json')),la=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveDeployments.abi.json'));
const reader=new LeaseReader({rpc:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],addressBook:'0xab214342d5A490150A4A977063A2f88E21F80907'});
const pub=p.transactions[0],appId=p.newAppRef.split('/')[2];
const observation=await reader.agreed(async(c,blockNumber)=>{
 const [d,n,a,registry,catalog,ledger]=await Promise.all([
 c.readContract({address:p.transactions[1].to,abi:la,functionName:'get',args:[p.deployment],blockNumber}),
 c.readContract({address:pub.to,abi:ca,functionName:'numVersions',args:[appId],blockNumber}),
 c.readContract({address:pub.to,abi:ca,functionName:'getApp',args:[appId],blockNumber}),
 ...['registry','appCatalog','deployments'].map(key=>c.readContract({address:reader.addressBook,abi:parseAbi(['function addr(bytes32) view returns(address)']),functionName:'addr',args:[stringToHex(key,{size:32})],blockNumber}))]);
 const code=await c.getCode({address:registry,blockNumber});
 const wanted=structuredClone(p.deploymentConfig);delete wanted.config.upload.walletAudience; const actual=JSON.parse(d.configCid); if(actual.config===undefined){const oldVersion=await c.readContract({address:pub.to,abi:ca,functionName:'getVersion',args:[appId,15n],blockNumber});actual.config=JSON.parse(oldVersion.config);} const differences=[]; function diff(a,b,path=''){if(JSON.stringify(a)===JSON.stringify(b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],path+'.'+k);}else differences.push(path);}diff(actual,wanted);
 return {owner:d.owner,appRef:d.appRef,active:d.active,versionCount:Number(n),publisher:a.publisher,configUnchanged:differences.length===0,changedConfigPaths:differences,registry,catalog,ledger,registryCodeHash:keccak256(code)};
});
if(observation.owner.toLowerCase()!==pub.from.toLowerCase()||observation.publisher.toLowerCase()!==pub.from.toLowerCase()||observation.appRef!==p.oldAppRef||observation.versionCount!==16||!observation.configUnchanged||observation.registry.toLowerCase()!==h.authorityObservation.registry||observation.registryCodeHash!==h.authorityObservation.registryCodeHash||observation.catalog.toLowerCase()!==pub.to.toLowerCase()||observation.ledger.toLowerCase()!==p.transactions[1].to.toLowerCase())throw Error('Prepared requests differ from live chain: '+JSON.stringify(observation));
const estimates=[];
for(const tx of [...p.transactions,h.transaction]){
 const request={account:tx.from,...(tx.to?{to:tx.to}:{}),data:tx.data,value:0n};
 const gas=await reader.clients[0].estimateGas(request); estimates.push(gas.toString());
 if(tx===pub){const result=await reader.clients[0].call(request);const decoded=decodeFunctionResult({abi:ca,functionName:'publishVersion',data:result.data});if(Number(decoded[1])!==16)throw Error('publication index changed');}
}
const out={checkedAt:new Date().toISOString(),status:'freshly-validated-unsigned',observation,estimatedGas:estimates,nonce:await reader.clients[0].getTransactionCount({address:pub.from,blockTag:'pending'}),notes:['No signature requested or transaction broadcast.','Upgrade remains gated on confirmed approved publication.']};
fs.writeFileSync('outputs/wallet-signing-preflight.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
