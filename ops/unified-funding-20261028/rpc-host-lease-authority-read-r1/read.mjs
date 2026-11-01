import fs from 'node:fs';
import crypto from 'node:crypto';
const id='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
const out={at:new Date().toISOString(),readOnly:true,id,processEnvironmentRead:false,hostBindingProven:false,stage:'configuration',requests:[],signAttempts:0};
const timer=setTimeout(()=>process.exit(124),15000);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
function boundedFile(file,max){const fd=fs.openSync(file,'r');try{const st=fs.fstatSync(fd);check(st.isFile()&&st.size<=max,'file-bound');const b=Buffer.alloc(st.size);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,null);check(k>0,'file-short');n+=k;}const end=fs.fstatSync(fd);check(end.size===st.size&&end.mtimeMs===st.mtimeMs,'file-changed');return b;}finally{fs.closeSync(fd);}}
const allowedOrigins=new Set(['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io']);
const nativeFetch=globalThis.fetch;let count=0,total=0;
globalThis.fetch=async(input,init)=>{
 const req=new Request(input,init),url=new URL(req.url);check(allowedOrigins.has(url.origin)&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'URL-refused');
 check(req.method==='POST'&&++count<=64,'request-refused');const body=await req.clone().text();check(body.length<=8192,'request-bound');const rpc=JSON.parse(body);
 check(!Array.isArray(rpc)&&rpc.jsonrpc==='2.0'&&['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call'].includes(rpc.method),'method-refused');
 const row={origin:url.origin,method:rpc.method};out.requests.push(row);const start=Date.now();
 try{const response=await nativeFetch(new Request(req,{redirect:'error',signal:AbortSignal.any([req.signal,AbortSignal.timeout(3000)])}));row.status=response.status;const parts=[];let size=0;
  for await(const part of response.body){size+=part.length;total+=part.length;check(size<=262144&&total<=2097152,'response-bound');parts.push(part);}
  const bytes=Buffer.concat(parts);try{const v=JSON.parse(bytes);row.errorCode=Number.isInteger(v.error?.code)?v.error.code:null;}catch{row.nonJson=true;}
  return new Response(bytes,{status:response.status,headers:{'content-type':'application/json'}});
 }catch(e){row.error=e.name;throw e;}finally{row.elapsedMs=Date.now()-start;}
};
try{
 const raw=boundedFile('C:/ProgramData/Enclave/lease-gas/lease-gas-config.cmd',65536),content=raw[0]===255&&raw[1]===254?raw.subarray(2).toString('utf16le'):raw.toString('utf8');
 const env=Object.create(null),fields=['FILE','DIGEST','RPCS','RELAYS','LOCAL_RELAY','PINNED_RELAYS','SERVICE_INDEX','RELAY_EXCLUDE','RESERVE','QUORUM'];
 const keys=new Set(fields.flatMap(f=>['ENCLAVE_LEASE_GAS_'+f,'LEASE_GAS_'+f]));
 for(const line of content.split(/\r?\n/)){const m=line.trim().match(/^@?set\s+"?([A-Z_]+)=(.*?)"?\s*$/i);if(m&&keys.has(m[1].toUpperCase())){const key=m[1].toUpperCase();check(!(key in env),'duplicate-setting');env[key]=m[2];}}
 const setting=f=>{const a=env['ENCLAVE_LEASE_GAS_'+f]??'',b=env['LEASE_GAS_'+f]??'';check(!a||!b||a===b,'setting-conflict');return a||b;};
 check(setting('QUORUM')==='2','quorum-changed');const urls=setting('RPCS').split(',').map(x=>x.trim());check(urls.length===3&&new Set(urls.map(x=>new URL(x).origin)).size===3,'endpoint-set-changed');
 for(const value of urls){const url=new URL(value);check(allowedOrigins.has(url.origin)&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'endpoint-changed');}
 const file=setting('FILE').replaceAll('\\','/');check(/^C:\/ProgramData\/Enclave\/lease-gas\/[A-Za-z0-9._-]+\.json$/i.test(file),'record-path-refused');
 check(fs.realpathSync(file).replaceAll('\\','/').toLowerCase()===file.toLowerCase(),'record-path-changed');
 const bytes=boundedFile(file,16384),digest='sha256:'+hash(bytes);check(digest===setting('DIGEST').toLowerCase(),'record-digest-mismatch');const record=JSON.parse(bytes);
 check(record.chainId===8453&&record.ledger.toLowerCase()==='0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b'&&record.reserve.toLowerCase()==='0x12a3f873041dec436daa0085b766a399a6fa3639','record-binding-mismatch');
 const source=boundedFile('C:/Program Files/Enclave/control/windows/node/lease-gas-runtime.bundle.mjs',1048576);
 check(hash(source)==='159108d171e49cadf8a75dc8081df9e7213257e6f7930ac8b0f4f6e6e43b829d','bundle-changed');out.bundleHash=hash(source);out.recordDigest=digest;
 out.stage='import';const module=await import('data:text/javascript;base64,'+source.toString('base64'));
 const chain={id:8453,name:'Base',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:urls}}};
 const bindings={chain,ledger:record.ledger,registry:record.registry};out.stage='load-config';
 const config=module.loadLeaseGasConfig({env,...bindings,rpcTimeoutMs:3000,readFile:p=>{check(p===setting('FILE'),'unexpected-read');return bytes;}});
 const account=new Proxy(Object.freeze({address:'0x1A01194c34Fe3577C6d0a54feB78af6253e494e0'}),{get(target,key){if(typeof key==='string'&&/sign|send/i.test(key)){out.signAttempts++;throw Error('signing-refused');}return Reflect.get(target,key);}});
 const sender=module.configuredLeaseSender({config,account,getBindings:()=>bindings});out.stage='authority-read';
 out.renewLeadMs=await sender.renewLeadMs(id,300000);check(Number.isFinite(out.renewLeadMs)&&out.signAttempts===0,'invalid-result');out.stage='complete';out.success=true;
}catch(e){out.success=false;out.errorName=e.name;const m=String(e.message);out.reason=/^(?:lease-gas RPC quorum|lease-gas authority block|lease-gas confirmation|record-|bundle-|endpoint-|quorum-|setting-|duplicate-|file-|URL-|request-|method-|response-|signing-|unexpected-|invalid-result)/.test(m)?m.slice(0,240):'read-refused; detail withheld';}
finally{globalThis.fetch=nativeFetch;clearTimeout(timer);}
check(Buffer.byteLength(JSON.stringify(out))<=24576,'output-bound');console.log(JSON.stringify(out));
