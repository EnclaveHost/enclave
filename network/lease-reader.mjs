// Serving authorization comes from two independently configured chain RPCs at
// the same recent block. Nan is neither a bootstrap nor an admission dependency.
import {createPublicClient, http, stringToHex} from 'viem';
import {canonical} from './route-record.mjs';
import {guardedFetch} from './guarded-fetch.mjs';
const fields=[['id','bytes32'],['owner','address'],['appRef','string'],['ports','string'],['configCid','string'],['gpuMilli','uint16'],['cpuMilli','uint16'],['appPort','uint32'],['isPublic','bool'],['active','bool'],['createdAt','uint64'],['rate','uint256'],['balance6','uint256'],['spent6','uint256'],['runner','bytes32'],['runnerOperator','address'],['leaseUntil','uint64']];
const bookABI=[{type:'function',name:'addr',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'}]}];
const deploymentABI=[{type:'function',name:'get',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:fields.map(([name,type])=>({name,type}))}]}];
const schemaABI=[{type:'function',name:'deploymentsSchema',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}];
function jsonValue(value) {return JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));}
export class LeaseReader {
  constructor({rpc,chainId=8453,addressBook,maxBlockAgeMs=90000,confirmations=2,clients,proxy,now=Date.now}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addressBook||'') || !Number.isSafeInteger(chainId) || chainId<=0 ||
        !Number.isSafeInteger(maxBlockAgeMs) || maxBlockAgeMs<1000 || maxBlockAgeMs>120000 || !Number.isSafeInteger(confirmations) || confirmations<1) throw new Error('invalid chain policy');
    if (!clients && (!Array.isArray(rpc) || rpc.length<2 || new Set(rpc.map(s=>new URL(s).hostname)).size<2 || rpc.some(s=>new URL(s).protocol!=='https:'))) throw new Error('at least two independent HTTPS RPC origins required');
    Object.assign(this,{chainId,addressBook,maxBlockAgeMs,confirmations,now});
    this.clients=clients||rpc.map(url=>createPublicClient({transport:http(url,{timeout:14000,retryCount:0,...(proxy?{fetchFn:guardedFetch(proxy,{timeoutMs:6000})}:{})})}));
    this.lastBlock=0n;this.cache=new Map();
  }
  async refresh(ids) {
    if(!Array.isArray(ids)||ids.length>256||ids.some(id=>!/^0x[0-9a-f]{64}$/.test(id))) throw new Error('exact deployment ids required');
    this.failures=[];
    const heads=await Promise.allSettled(this.clients.map(async c=>{
      const [chainId,number]=await Promise.all([c.getChainId(),c.getBlockNumber({cacheTime:0})]);
      if(chainId!==this.chainId) throw new Error('wrong chain');
      return {client:c,number};
    }));
    const available=heads.filter(v=>v.status==='fulfilled').map(v=>v.value);
    if(available.length<2) throw new Error('chain quorum unavailable');
    // A stale outlier cannot keep fresh peers from forming a quorum. Conversely,
    // no one RPC can advance or renew a cached admission on its own.
    available.sort((a,b)=>a.number>b.number?-1:a.number<b.number?1:0);
    const blockNumber=available[1].number-BigInt(this.confirmations);
    if(blockNumber<this.lastBlock||blockNumber<0n)throw new Error('no fresh agreeing chain quorum');
    const failures=this.failures;
    const reads=available.map(async({client:c})=>{
      const block=await c.getBlock({blockNumber});
      const timestamp=Number(block.timestamp)*1000;
      if(!Number.isSafeInteger(timestamp)||timestamp>this.now()+5000||timestamp+this.maxBlockAgeMs<=this.now()) throw new Error('stale chain block');
      const deployments=await c.readContract({address:this.addressBook,abi:bookABI,functionName:'addr',args:[stringToHex('deployments',{size:32})],blockNumber});
      if(!/^0x[0-9a-fA-F]{40}$/.test(deployments)||/^0x0{40}$/i.test(deployments))throw new Error('no deployments contract');
      const schema=await c.readContract({address:deployments,abi:schemaABI,functionName:'deploymentsSchema',blockNumber});
      if(Number(schema)!==15)throw new Error('unsupported deployments schema');
      const rows=await Promise.all(ids.map(id=>c.readContract({address:deployments,abi:deploymentABI,functionName:'get',args:[id],blockNumber})));
      // Confirm the numbered block was not replaced while eth_call ran.
      if((await c.getBlock({blockNumber})).hash!==block.hash)throw new Error('chain reorganized during read');
      return {hash:block.hash,blockNumber:String(blockNumber),timestamp,deployments:deployments.toLowerCase(),rows:jsonValue(rows)};
    });
    // Read every candidate at the same block concurrently. A slow or faulty
    // third RPC cannot delay two agreeing peers, and a single peer never wins.
    const snapshot=await new Promise((resolve,reject)=>{
      const seen=new Map();let pending=reads.length;
      for(const read of reads)read.then(value=>{
        const key=canonical(value),prior=seen.get(key);if(prior)resolve(value);else seen.set(key,value);
      },e=>failures.push(String(e.shortMessage||e.message).slice(0,400))).finally(()=>{if(--pending===0)reject(new Error('no fresh agreeing chain quorum'));});
    });
    this.lastBlock=blockNumber;
    const result=snapshot.rows.map((row,index)=>{
      if(row.id.toLowerCase()!==ids[index]){this.cache.delete(ids[index]);this.failures.push('deployment not found: '+ids[index]);return null;}
      const leaseUntil=Number(row.leaseUntil)*1000;
      if(!Number.isSafeInteger(leaseUntil))throw new Error('invalid lease expiry');
      return {...row,id:row.id.toLowerCase(),runner:row.runner.toLowerCase(),leaseUntil,chainId:this.chainId,deployments:snapshot.deployments,
        blockNumber:snapshot.blockNumber,blockHash:snapshot.hash,blockTime:snapshot.timestamp,
        validUntil:Math.min(leaseUntil,snapshot.timestamp+this.maxBlockAgeMs)};
    });
    for(const row of result)if(row)this.cache.set(row.id,row);
    return result.filter(Boolean);
  }

  get(id) {const value=this.cache.get(id);return value&&value.validUntil>this.now()?structuredClone(value):null;}
}

