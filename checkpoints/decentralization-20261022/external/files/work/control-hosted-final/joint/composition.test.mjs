import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import * as viem from 'viem';
// root's composition test (work/control-hosted-composition/composition.test.mjs), adapted ONLY here: the module under test is the
// ACTUAL composed source of the final tree, named by CONTROL_COMPOSED_MODULE (required); BASE is main's original (copied fixture)
if (!process.env.CONTROL_COMPOSED_MODULE) throw new Error('set CONTROL_COMPOSED_MODULE to the composed metal/guest/measured-control.mjs');
const MC = await import(process.env.CONTROL_COMPOSED_MODULE);
import * as BASE from './base/metal/guest/measured-control.mjs';
const a=n=>'0x'+n.toString(16).padStart(40,'0');
const members=[0,1,2].map(i=>({operator:a(i+51),publicUrl:`https://host-${i}.example.org`,controlUrl:`https://192.0.2.${i+1}:8444`}));
const mcp=()=>({port:18095,managementDirectories:[],capacityDirectories:[],capacityCold:false,maxHosts:64,storagePlan:null,grantFrontend:null,sessionScan:{fromBlock:0,chunk:500,maxChunks:40},usdc:null});
const platformApi=()=>({apiPort:8098,peerPort:8099,hostname:'api.platform.test',members,measurements:['77'.repeat(48)],minTcb:null,admins:[a(80)],recovery:['81'.repeat(32)],archives:[],archiveMs:30000,relayEnv:{SIWE_DOMAIN:'enclave.host'},leaseMs:10000});
const raw=()=>({format:MC.CONFIG_FORMAT,chainId:8453,contracts:{registry:a(17),deployments:a(18),appCatalog:a(19),proofOfTime:a(20),enclavePay:a(0),verificationFees:a(0),sessionVaultFactory:a(21),secretVaultV2:a(0)},profileDigest:null,rpcs:['https://rpc-a.example/v1','https://rpc-b.example'],quorum:2,releaseId:'ab'.repeat(32),replicas:{gateways:['https://replica.example'],storagePlan:null},identity:{publicUrl:members[0].publicUrl,repo:'owner/enclave',operator:members[0].operator},selling:{cpuPrice6:null,payout:null},isolation:{managerUrl:'http://10.0.2.2:8095',dataAddr:'10.0.2.2:8096'},hostAdmissionSha256:null,controlPort:8444});
const both=()=>({...raw(),mcp:mcp(),platformApi:platformApi()});
const listen=s=>new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',()=>ok(s.address().port));});
const paths=d=>({...MC.GUEST_PATHS,...Object.fromEntries(Object.keys(MC.GUEST_PATHS).map(k=>[k,path.join(d,k)]))});
test('combined config preserves legacy identity and binds both roles without conflicting ports',()=>{
 assert.deepEqual(MC.canonicalDirectConfig(raw()),BASE.canonicalDirectConfig(raw()));
 assert.equal(MC.configDigest(MC.canonicalDirectConfig(raw())),BASE.configDigest(BASE.canonicalDirectConfig(raw())));
 const cfg=MC.canonicalDirectConfig(both()),digest=MC.configDigest(cfg);
 assert.notEqual(digest,MC.configDigest(MC.canonicalDirectConfig({...raw(),mcp:mcp()})));
 assert.notEqual(digest,MC.configDigest(MC.canonicalDirectConfig({...raw(),platformApi:platformApi()})));
 for(const port of [8098,8099])assert.throws(()=>MC.canonicalDirectConfig({...both(),mcp:{...mcp(),port}}),/must differ/);
});
test('bound boot plan retains both services and statement measurements',async()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'control-compose-'));
 try{const P=paths(d),config=MC.canonicalDirectConfig(both()),digest=MC.configDigest(config),hostData=MC.hostDataHex(digest);
 const plan=await MC.planDirectBoot({cmdline:'console=ttyS0 metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct',fw:{mode:'snp',name:'fixture',direct:both(),isolation:{...raw().isolation,pairingKey:'5e'.repeat(32)},registryKey:''},reportHostData:hostData,viem,paths:P});
 assert.equal(plan.ok,true,plan.reasons?.join(';'));assert.ok(plan.files[P.mcpConfig]);assert.ok(plan.files[P.platformApiConfig]);assert.ok(plan.mcp&&plan.platformApi);
 const keys=MC.mintControlKeys({paths:P});keys.platformApi={publicKey:MC.mintPlatformApiKey({paths:P})};
 const st=MC.parseStatement(MC.controlStatement({config,digest,hostData,mode:'snp',keys,runtime:{mcpSha256:'aa'.repeat(32),platformApiSha256:'bb'.repeat(32)}}).text);
 assert.equal(st.runtime.mcpSha256,'aa'.repeat(32));assert.equal(st.runtime.platformApiSha256,'bb'.repeat(32));assert.equal(st.keys.platformApi.publicKey,keys.platformApi.publicKey);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('actual TLS front separates MCP exact path, API hostname, peer prefix and supervisor',async()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'control-routes-')),servers=[];
 try{
 const ports={};for(const label of ['sup','mcp','api','peer']){const s=http.createServer((req,res)=>res.end(JSON.stringify({label,path:req.url,host:req.headers.host,clientIp:req.headers['x-enclave-client-ip']??null})));servers.push(s);ports[label]=await listen(s);}
 const P=paths(d),config=MC.canonicalDirectConfig(both()),digest=MC.configDigest(config),keys=MC.mintControlKeys({paths:P});
 const st=MC.controlStatement({config,digest,hostData:MC.hostDataHex(digest),mode:'snp',keys});
 const upstream=label=>({host:'127.0.0.1',port:ports[label]});
 const front=MC.createControlFront({statementText:st.text,keyPem:fs.readFileSync(P.tlsKey),certPem:keys.controlTls.certPem,reporter:async()=>{throw Error('not requested')},upstream:upstream('sup'),routes:[{path:'/mcp',upstream:upstream('mcp'),rewrite:'/p/host'}],hostRoutes:[{host:'api.platform.test',upstream:upstream('api')}],prefixRoutes:[{prefix:'/platform-api/',upstream:upstream('peer')}]});servers.push(front);const port=await listen(front);
 const get=(host,p)=>new Promise((ok,no)=>{const q=https.get({host:'127.0.0.1',port,path:p,headers:{host,'x-enclave-client-ip':'203.0.113.99'},rejectUnauthorized:false,agent:false},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{ok(JSON.parse(b))}catch(e){no(e)}})});q.on('error',no)});
 for(const [host,p,label,wantPath] of [['control.test','/mcp?x=1','mcp','/p/host?x=1'],['control.test','/mcp/other','sup','/mcp/other'],['api.platform.test','/mcp?x=2','api','/mcp?x=2'],['control.test','/platform-api/status','peer','/platform-api/status'],['control.test','/v1/status','sup','/v1/status']]){const got=await get(host,p);assert.equal(got.label,label);assert.equal(got.path,wantPath);assert.equal(got.clientIp,label==='api'?'127.0.0.1':null,'front overwrites client-supplied identity for API and strips it elsewhere');}
 }finally{await Promise.all(servers.map(s=>new Promise(ok=>{s.closeAllConnections?.();s.close(ok)})));fs.rmSync(d,{recursive:true,force:true});}
});

