// Serving authorization comes from two independently configured chain RPCs at
// the same recent block. Nan is neither a bootstrap nor an admission dependency.
import {createPublicClient, http, stringToHex} from 'viem';
import {base} from 'viem/chains';
import {canonical} from './route-record.mjs';
import {readConnectivity} from './connectivity-chain.mjs';
import {guardedFetch} from './guarded-fetch.mjs';
const fields=[['id','bytes32'],['owner','address'],['appRef','string'],['ports','string'],['configCid','string'],['gpuMilli','uint16'],['cpuMilli','uint16'],['appPort','uint32'],['isPublic','bool'],['active','bool'],['createdAt','uint64'],['rate','uint256'],['balance6','uint256'],['spent6','uint256'],['runner','bytes32'],['runnerOperator','address'],['leaseUntil','uint64']];
const bookABI=[{type:'function',name:'addr',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'}]}];
const deploymentABI=[{type:'function',name:'get',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:fields.map(([name,type])=>({name,type}))}]}];
const schemaABI=[{type:'function',name:'deploymentsSchema',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}];
import {hostABI} from './registry-abi.mjs';
function jsonValue(value) {return JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));}
export class LeaseReader {
  constructor({rpc,chainId=8453,addressBook,maxBlockAgeMs=90000,confirmations=2,clients,proxy,includeHostPayout=false,includeConnectivity=false,now=Date.now}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addressBook||'') || !Number.isSafeInteger(chainId) || chainId<=0 ||
        !Number.isSafeInteger(maxBlockAgeMs) || maxBlockAgeMs<1000 || maxBlockAgeMs>120000 || !Number.isSafeInteger(confirmations) || confirmations<1) throw new Error('invalid chain policy');
    if (!clients && (!Array.isArray(rpc) || rpc.length<2 || new Set(rpc.map(s=>new URL(s).hostname)).size!==rpc.length || rpc.some(s=>new URL(s).protocol!=='https:'))) throw new Error('at least two independent HTTPS RPC origins required');
    Object.assign(this,{chainId,addressBook,maxBlockAgeMs,confirmations,includeHostPayout,includeConnectivity,now});
    // Public RPCs meter requests per second. Multicall3 folds a snapshot's
    // same-block reads into one eth_call each, however many apps it covers.
    this.clients=clients||rpc.map(url=>createPublicClient({chain:base,batch:{multicall:{wait:0}},
      transport:http(url,{timeout:14000,retryCount:0,...(proxy?{fetchFn:guardedFetch(proxy,{timeoutMs:6000})}:{})})}));
    this.lastBlock=0n;this.cache=new Map();this.retryDelayMs=400;
  }
  // Requests that arrive while a snapshot is queued join it: a burst of
  // publications costs one chain read, not one per app.
  refresh(ids) {
    if(!Array.isArray(ids)||ids.length>256||ids.some(id=>!/^0x[0-9a-f]{64}$/.test(id))) return Promise.reject(new Error('exact deployment ids required'));
    if(!this.queued||this.queued.ids.size+ids.length>256){
      const queued={ids:new Set()};
      queued.run=(this.pending||Promise.resolve()).then(()=>{if(this.queued===queued)this.queued=null;return this.readSnapshot([...queued.ids]);});
      this.pending=queued.run.catch(()=>{});this.queued=queued;
    }
    for(const id of ids)this.queued.ids.add(id);
    return this.queued.run.then(rows=>{const byId=new Map(rows.map(row=>[row.id,row]));return ids.map(id=>byId.get(id)).filter(Boolean);});
  }
  // Only a rate-limit refusal is retried, briefly; a timeout or a wrong answer is not.
  async limited(read) {
    for(let attempt=0;;attempt++){
      try{return await read();}
      catch(e){
        if(attempt>=2||!/rate limit|over rate|too many requests|compute units per second|\b429\b/i.test(String(e?.message)))throw e;
        await new Promise(r=>setTimeout(r,this.retryDelayMs*(attempt+1)*(1+Math.random())));
      }
    }
  }
  async readSnapshot(ids) {
    if(!Array.isArray(ids)||ids.length>256||ids.some(id=>!/^0x[0-9a-f]{64}$/.test(id))) throw new Error('exact deployment ids required');
    this.failures=[];
    const heads=await Promise.allSettled(this.clients.map(c=>this.limited(async()=>{
      const [chainId,number]=await Promise.all([c.getChainId(),c.getBlockNumber({cacheTime:0})]);
      if(chainId!==this.chainId) throw new Error('wrong chain');
      return {client:c,number};
    })));
    const available=heads.filter(v=>v.status==='fulfilled').map(v=>v.value);
    if(available.length<2) throw new Error('chain quorum unavailable');
    // A stale outlier cannot keep fresh peers from forming a quorum. Conversely,
    // no one RPC can advance or renew a cached admission on its own.
    available.sort((a,b)=>a.number>b.number?-1:a.number<b.number?1:0);
    // Peers' heads jitter by a block or two between back-to-back snapshots. Never
    // read below the block already accepted; reread it instead. The block-age
    // check below still decides whether that block is fresh enough.
    let blockNumber=available[1].number-BigInt(this.confirmations);
    if(blockNumber<0n)throw new Error('no fresh agreeing chain quorum');
    if(blockNumber<this.lastBlock)blockNumber=this.lastBlock;
    const failures=this.failures;
    const reads=available.map(({client:c})=>this.limited(async()=>{
      const block=await c.getBlock({blockNumber});
      const timestamp=Number(block.timestamp)*1000;
      if(!Number.isSafeInteger(timestamp)||timestamp>this.now()+5000||timestamp+this.maxBlockAgeMs<=this.now()) throw new Error('stale chain block');
      const deployments=await c.readContract({address:this.addressBook,abi:bookABI,functionName:'addr',args:[stringToHex('deployments',{size:32})],blockNumber});
      if(!/^0x[0-9a-fA-F]{40}$/.test(deployments)||/^0x0{40}$/i.test(deployments))throw new Error('no deployments contract');
      const schema=await c.readContract({address:deployments,abi:schemaABI,functionName:'deploymentsSchema',blockNumber});
      if(![15,16].includes(Number(schema))||(this.includeConnectivity===true&&Number(schema)!==16))throw new Error('unsupported deployments schema');
      let rows=await Promise.all(ids.map(id=>c.readContract({address:deployments,abi:deploymentABI,functionName:'get',args:[id],blockNumber})));
      if(this.includeHostPayout){
        const registry=await c.readContract({address:this.addressBook,abi:bookABI,functionName:'addr',args:[stringToHex('registry',{size:32})],blockNumber});
        await Promise.all(rows.map(async row=>{
          if(/^0x0{64}$/.test(row.runner))return;
          const host=await c.readContract({address:registry,abi:hostABI,functionName:'get',args:[row.runner],blockNumber});
          // Withhold only this app: a snapshot shared by many apps must not fail for one.
          if(!host.active||host.operator.toLowerCase()!==row.runnerOperator.toLowerCase()){row.runnerUnavailable=true;return;}
          row.runnerPayoutWallet=host.payoutWallet;row.runnerProofKey=host.proofKey;
        }));
      }
      if(this.includeConnectivity&&Number(schema)>=16){
        const address=await c.readContract({address:this.addressBook,abi:bookABI,functionName:'addr',args:[stringToHex('connectivity',{size:32})],blockNumber});
        rows=await readConnectivity(c,{address,deployments,rows,blockNumber});
        await Promise.all(rows.map(async row=>{row.bandwidthBackingRequired6=await c.readContract({address:deployments,abi:[{type:'function',name:'bandwidthBackingRequired6',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'uint256'}]}],functionName:'bandwidthBackingRequired6',args:[row.id],blockNumber});}));
      }
      // Confirm the numbered block was not replaced while eth_call ran.
      if((await c.getBlock({blockNumber})).hash!==block.hash)throw new Error('chain reorganized during read');
      return {hash:block.hash,blockNumber:String(blockNumber),timestamp,deployments:deployments.toLowerCase(),rows:jsonValue(rows)};
    }));
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
      if(row.runnerUnavailable){this.cache.delete(ids[index]);this.failures.push('inactive or changed runner: '+ids[index]);return null;}
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

// Only these say nothing about the guest: the transport between this host and
// it failed. Anything else (a mismatch, a refusal, an unknown error) revokes.
const transientCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ECONNABORTED']);
export function transientProofError(e) {
  return !!e&&(transientCodes.has(e.code)||e.message==='guest probe timeout'||/^guest (attestation|readiness) HTTP 5\d\d$/.test(e.message||''));
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
    if(verdict?.ready===false&&!(expected.requiresConfigSocketServer===true&&expected.requiresSecretsV1===true))throw new Error('startup proof requires a configured secret command');
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
  // A transient probe failure leaves the last proof to expire on its own
  // schedule (never extended); everything else revokes it now.
  failed(id,error) {const transient=transientProofError(error);if(!transient)this.revoke(id);return transient;}
}
