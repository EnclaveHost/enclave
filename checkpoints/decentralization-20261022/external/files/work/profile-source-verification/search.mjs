import {createRequire} from 'node:module';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');const solc=require('solc');
const varint=n=>{const o=[];while(n>=0x80){o.push((n&0x7f)|0x80);n>>>=7;}o.push(n);return Buffer.from(o);};
const field=(t,b)=>Buffer.concat([Buffer.from([t]),varint(b.length),b]);
const ipfs=c=>{const d=Buffer.from(c,'utf8');return '1220'+createHash('sha256').update(field(0x0a,Buffer.concat([Buffer.from([8,2]),d.length?field(0x12,d):Buffer.alloc(0),Buffer.from([0x18]),varint(d.length)]))).digest('hex');};
const live=JSON.parse(fs.readFileSync('live-codes.json','utf8'));
const targets=Object.fromEntries(Object.entries(live.codes).map(([k,c])=>{const b=Buffer.from(c.slice(2),'hex');const L=b.readUInt16BE(b.length-2);const cbor=b.subarray(b.length-2-L,b.length-2).toString('hex');const i=cbor.indexOf('64697066735822');return [cbor.slice(i+14,i+14+68),k];}));
const repos=['/home/steven/Projects/enclave/.git','/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git'];
const files=process.argv.slice(2);
const git=(g,...a)=>execFileSync('git',['--git-dir='+g,...a],{encoding:'utf8',maxBuffer:64<<20});
const settingsGrid=[];for(const runs of [200,1])for(const viaIR of [false,true])settingsGrid.push({runs,viaIR});
const seen=new Set(),hits=[];let compiles=0;
for(const g of repos)for(const f of files){
  let commits=[];try{commits=git(g,'log','--all','--format=%H','--',f).trim().split('\n').filter(Boolean);}catch{}
  for(const c of commits){
    const read=p=>{try{return git(g,'show',c+':'+p);}catch{return null;}};
    const main=read(f);if(main==null)continue;
    const dir=f.split('/').slice(0,-1).join('/');
    // resolve relative imports at the same commit
    const srcs={};const queue=[f.split('/').pop()];
    while(queue.length){const n=queue.shift();if(srcs[n]!==undefined)continue;const t=n===f.split('/').pop()?main:read((dir?dir+'/':'')+n);if(t==null){srcs[n]=null;continue;}srcs[n]=t;
      for(const m of t.matchAll(/import\s+(?:[^"']*from\s+)?["']\.\/([^"']+)["']/g))queue.push(m[1]);}
    if(Object.values(srcs).includes(null))continue;
    const key=createHash('sha256').update(JSON.stringify(srcs)).digest('hex');if(seen.has(key))continue;seen.add(key);
    for(const prefix of ['','contracts/'])for(const s of settingsGrid){
      const sources=Object.fromEntries(Object.entries(srcs).map(([n,t])=>[prefix+n,{content:t}]));
      const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:s.runs},...(s.viaIR?{viaIR:true}:{}),outputSelection:{'*':{'*':['metadata']}}}};
      const out=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>({error:'no import '+p})}));compiles++;
      if((out.errors||[]).some(e=>e.severity==='error')){if(process.env.DBG)console.error(out.errors.map(e=>e.formattedMessage).join('\n').slice(0,300));continue;}
      for(const [u,cs] of Object.entries(out.contracts||{}))for(const [name,o] of Object.entries(cs)){const h=ipfs(o.metadata);
        if(targets[h])hits.push({target:targets[h],repo:g,commit:c,file:f,unit:u,contract:name,...s,sources:Object.fromEntries(Object.entries(srcs).map(([n,t])=>[n,createHash('sha256').update(t).digest('hex')]))});}
    }
  }
}
console.log('compiles',compiles,'unique source sets',seen.size);
fs.writeFileSync('hits-'+files.map(f=>f.split('/').pop().replace('.sol','')).join('_')+'.json',JSON.stringify(hits,null,1));
for(const h of hits)console.log(h.target,h.contract,h.unit,h.repo.includes('Projects')?'P':'W',h.commit.slice(0,10),'runs',h.runs,'viaIR',h.viaIR);
