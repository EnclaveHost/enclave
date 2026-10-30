import {parseAbi} from 'viem';
const ZERO='0x'+'00'.repeat(20);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const LEDGER=parseAbi(['function deploymentsSchema() view returns (uint256)','function feeRouter() view returns (address)']);
const FEES=parseAbi([
 'function ledger() view returns (address)',
 'function proof() view returns (address)',
 'function policies(bytes32) view returns (address payer,address executor,address wallet,uint64 expires,uint64 epoch,uint16 revenueBps,uint16 maxCpuMilli,uint256 dailyCap6,uint256 jobCap6,uint256 maxRate6,uint256 available6,string appRef,string backend)'
]);
const args=c=>[c.id,c.enclaveId,c.upto,c.anchorBlock,c.anchorHash,c.sig];
/** Routing changes only the transaction recipient. The signed EIP-712 domain
 * remains the actual proof contract. Read failures fall back to ordinary proof
 * submission so an unavailable fee policy cannot stop an honest host earning.
 * Never retry an uncertain broadcast here; callers own the transaction queue.
 */
export async function planCheckpoints({client,ledger,proof,batch,nowSec=BigInt(Math.floor(Date.now()/1000)),onWarning=()=>{}}) {
 if(!batch.length)return [];
 const direct=[],plans=[];
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args});
 let router=null;
 try {
  if(BigInt(await read(ledger,LEDGER,'deploymentsSchema'))>=15n){
   const candidate=await read(ledger,LEDGER,'feeRouter');
   if(!same(candidate,ZERO)){
    const [boundLedger,boundProof]=await Promise.all([read(candidate,FEES,'ledger'),read(candidate,FEES,'proof')]);
    if(!same(boundLedger,ledger)||!same(boundProof,proof))throw Error('fee router proof/ledger mismatch');
    router=candidate;
   }
  }
 }catch(e){onWarning('Fee route unavailable; sending ordinary proofs: '+(e.shortMessage||e.message));}
 for(const cp of batch){
  let optedIn=false;
  if(router)try{
   const policy=await read(router,FEES,'policies',[cp.id]);
   optedIn=!same(policy[0],ZERO)&&!same(policy[1],ZERO)&&BigInt(policy[3])>nowSec&&Number(policy[5])>0;
  }catch(e){onWarning('Fee policy unavailable for '+cp.id+': '+(e.shortMessage||e.message));}
  if(optedIn)plans.push({address:router,functionName:'checkpoint',args:args(cp),ids:[cp.id]});
  else direct.push(cp);
 }
 // Keep ordinary batching intact; opted-in sources have individually bounded
 // wrappers, so a failed source does not invalidate unrelated proof updates.
 if(direct.length)plans.push({address:proof,functionName:direct.length===1?'checkpoint':'checkpointMany',args:direct.length===1?args(direct[0]):[direct],ids:direct.map(c=>c.id)});
 return plans;
}