export class AdmissionGate {
  constructor({runner,expected,now=Date.now}) {
    if(!/^0x[0-9a-f]{64}$/.test(runner||''))throw new Error('runner required');
    Object.assign(this,{runner,expected,now});this.leases=new Map();this.proofs=new Map();
  }
  observeLease(lease) {
    const old=this.leases.get(lease.id);
    if(old&&(old.runner!==lease.runner||old.appRef!==lease.appRef||old.configCid!==lease.configCid||old.owner!==lease.owner))this.proofs.delete(lease.id);
    this.leases.set(lease.id,structuredClone(lease));
  }
  async attest(id,verifyGuest) {
    const lease=this.leases.get(id),expected=this.expected(id);
    if(!lease||!expected||lease.runner!==this.runner||lease.validUntil<=this.now()||expected.appRef!==lease.appRef||expected.configCid!==lease.configCid) throw new Error('no matching current app expectation');
    const fingerprint=canonical(lease),startedAt=this.now();
    const verdict=await verifyGuest(id,expected);
    if(!verdict?.verified||verdict.deploymentId!==id||verdict.appSha256!==expected.appSha256||verdict.runtimeId!==expected.runtimeId||
      !/^[0-9a-f]{64}$/.test(verdict.spkiSha256||'')||canonical(this.leases.get(id))!==fingerprint)throw new Error('fresh bound guest proof required');
    this.proofs.set(id,{...verdict,validUntil:Math.min(startedAt+60000,lease.validUntil)});
  }
  allows(id) {
    const lease=this.leases.get(id),proof=this.proofs.get(id),expected=this.expected(id);
    return !!(lease&&proof&&expected&&lease.active&&lease.isPublic&&lease.runner===this.runner&&lease.validUntil>this.now()&&lease.leaseUntil>this.now()&&
      proof.validUntil>this.now()&&expected.appRef===lease.appRef&&expected.configCid===lease.configCid&&proof.appSha256===expected.appSha256&&proof.runtimeId===expected.runtimeId);
  }
  revoke(id) {this.proofs.delete(id);}
}
