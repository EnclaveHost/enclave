import fs from 'node:fs';import crypto from 'node:crypto';
const timer=setTimeout(()=>process.exit(124),15000);const out={at:new Date().toISOString(),readOnly:true,processEnvironmentRead:false,configuration:[],sources:[],endpoints:[]};const endpoints=new Set();
const names=new Set(['ENCLAVE_LEASE_GAS_RPCS','LEASE_GAS_RPCS','ENCLAVE_LEASE_GAS_QUORUM','LEASE_GAS_QUORUM','ENCLAVE_CHAIN_AUTHORITY','CHAIN_AUTHORITY','BASE_RPCS','BASE_RPC_URL','BASE_RPC','RPC_URL']);
for(const file of ['C:/ProgramData/Enclave/node-config.cmd','C:/ProgramData/Enclave/node-config.local.cmd','C:/ProgramData/Enclave/run-node.cmd']){
 try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)throw Error('bound');const bytes=fs.readFileSync(file);const selected=[];const content=bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8');const calls=[];const present=[...names].filter(name=>content.includes(name));
 for(let line of content.split(/\r?\n/)){
  const call=line.trim().match(/(?:^|\s)call\s+"([^"]+\.cmd)"/i);if(call&&calls.length<8)calls.push(call[1]);
  const m=line.trim().match(/^@?set\s+"?([A-Z_]+)=(.*?)"?\s*$/i);if(!m||!names.has(m[1].toUpperCase()))continue;const key=m[1].toUpperCase(),value=m[2];
  if(key.includes('RPC')&&!key.includes('QUORUM')){const urls=value.split(',').map(x=>x.trim()).filter(Boolean);if(urls.length>8)throw Error('endpoint bound');const rows=[];
   for(const text of urls){try{const url=new URL(text);const publicRoot=url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';rows.push({origin:url.origin,publicRoot,pathHash:crypto.createHash('sha256').update(url.pathname+url.search).digest('hex')});if(publicRoot)endpoints.add(url.origin);}catch{rows.push({refused:'nonliteral-or-invalid-URL'});}}
   selected.push({key,endpoints:rows});
  }else selected.push({key,value:/^(?:[1-8]|verifier|rpc|quorum)?$/.test(value)?value:'[unrecognized]'});
 }
 out.configuration.push({file,bytes:stat.size,modified:stat.mtime.toISOString(),selected,calls,present,encoding:bytes[0]===255&&bytes[1]===254?'utf16le':'utf8'});
 }catch(e){out.configuration.push({file,error:e.code??e.message});}
}
for(const name of ['agent.mjs','host.mjs','chain.mjs','lease-gas-runtime.bundle.mjs']){const file='C:/Program Files/Enclave/control/windows/node/'+name;try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1048576)throw Error('source bound');const bytes=fs.readFileSync(file);out.sources.push({name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}catch(e){out.sources.push({name,error:e.code??e.message});}}
if(endpoints.size>8)throw Error('combined endpoint bound');
async function rpc(origin,method){const start=Date.now();try{const r=await fetch(origin,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]}),redirect:'error',signal:AbortSignal.timeout(5000)});let n=0;const parts=[];for await(const b of r.body){n+=b.length;if(n>8192)throw Error('body bound');parts.push(b);}if(!r.ok)return {method,status:r.status,elapsedMs:Date.now()-start};const v=JSON.parse(Buffer.concat(parts).toString());return {method,status:r.status,result:/^0x[0-9a-f]+$/i.test(v.result??'')?v.result:null,errorCode:v.error?.code??null,elapsedMs:Date.now()-start};}catch(e){return {method,error:e.name,code:e.cause?.code??null,elapsedMs:Date.now()-start};}}
out.endpoints=await Promise.all([...endpoints].map(async origin=>({origin,results:await Promise.all(['eth_chainId','eth_blockNumber'].map(method=>rpc(origin,method)))})));clearTimeout(timer);const text=JSON.stringify(out);if(Buffer.byteLength(text)>16384)throw Error('output bound');console.log(text);