test('WebSocket upgrade passes the TCP client identity rather than an injected header',async()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'control-upgrade-')),servers=[];
 try{
 const backend=http.createServer();servers.push(backend);
 backend.on('upgrade',(req,socket)=>socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-observed-client: '+(req.headers['x-enclave-client-ip']??'missing')+'\r\n\r\n'));
 const backendPort=await listen(backend),P=paths(d),keys=MC.mintControlKeys({paths:P});
 const config=MC.canonicalDirectConfig(both()),digest=MC.configDigest(config),st=MC.controlStatement({config,digest,hostData:MC.hostDataHex(digest),mode:'snp',keys});
 const front=MC.createControlFront({statementText:st.text,keyPem:fs.readFileSync(P.tlsKey),certPem:keys.controlTls.certPem,reporter:async()=>{},upstream:{host:'127.0.0.1',port:backendPort},hostRoutes:[{host:'api.platform.test',upstream:{host:'127.0.0.1',port:backendPort}}]});servers.push(front);const port=await listen(front);
 const observed=await new Promise((ok,no)=>{const q=https.request({host:'127.0.0.1',port,path:'/socket',headers:{host:'api.platform.test',connection:'Upgrade',upgrade:'websocket','x-enclave-client-ip':'203.0.113.99'},rejectUnauthorized:false,agent:false});q.on('upgrade',(r,s)=>{s.destroy();ok(r.headers['x-observed-client'])});q.on('error',no);q.setTimeout(3000,()=>q.destroy(Error('upgrade timed out')));q.end()});
 assert.equal(observed,'127.0.0.1');
 }finally{await Promise.all(servers.map(s=>new Promise(ok=>{s.closeAllConnections?.();s.close(ok)})));fs.rmSync(d,{recursive:true,force:true});}
});
