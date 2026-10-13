import fs from 'node:fs';import {decodeEventLog} from 'viem';
const abi=n=>JSON.parse(fs.readFileSync(new URL(`../contracts/${n}.abi.json`,import.meta.url)));
const depAbi=abi('EnclaveDeployments'),proofAbi=abi('EnclaveProofOfTime'),auditAbi=abi('EnclaveAvailability');
const lower=x=>String(x).toLowerCase();
/** Replay a finalized window. Work comes from paired RunnerCredited and
 * Checkpointed events, not queue claims or the host's utilization endpoint.
 * Archive reads must succeed; no latest-state substitution on RPC failure.
 * classifier supplies independently checked catalog compatibility for queued
 * jobs (or returns null to conservatively exclude them).
 */
export async function collectLedgerWindow({client,ledger,proof,availability,windowSec,classId,
 resource='cpu',knownVerificationAppRefs=[],classifyQueued=async()=>null,maxDeployments=10000}) {
 if(!['cpu','gpu'].includes(resource)||typeof windowSec!=='bigint'||windowSec<=0n)throw new Error('invalid observation window');
 const head=await client.getBlock({blockTag:'finalized'});
 if(!head?.hash||head.number===null)throw new Error('finalized block unavailable');
 const end=head.number,startTime=head.timestamp>windowSec?head.timestamp-windowSec:0n;
 let lo=0n,hi=end;
 while(lo<hi){const mid=(lo+hi)/2n,b=await client.getBlock({blockNumber:mid});if(b.timestamp<startTime)lo=mid+1n;else hi=mid;}
 const from=lo,before=from>0n?from-1n:0n;
 const read=(address,abi,functionName,args,blockNumber=end)=>client.readContract({address,abi,functionName,args,blockNumber});
 if(lower(await read(availability,auditAbi,'ledger',[]))!==lower(ledger))throw new Error('wrong accounting ledger');
 if(lower(await read(ledger,depAbi,'prover',[]))!==lower(proof)||!await read(ledger,depAbi,'proofRequired',[]))throw new Error('proven-service accounting required');
 const state=new Map();
 async function page(blockNumber) {
  const code=await client.getCode({address:ledger,blockNumber});if(!code||code==='0x')return [];
  const all=[];
  for(let n=0;n<maxDeployments;n+=100) {
   const rows=await read(ledger,depAbi,'getPage',[BigInt(n),100n],blockNumber);all.push(...rows);
   if(rows.length<100)return all;
  }throw new Error('deployment scan exceeds configured bound');
 }
 for(const d of await page(before)) {
  const [runnerRate6]=await read(ledger,depAbi,'earnOf',[d.id],before);state.set(lower(d.id),{...d,runnerRate6});
 }
 const logs=[];
 for(let b=from;b<=end;b+=1000n)logs.push(...await client.getLogs({address:[ledger,proof],fromBlock:b,toBlock:b+999n<end?b+999n:end}));
 logs.sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.logIndex-b.logIndex);
 const decoded=logs.map(l=>{try{return {...l,event:decodeEventLog({abi:lower(l.address)===lower(ledger)?depAbi:proofAbi,data:l.data,topics:l.topics})};}catch{return null;}}).filter(Boolean);
 const checkpoints=new Map();
 for(const l of decoded)if(lower(l.address)===lower(proof)&&l.event.eventName==='Checkpointed') {
  const key=l.transactionHash+':'+lower(l.event.args.id);
  const list=checkpoints.get(key)||[];list.push({index:l.logIndex,upto:l.event.args.provenUntil});checkpoints.set(key,list);
 }
 const services=[],verificationIds=new Set();
 async function isVerification(id,appRef) {
  if(knownVerificationAppRefs.includes(appRef)||await read(availability,auditAbi,'fundedJob',[id])){verificationIds.add(lower(id));return true;}
  return false;
 }
 for(const l of decoded) {
  if(lower(l.address)!==lower(ledger))continue;
  const {eventName:name,args:a}=l.event,id=a.id?lower(a.id):null;
  if(name==='ProofRequiredFromSet')throw new Error('proof policy changed within observation window');
  if(name==='Created')state.set(id,{...a,id,runner:'0x'+'00'.repeat(32),runnerOperator:'0x'+'00'.repeat(20),runnerRate6:0n});
  const d=state.get(id);if(!d)continue;
  if(name==='RunnerRateSet')d.runnerRate6=a.runnerRate6??a.rate6;
  if(name==='Claimed'){d.runner=a.enclaveId;d.runnerOperator=a.operator;}
  if(name==='SharesSet'){d.cpuMilli=a.cpuMilli;d.gpuMilli=a.gpuMilli;}
  if(name==='DeploymentTransferred')d.owner=a.to;
  if(name==='AppRefSet')d.appRef=a.appRef;
  if(name!=='RunnerCredited'||a.amount6===0n||!d.runnerRate6)continue;
  if(await isVerification(id,d.appRef))continue;
  const matches=checkpoints.get(l.transactionHash+':'+id)||[];
  const cp=matches.find(c=>c.index>l.logIndex);if(!cp)continue;
  matches.splice(matches.indexOf(cp),1);
  let seconds=a.amount6/d.runnerRate6;
  if(seconds>a.secondsCredited)seconds=a.secondsCredited;
  if(seconds===0n)continue;
  services.push({classId,hostId:lower(d.runner),deploymentId:id,owner:lower(d.owner),
   eventId:`${l.blockHash}:${l.logIndex}`,startSec:cp.upto-seconds,endSec:cp.upto,
   shareMilli:BigInt(resource==='cpu'?d.cpuMilli:d.gpuMilli),paid6:a.amount6});
 }
 const queued=[];
 for(const d of await page(end)) {
  if(await isVerification(d.id,d.appRef)||!d.active||d.leaseUntil>head.timestamp||d.balance6===0n)continue;
  const compatibility=await classifyQueued(d,{blockNumber:end});if(compatibility?.classId!==classId)continue;
  const [,escrow6]=await read(ledger,depAbi,'earnOf',[d.id]);
  queued.push({id:lower(d.id),owner:lower(d.owner),classId,active:true,leased:false,compatible:true,
   requestedUnits:compatibility.requestedUnits,backedBalance6:escrow6<d.balance6?escrow6:d.balance6});
 }
 const again=await client.getBlock({blockNumber:end});if(again.hash!==head.hash)throw new Error('finalized observation changed');
 return {atSec:head.timestamp,windowSec,classId,services,queued,verificationIds,
  checkpoint:{blockNumber:end,blockHash:head.hash,fromBlock:from}};
}
