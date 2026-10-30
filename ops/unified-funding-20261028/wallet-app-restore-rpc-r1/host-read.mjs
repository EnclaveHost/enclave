import fs from 'node:fs';
const deadline=setTimeout(()=>process.exit(2),22000);
const vals=new Map(), out={capturedAt:new Date().toISOString(),readOnly:true,configuration:'on-disk selected fields only; not running environment proof',files:[],peers:[]};
for(const file of ['C:/ProgramData/Enclave/node-config.cmd','C:/ProgramData/Enclave/node-config.local.cmd','C:/ProgramData/Enclave/run-node.cmd']){
 try {if(fs.statSync(file).size>65536)throw Error('bound');const s=fs.readFileSync(file,'utf8');let count=0;
 for(const line of s.split(/\r?\n/)){const m=line.trim().match(/^@?set\s+"?((?:ENCLAVE_)?LEASE_GAS_(?:RPCS|QUORUM))=(.*?)"?\s*$/i);if(m){const key=m[1].toUpperCase();if(vals.has(key)&&vals.get(key)!==m[2])throw Error('conflicting selected fields');vals.set(key,m[2]);count++;}}out.files.push({file,selectedFields:count});
 }catch(e){out.files.push({file,error:e.code||e.message});}
}
const a=vals.get('ENCLAVE_LEASE_GAS_RPCS'),b=vals.get('LEASE_GAS_RPCS');
if(a&&b&&a!==b)throw Error('RPC alias conflict');
const raw=a||b;if(!raw||raw.includes('%'))throw Error('literal RPC configuration unavailable');
const urls=raw.split(',').map(x=>x.trim()).filter(Boolean);if(!urls.length||urls.length>8)throw Error('peer count bound');
out.quorum=vals.get('ENCLAVE_LEASE_GAS_QUORUM')||vals.get('LEASE_GAS_QUORUM')||'default';
async function request(url,method){const start=Date.now();try{const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});let n=0,parts=[];for await(const b of r.body){n+=b.length;if(n>16384)throw Error('body bound');parts.push(b);}if(!r.ok)return{method,httpStatus:r.status,ms:Date.now()-start};const j=JSON.parse(Buffer.concat(parts));return{method,httpStatus:r.status,ms:Date.now()-start,...typeof j.result==='string'&&/^0x[0-9a-f]{1,32}$/i.test(j.result)?{result:j.result}:{rpcErrorCode:j.error?.code??'invalid-result'}};}catch(e){return{method,error:e.name,code:e.cause?.code??null,ms:Date.now()-start};}}
for(let i=0;i<urls.length;i++){const u=new URL(urls[i]);if(u.protocol!=='https:')throw Error('HTTPS required');out.peers.push({index:i,hostname:u.hostname,reads:await Promise.all(['eth_chainId','eth_blockNumber'].map(m=>request(u.href,m)))});}
clearTimeout(deadline);console.log(JSON.stringify(out));
