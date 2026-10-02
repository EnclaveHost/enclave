// Keep a Linux host's privacy-agent app list current, then SIGHUP the agent.
//
//   node reconcile-apps.mjs --config FILE --guestd-root DIR --tuna-binary FILE --topup FILE --targets FILE [--ipfs-repo DIR] [--dry-run]
//
// For every public, active deployment leased to this runner it derives the expectation the agent pins:
// appRef and configCid from the lease, and appSha256/runtimeId/release/measurement from guestd's record of
// the attested guest it launched. A record is used only when its CID is the catalog CID of the lease's
// CURRENT version, so a guest from before an upgrade is never pinned. Without this an owner's version
// change leaves the agent refusing the new guest, and a privacy-routed app has no fallback route.
// A deployment not yet in the config is enrolled: six fresh wallets (two circuits x guard/public/egress),
// funded by the top-up job before the app is added, its names (<label>.app.enclave.host plus attached
// custom domains from the public domain map), and publishToMirror: true.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPublicClient,http,stringToHex} from 'viem';
const run=promisify(execFile);

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const DRY=process.argv.includes('--dry-run');
const ipfsRepo=arg('--ipfs-repo','/home/steven/enclave-prod/tuna-privacy/ipfs-cid');
const configFile=arg('--config'),guestdRoot=arg('--guestd-root'),tunaBinary=arg('--tuna-binary'),topup=arg('--topup'),targetsFile=arg('--targets');
if(!configFile||!guestdRoot||!tunaBinary||!topup||!targetsFile)throw new Error('usage: --config --guestd-root --tuna-binary --topup --targets [--dry-run]');
const here=path.dirname(new URL(import.meta.url).pathname);
const readJSON=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const writeAtomic=async(f,text,mode=0o600)=>{const t=f+'.tmp-'+process.pid;await fs.writeFile(t,text,{mode});await fs.rename(t,f);};
const log=m=>console.log(`[reconcile] ${m}`);
const MIN_FUNDED=10_000_000n; // 0.01 NKN in base units: the adapters' minimum balance

const cfg=await readJSON(configFile);
const runner=String(cfg.runner).toLowerCase(),appsDir=path.dirname(configFile);
const loadAbi=async n=>readJSON(path.join(here,'..','contracts',n+'.abi.json'));
const [bookAbi,depAbi,catAbi]=await Promise.all(['EnclaveAddressBook','EnclaveDeployments','EnclaveAppCatalog'].map(loadAbi));

// Any one RPC that answers is enough for discovery; authorization stays with the agent's quorum.
async function withChain(fn){let err;for(const url of cfg.chain.rpc){try{return await fn(createPublicClient({transport:http(url,{timeout:15000,retryCount:1})}));}catch(e){err=e;}}throw err;}
const {rows,catalog}=await withChain(async c=>{
  const book=cfg.chain.addressBook;
  const [dep,catalog]=await Promise.all(['deployments','appCatalog'].map(k=>c.readContract({address:book,abi:bookAbi,functionName:'addr',args:[stringToHex(k,{size:32})]})));
  const total=Number(await c.readContract({address:dep,abi:depAbi,functionName:'count'}));
  const rows=[];for(let i=0;i<total;i+=50)rows.push(...await c.readContract({address:dep,abi:depAbi,functionName:'getPage',args:[BigInt(i),50n]}));
  return {rows,catalog};
});
const now=Math.floor(Date.now()/1000);
const mine=rows.filter(r=>String(r.runner).toLowerCase()===runner&&r.active===true&&r.isPublic===true&&Number(r.leaseUntil)>now);

// guestd's attested guests, newest first per deployment
const instances=new Map();
for(const d of await fs.readdir(guestdRoot)){
  if(!/^gd[0-9a-f]+$/.test(d))continue;
  let i;try{i=await readJSON(path.join(guestdRoot,d,'instance.json'));}catch{continue;}
  if(i.Verdict!=='attested'||!/^0x[0-9a-f]{64}$/.test(String(i.Name).toLowerCase()))continue;
  const k=String(i.Name).toLowerCase(),prev=instances.get(k);
  if(!prev||String(i.Created)>String(prev.Created))instances.set(k,i);
}

