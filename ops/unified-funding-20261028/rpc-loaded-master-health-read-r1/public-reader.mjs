import http from 'node:http';
function get(port){return new Promise((resolve,reject)=>{
 let done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);if(e){req.destroy();reject(e);}else resolve(v);};
 const req=http.get({host:'127.0.0.1',port,path:'/health',agent:false},res=>{if(res.statusCode!==200)return finish(Error('http-status'));let count=0;const chunks=[];res.on('data',b=>{count+=b.length;if(count>65536)return finish(Error('body-bound'));chunks.push(b);});res.on('end',()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(Error('json'));}});res.on('error',()=>finish(Error('body-error')));});
 const timer=setTimeout(()=>finish(Error('deadline')),2500);req.on('error',()=>finish(Error('transport')));
});}
function project(p,where='preflight',depth=0){
 if(depth>3||!p||typeof p!=='object')throw Error('preflight-shape');const masters=[],modules=[];
 if(p.checks!==undefined){if(!Array.isArray(p.checks)||p.checks.length>64)throw Error('check-bound');for(const c of p.checks){
  if(c.name==='type-1 guest-state master (VMGS)'){
   const m=/^(C:\\ProgramData\\Enclave\\[^\r\n;]+) \(([0-9]{1,8}) bytes\); each run gets a fresh copy$/.exec(c.detail??'');
   if(!m||c.ok!==true)throw Error('loaded-master-unqualified');masters.push({where,path:m[1],bytes:Number(m[2]),ok:true});
  }
  if(c.name==='hyperv.psm1 (New-CustomVM), pinned'){
   const m=/^sha256 ([a-fA-F0-9]{64})$/.exec(c.detail??'');if(!m||c.ok!==true)throw Error('loaded-module-unqualified');modules.push({where,sha256:m[1].toLowerCase(),ok:true});
  }
 }}
 if(p.roles!==undefined){if(!p.roles||Array.isArray(p.roles)||Object.keys(p.roles).length>8)throw Error('role-bound');for(const [key,value] of Object.entries(p.roles)){if(!/^[a-zA-Z0-9_-]{1,32}$/.test(key))throw Error('role-name');const x=project(value,where+'.roles.'+key,depth+1);masters.push(...x.masters);modules.push(...x.modules);}}
 return {masters,modules};
}
const out={schema:'loaded-master-health/1',readOnly:true,rows:[],capacityAdmitted:false,allIssuerCoverageProven:false};
for(const port of [8091,8095]){const h=await get(port),p=project(h.preflight);if(!p.masters.length||!p.modules.length)throw Error('missing-loaded-proof');if(typeof h.managerEpoch!=='string'||h.managerEpoch.length>256)throw Error('epoch');out.rows.push({port,managerEpoch:h.managerEpoch,...p});}
process.stdout.write(JSON.stringify(out)+'\n');
