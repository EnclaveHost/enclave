import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export class ProviderInventory {
  constructor({binary,rpc,asnFile,now=Date.now}){Object.assign(this,{binary,rpc,asnFile,now});this.nodes=[];this.pending=null;}
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const [{stdout},file]=await Promise.all([execute(this.binary,['--rpc',this.rpc.join(',')],{timeout:35000,maxBuffer:4*1024*1024}),fs.readFile(this.asnFile,'utf8')]);
      const metadata=JSON.parse(file);
      if(!Number.isSafeInteger(metadata.expiresAt)||metadata.expiresAt<=this.now()||!metadata.addresses)throw new Error('ASN inventory is expired or missing');
      const nodes=JSON.parse(stdout);if(!Array.isArray(nodes)||nodes.length>10000)throw new Error('invalid provider inventory');
      this.nodes=nodes.map(n=>({...n,asn:metadata.addresses[n.address]?.asn,verifiedOperator:metadata.addresses[n.address]?.verifiedOperator}));
      return this.nodes;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async get(){if(!this.nodes.length||this.nodes.every(n=>n.expiresAt<=this.now()+10000))await this.refresh();return this.nodes;}
}
