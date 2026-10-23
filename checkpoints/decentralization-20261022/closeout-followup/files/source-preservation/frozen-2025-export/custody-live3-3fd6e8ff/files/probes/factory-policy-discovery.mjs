// Read-only discovery from both original vault deployment blocks; emits policy metadata, never bundle bodies.
import fs from 'node:fs';import {decodeEventLog,parseAbi} from 'viem';import {pinBlock,rpc,LIVE,readMany} from '../lib/live.mjs';
const root=new URL('../../custody-v2-durability-20261023/repo/contracts/deployments/',import.meta.url);
const files=['secret-vault-base.json','secret-vault-v2-base.json'];
const contracts=files.map(f=>JSON.parse(fs.readFileSync(new URL(f,root))));
const eventsAbi=parseAbi(['event PolicyUpdated(bytes32 indexed id,address indexed owner,uint64 policyRev,bytes32 committeeId,bool paused)','event PolicyClaimed(bytes32 indexed id,address indexed previousOwner,address indexed newOwner,uint64 policyRev)']);
const abi=parseAbi(['function policyOf(bytes32) view returns(address owner,uint64 policyRev,uint64 secretRev,bytes32 committeeId,bool paused,bytes rules)','function beneficialOwnerOf(bytes32) view returns(address)']);
const block=await pinBlock(),results=[];const deadline=Date.now()+360000;
for(const c of contracts){
 const byProvider=[];
 for(const url of LIVE.state){const seen=[];let complete=true,error=null;try{for(let from=BigInt(c.block);from<=block.number;from+=5000n){if(Date.now()>deadline)throw Error('bounded discovery deadline reached');let to=from+4999n;if(to>block.number)to=block.number;
  const raw=await rpc(url,'eth_getLogs',[{address:c.address,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}],{tries:1});
  for(const l of raw){try{const e=decodeEventLog({abi:eventsAbi,topics:l.topics,data:l.data});seen.push({id:e.args.id,block:l.blockNumber,tx:l.transactionHash,index:l.logIndex,event:e.eventName});}catch{}}
 }}catch(e){complete=false;error=e.message.slice(0,250);}byProvider.push({provider:new URL(url).host,complete,error,events:seen});}
 const ids=[...new Set(byProvider.flatMap(p=>p.events.map(e=>e.id)))];const rows=[];
 for(const id of ids){const r=await readMany(block,[{address:c.address,abi,functionName:'policyOf',args:[id]},{address:c.address,abi,functionName:'beneficialOwnerOf',args:[id]}]);const [owner,policyRev,secretRev,committeeId,paused]=r[0].value;rows.push({id,owner,policyRev,secretRev,committeeId,paused,beneficialOwner:r[1].value});}
 const agreed=byProvider.every(p=>p.complete)&&JSON.stringify(byProvider[0].events)===JSON.stringify(byProvider[1].events);
 results.push({vault:c.address,fromBlock:c.block,toBlock:block.number,byProvider,discoveryAgreed:agreed,policies:rows});console.log(JSON.stringify({vault:c.address,complete:byProvider.map(p=>p.complete),agreed,policies:rows.length}));
}
const out={at:new Date().toISOString(),readOnly:true,block,results,limits:['Log completeness remains dependent on RPC providers even when two agree. Current policy state is independently quorum-read. No bundle/rule values emitted or chain state changed.']};
fs.writeFileSync(new URL('../evidence/factory-policy-discovery.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
if(results.some(r=>!r.discoveryAgreed))process.exitCode=2;