// The guest's own component, CID-hashed exactly as the catalog publisher does (Kubo, CIDv1, raw leaves),
// cached by the component's sha256 so it is only recomputed when a guest changes.
const cidCacheFile=path.join(appsDir,'component-cids.json');
const cidCache=await readJSON(cidCacheFile).catch(()=>({}));
async function componentCid(inst){
  let b;try{b=await fs.readFile(path.join(guestdRoot,inst.ID,'app.bundle'));}catch{return null;}
  const magic=Buffer.from('ENCLAVE-BUNDLE/1\n');if(!b.subarray(0,magic.length).equals(magic))return null;
  let i=magic.length;const n=b.readUInt32LE(i);i+=4;const manifest=JSON.parse(b.subarray(i,i+n));i+=n;const m=b.readUInt32LE(i);i+=4;
  const sha=manifest?.artifact?.sha256;if(!/^[0-9a-f]{64}$/.test(sha||''))return null;
  if(cidCache[sha])return cidCache[sha];
  const tmp=path.join(appsDir,'.component-'+process.pid);await fs.writeFile(tmp,b.subarray(i,i+m),{mode:0o600});
  try{
    const {createHash}=await import('node:crypto');if(createHash('sha256').update(b.subarray(i,i+m)).digest('hex')!==sha)return null;
    const cid=(await run('ipfs',['add','--offline','--only-hash','--cid-version=1','--quieter',tmp],{env:{...process.env,IPFS_PATH:ipfsRepo}})).stdout.trim();
    if(!/^baf[a-z2-7]+$/.test(cid))return null;cidCache[sha]=cid;if(!DRY)await writeAtomic(cidCacheFile,JSON.stringify(cidCache,null,2));return cid;
  }finally{await fs.rm(tmp,{force:true});}
}

let domains=null;
try{const r=await fetch('https://api.enclave.host/v1/domains/map',{signal:AbortSignal.timeout(15000)});if(r.ok)domains=(await r.json()).domains||{};}catch{}
const namesFor=id=>{const n=[id.slice(2,10)+'.app.enclave.host'];for(const [h,d] of Object.entries(domains||{}))if(String(d).toLowerCase()===id&&!n.includes(h))n.push(h);return n;};

const targets=(await fs.readFile(targetsFile,'utf8').catch(()=>'')).split('\n').filter(Boolean);
const balanceOf=async a=>{for(const u of cfg.nknRpc){try{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'getbalancebyaddr',params:{address:a},id:1}),signal:AbortSignal.timeout(10000)});const j=await r.json();if(j.result)return BigInt(Math.round(Number(j.result.amount)*1e8));}catch{}}return null;};

