import {AsnInventory} from './asn-inventory.mjs';
import path from 'node:path';
import {DurableState} from './durable-state.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export class ProviderInventory {
  constructor({binary,rpc,asnFile,directory=path.dirname(asnFile),runCommand=execute,now=Date.now,asnFetch,log=()=>{}}){Object.assign(this,{binary,rpc,asnFile,runCommand,now});this.nodes=[];this.pending=null;this.health=new DurableState(directory);this.asns=new AsnInventory({file:asnFile,fetchFn:asnFetch,now,log});this.log=log;}
  async observe(providers,{ok,latencyMs,role}){
    if(typeof ok!=='boolean')throw new Error('provider outcome required');
    await this.health.update('provider-health',old=>{
      const records=old||{};
      for(const [name,p] of Object.entries(providers)){
        if(role&&role!==name)continue;
        const key=name+':'+p.identity,prior=records[key],same=prior?.address===p.address&&prior?.beneficiary===p.beneficiary;
        const v=same?prior:{address:p.address,beneficiary:p.beneficiary,successes:0,failures:0};
        if(ok){v.successes++;if(Number.isFinite(latencyMs)&&latencyMs>=0)v.latencyMs=v.latencyMs===undefined?latencyMs:0.8*v.latencyMs+0.2*latencyMs;}else v.failures++;
        if(v.successes+v.failures>100){v.successes=Math.ceil(v.successes/2);v.failures=Math.ceil(v.failures/2);}
        v.updatedAt=this.now();records[key]=v;
      }
      for(const[key,v]of Object.entries(records))if(v.updatedAt+7*86400000<this.now())delete records[key];
      return records;
    });
  }
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const [{stdout},metadata,health]=await Promise.all([this.runCommand(this.binary,['--rpc',this.rpc.join(',')],{timeout:35000,maxBuffer:4*1024*1024}),this.asns.read(),this.health.get('provider-health')]);
      const nodes=JSON.parse(stdout);if(!Array.isArray(nodes)||nodes.length>10000)throw new Error('invalid provider inventory');
      void this.asns.refresh(nodes).catch(e=>this.log('ASN refresh: '+e.message));
      const counted=h=>h&&h.updatedAt+7*86400000>this.now()&&Number.isSafeInteger(h.successes)&&Number.isSafeInteger(h.failures)&&h.successes>=0&&h.failures>=0&&h.successes+h.failures>0;
      // Failures cluster by network and role (a whole ASN can refuse reverse
      // allocations). An untried node starts from its network's record for
      // that role instead of a neutral prior, so selection stops walking a
      // dead network one node at a time. A node's own record still wins.
      const networks={};
      for(const[key,h]of Object.entries(health||{})){
        const role=key.split(':')[0],asn=metadata[h?.address]?.asn;
        if(!['guard','public','egress','carry'].includes(role)||!counted(h)||!Number.isSafeInteger(asn))continue;
        const v=(networks[role+':'+asn]??={successes:0,failures:0});v.successes+=h.successes;v.failures+=h.failures;
      }
      this.nodes=nodes.map(n=>{
        const outcomes={},asn=metadata[n.address]?.asn;
        for(const role of ['guard','public','egress','carry']){
          const h=health?.[role+':'+n.identity],valid=counted(h)&&h.address===n.address&&h.beneficiary===n.beneficiary;
          const group=Number.isSafeInteger(asn)?networks[role+':'+asn]:undefined,trials=group?group.successes+group.failures:0;
          outcomes[role]={successRate:valid?h.successes/(h.successes+h.failures):0.5,known:!!valid,...(trials>=3?{networkRate:(group.successes+1)/(trials+2)}:{}),...(valid&&Number.isFinite(h.latencyMs)?{latencyMs:h.latencyMs}:{})};
        }
        return {...n,asn:metadata[n.address]?.asn,verifiedOperator:metadata[n.address]?.verifiedOperator,outcomes};
      });
      return this.nodes;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async get(){if(!this.nodes.length||this.nodes.every(n=>n.expiresAt<=this.now()+10000))await this.refresh();return this.nodes;}
}
