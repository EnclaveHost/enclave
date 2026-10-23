// Read-only corroboration: no private keys, signing, sends or contract changes.
import {createRequire} from 'node:module';import fs from 'node:fs';
const require=createRequire(new URL('../../enclave/package.json',import.meta.url));
const {createPublicClient,http,parseAbiItem}=require('viem');const {base}=require('viem/chains');
const outPath=new URL('../../../outputs/decentralization-audit/windows-node-renewal-chain-20261023.json',import.meta.url);
const observed=JSON.parse(fs.readFileSync(new URL('../../../outputs/decentralization-audit/windows-node-renewal-observation-20261023.json',import.meta.url)));
const ids=observed.current.map(x=>x.id);const started=1792718233n;
const urls=['https://base-rpc.polkachu.com','https://base.gateway.tenderly.co'];
const cs=urls.map(url=>createPublicClient({chain:base,transport:http(url,{timeout:15000,retryCount:0})}));
const renew=parseAbiItem('event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6)');
const paid=parseAbiItem('event LeaseGasPaid(bytes32 indexed id, address indexed owner, address indexed operator, address payee, uint8 kind, uint256 gas, uint256 gasPrice, uint256 l1FeeWei, uint256 chargedWei)');
const ledger='0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b',reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
const record={at:new Date().toISOString(),readOnly:true,authority:'Two-provider corroboration, not independent proof verification',rpc:urls,verified:false};
try {
 const heads=await Promise.all(cs.map(c=>c.getBlockNumber()));const to=heads.reduce((a,b)=>a<b?a:b)-2n;const from=to-600n;
 const rows=await Promise.all(cs.map(async c=>{const [r,p]=await Promise.all([c.getLogs({address:ledger,event:renew,args:{id:ids},fromBlock:from,toBlock:to}),c.getLogs({address:reserve,event:paid,args:{id:ids},fromBlock:from,toBlock:to})]);return {r,p};}));
 const serial=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
 const canonical=x=>x.map(l=>({blockHash:l.blockHash,blockNumber:l.blockNumber,transactionHash:l.transactionHash,logIndex:l.logIndex,args:l.args}));
 if(serial(canonical(rows[0].r))!==serial(canonical(rows[1].r))||serial(canonical(rows[0].p))!==serial(canonical(rows[1].p)))throw Error('providers disagree on logs');
 const matched=[];for(const l of rows[0].r){const p=rows[0].p.find(p=>p.transactionHash===l.transactionHash&&p.args.id===l.args.id);if(!p)continue;const block=await cs[0].getBlock({blockNumber:l.blockNumber});if(block.timestamp<=started)continue;if(block.hash!==l.blockHash)throw Error('block hash mismatch');matched.push({id:l.args.id,tx:l.transactionHash,block:l.blockNumber,timestamp:block.timestamp,leaseUntil:l.args.leaseUntil,kind:p.args.kind,operator:p.args.operator,chargedWei:p.args.chargedWei});}
 Object.assign(record,{fromBlock:from,toBlock:to,renewals:matched,verified:matched.length>0});
}catch(e){record.error=String(e.shortMessage||e.message).slice(0,500);}
fs.writeFileSync(outPath,JSON.stringify(record,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({verified:record.verified,renewals:record.renewals?.length||0,error:record.error}));process.exitCode=record.verified?0:1;