let changed=false,targetsChanged=false;
for(const row of mine){
  const id=String(row.id).toLowerCase(),inst=instances.get(id),appRef=String(row.appRef),m=appRef.match(/^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i);
  if(!m){log(`${id.slice(0,10)}: appRef ${appRef} is not a catalog reference; skipped`);continue;}
  if(!inst){log(`${id.slice(0,10)}: no attested guest yet; skipped`);continue;}
  const version=await withChain(c=>c.readContract({address:catalog,abi:catAbi,functionName:'getVersion',args:[m[1],BigInt(m[2])]}));
  const guestCid=await componentCid(inst);
  if(!guestCid||String(version.cid)!==guestCid){log(`${id.slice(0,10)}: the attested guest's component is not ${appRef}'s yet; waiting`);continue;}
  const expected={appRef,configCid:String(row.configCid),appSha256:inst.AppID,runtimeId:inst.RuntimeID,release:inst.Releases?.[0]??inst.Release,measurement:inst.Measurement};
  if(!/^[0-9a-f]{64}$/.test(expected.appSha256||'')||!/^[0-9a-f]{64}$/.test(expected.runtimeId||'')||!/^[0-9a-f]{64}$/.test(expected.release||'')||!/^[0-9a-f]{96}$/.test(expected.measurement||'')){log(`${id.slice(0,10)}: incomplete guest record; skipped`);continue;}
  const existing=cfg.apps.find(a=>a.deploymentId===id);
  if(existing){
    const cur=await readJSON(existing.expectedFile).catch(()=>null);
    if(JSON.stringify(cur)!==JSON.stringify(expected)){
      log(`${id.slice(0,10)}: expectation ${cur?.appRef?.split('/').pop()}->${appRef.split('/').pop()} app ${String(cur?.appSha256).slice(0,8)}->${expected.appSha256.slice(0,8)}`);
      if(!DRY){if(cur)await fs.copyFile(existing.expectedFile,existing.expectedFile+'.'+new Date().toISOString().replace(/[:.]/g,''));await writeAtomic(existing.expectedFile,JSON.stringify(expected,null,2));}
      changed=true;
    }
    if(domains){const names=namesFor(id);if(JSON.stringify(names)!==JSON.stringify(existing.names)){log(`${id.slice(0,10)}: names ${existing.names} -> ${names}`);existing.names=names;changed=true;}}
    continue;
  }
  // enrollment
  if(!domains){log(`${id.slice(0,10)}: new, but the domain map is unavailable; enrolling next round`);continue;}
  const dir=path.join(appsDir,id);log(`${id.slice(0,10)}: enrolling (${namesFor(id).join(', ')})`);
  if(DRY)continue;
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const wallets=[];
  for(const slot of [0,1]){const w={};for(const role of ['guard','public','egress']){const seed=path.join(dir,`${slot}-${role}.seed`);
    let out;try{await fs.access(seed);out=(await run(tunaBinary,['--wallet-address',seed])).stdout;}catch{out=(await run(tunaBinary,['--init-wallet',seed])).stdout;}
    w[role]={seedFile:seed,address:JSON.parse(out).address,fundedNkn:'0.25'};}wallets.push(w);}
  await writeAtomic(path.join(dir,'wallets.json'),JSON.stringify(wallets,null,2));
  await writeAtomic(path.join(dir,'expected.json'),JSON.stringify(expected,null,2));
  const addrs=wallets.flatMap(w=>Object.values(w).map(x=>x.address));
  if(!targets.some(l=>l.startsWith(id.slice(0,10)+' '))){targets.push(`${id.slice(0,10)} 0.25 ${addrs.join(' ')}`);targetsChanged=true;}
  const bal=await Promise.all(addrs.map(balanceOf));
  if(bal.some(b=>b===null||b<MIN_FUNDED)){
    if(targetsChanged){await writeAtomic(targetsFile,targets.join('\n')+'\n',0o644);targetsChanged=false;}
    log(`${id.slice(0,10)}: funding its wallets; enrolled once they confirm`);
    await run(topup,[],{timeout:600000}).catch(e=>log('top-up: '+String(e.stderr||e.message).split('\n').slice(-3).join(' ')));
    continue;
  }
  cfg.apps.push({deploymentId:id,names:namesFor(id),expectedFile:path.join(dir,'expected.json'),walletsFile:path.join(dir,'wallets.json'),publishToMirror:true});
  changed=true;log(`${id.slice(0,10)}: enrolled`);
}
if(targetsChanged&&!DRY)await writeAtomic(targetsFile,targets.join('\n')+'\n',0o644);
if(changed&&!DRY){
  await writeAtomic(configFile,JSON.stringify(cfg,null,2));
  await run('systemctl',['--user','reload','enclave-tuna-privacy.service']);
  log('agent reloaded');
}
log(`${mine.length} leased apps checked; ${changed?'changes applied':'no changes'}${DRY?' (dry run)':''}`);
