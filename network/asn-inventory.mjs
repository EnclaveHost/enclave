import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {DurableState} from './durable-state.mjs';
const day=86400000;
const validASN=n=>Number.isSafeInteger(n)&&n>0&&n<=4294967295;
// ASNs describe routing failure domains, not verified corporate ownership.
// The cache survives metadata-service outages. Reads never extend its lifetime.
export class AsnInventory {
  constructor({file,fetchFn,now=Date.now,log=()=>{}}){
    if(!path.isAbsolute(file)||!file.endsWith('.json'))throw new Error('absolute ASN cache required');
    Object.assign(this,{file,fetchFn,now,log});this.state=new DurableState(path.dirname(file));this.key=path.basename(file,'.json');this.retry=new Map();this.pending=null;
  }
  async read(){
    let data;try{data=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}
    if(!data?.addresses||typeof data.addresses!=='object')throw new Error('invalid ASN inventory');
    const out={};for(const[ip,v]of Object.entries(data.addresses)){
      const expiresAt=v.expiresAt??data.expiresAt;
      if(net.isIP(ip)&&validASN(v.asn)&&Number.isSafeInteger(expiresAt)&&expiresAt>this.now())out[ip]={...v,expiresAt};
    }
    return out;
  }
  async lookup(ip){
    if(!net.isIP(ip)||!this.fetchFn)throw new Error('ASN lookup unavailable');
    const readers=[async()=>{
      const res=await this.fetchFn('https://stat.ripe.net/data/network-info/data.json?resource='+encodeURIComponent(ip));
      if(!res.ok)throw new Error('RIPE HTTP '+res.status);const doc=await res.json(),values=doc?.data?.asns;
      if(!Array.isArray(values)||values.length!==1||!validASN(Number(values[0])))throw new Error('ambiguous or missing RIPE origin');
      return {asn:Number(values[0]),source:'RIPE RIS',prefix:doc.data.prefix};
    }];
    if(net.isIPv4(ip))readers.push(async()=>{
      const name=ip.split('.').reverse().join('.')+'.origin.asn.cymru.com';
      const res=await this.fetchFn('https://dns.google/resolve?name='+name+'&type=TXT');
      if(!res.ok)throw new Error('Cymru DNS HTTP '+res.status);const doc=await res.json();
      const values=(doc.Answer||[]).filter(a=>a.type===16).map(a=>String(a.data).replace(/^"|"$/g,'').split('|')[0].trim());
      if(doc.Status!==0||values.length!==1||!/^\d+$/.test(values[0])||!validASN(Number(values[0])))throw new Error('ambiguous or missing Cymru origin');
      return {asn:Number(values[0]),source:'Team Cymru DNS'};
    });
    let error;for(const read of readers){try{return {...await read(),observedAt:this.now(),expiresAt:this.now()+7*day};}catch(e){error=e;}}
    throw error;
  }
  refresh(nodes){
    if(this.pending||!this.fetchFn)return this.pending||Promise.resolve();
    this.pending=(async()=>{
      const current=await this.read(),now=this.now();
      const queue=[...new Set(nodes.map(n=>n.address))].filter(ip=>net.isIP(ip)&&(!current[ip]||current[ip].expiresAt<now+6*day)&&(this.retry.get(ip)||0)<=now).slice(0,16);
      if(!queue.length)return;
      const changes={};let i=0;
      await Promise.all(Array.from({length:Math.min(queue.length,4)},async()=>{
        while(i<queue.length){const ip=queue[i++];try{changes[ip]=await this.lookup(ip);this.retry.delete(ip);}catch(e){this.retry.set(ip,this.now()+3600000);this.log('ASN '+ip+': '+e.message);}}
      }));
      if(Object.keys(changes).length)await this.state.update(this.key,old=>({version:1,addresses:{...Object.fromEntries(Object.entries(old?.addresses||{}).map(([ip,v])=>[ip,{...v,expiresAt:v.expiresAt??old.expiresAt}])),...changes}}));
    })().finally(()=>this.pending=null);return this.pending;
  }
}
