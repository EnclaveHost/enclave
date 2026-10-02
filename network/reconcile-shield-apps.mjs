// Keep a Windows (Shield partition) host's privacy-agent app list current, driven over SSH.
//
//   node reconcile-shield-apps.mjs --host SSH_HOST --agent-dir WINDOWS_DIR --topup FILE --targets FILE [--dry-run]
//
// The Windows counterpart of reconcile-apps.mjs, run from the host that holds the funding wallet. For every
// public, active deployment leased to the Windows agent's runner it derives the expectation the agent pins:
// appRef and configCid from the lease, appSha256/runtimeId from the node manager's record of the partition it
// launched. A record is used only when it is running and ready, names the lease's CURRENT catalog app and
// version, carries that version's catalog CID (and, for a raw-leaf CID, a component sha256 equal to the CID's
// digest), and runs the runtime the agent's admitted Shield policy pins; so a partition from before an
// upgrade is never pinned. The agent still verifies every proof against the policy itself, and Nan derives
// its own expectation from the chain before it accepts a route.
// A deployment not yet in the config is enrolled as on Linux: six wallets created on the Windows host,
// funded by the top-up job (target label nb-<id>) before the app is added, its names, publishToMirror: true.
// The agent re-reads its config when the file's modification time changes, so every change ends with the
// config written (or touched) on the host.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPublicClient,http,stringToHex} from 'viem';
const run=promisify(execFile);

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const DRY=process.argv.includes('--dry-run');
const host=arg('--host'),agentDir=arg('--agent-dir'),topup=arg('--topup'),targetsFile=arg('--targets');
if(!host||!agentDir||!topup||!targetsFile||!/^[A-Z]:\\[^'"\r\n]+$/.test(agentDir))throw new Error('usage: --host --agent-dir C:\\... --topup --targets [--dry-run]');
const here=path.dirname(new URL(import.meta.url).pathname);
const readJSON=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const writeAtomic=async(f,text,mode=0o600)=>{const t=f+'.tmp-'+process.pid;await fs.writeFile(t,text,{mode});await fs.rename(t,f);};
const log=m=>console.log(`[reconcile-shield] ${m}`);
const MIN_FUNDED=10_000_000n; // 0.01 NKN in base units: the adapters' minimum balance
const V5='enclave-catalog-bundle/5',V6='enclave-catalog-bundle/6';
const HEX64=/^[0-9a-f]{64}$/,ID=/^0x[0-9a-f]{64}$/;

// One PowerShell script per call; data travels on stdin and back between @@ markers, never on the command
// line (cmd.exe caps it at 8191 characters).
async function ps(script,input=''){
  const body="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a='"+agentDir+"';"+
    "$in=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()));"+script+
    ";[Console]::Out.Write('@@'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($out))+'@@')";
  const child=execFile('ssh',['-o','LogLevel=ERROR','-o','BatchMode=yes','-o','ConnectTimeout=20',host,'powershell','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{timeout:180000,maxBuffer:64<<20});
  const done=new Promise((resolve,reject)=>{let o='',e='';child.stdout.on('data',d=>o+=d);child.stderr.on('data',d=>e+=d);
    child.on('error',reject);child.on('close',code=>{const m=o.match(/@@([A-Za-z0-9+/=]*)@@/);
      if(code!==0||!m)reject(new Error(`${host}: exit ${code} ${(e.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).slice(-400)}`));else resolve(Buffer.from(m[1],'base64').toString('utf8'));});});
  child.stdin.end(Buffer.from(input||'-').toString('base64'));
  return done;
}

// Everything the round needs from the host, in one call.
const snap=JSON.parse(await ps(
  "$vms=(Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8091/vms -TimeoutSec 15).Content;"+
  "$exp=@{};foreach($d in Get-ChildItem $a -Directory|Where-Object{$_.Name -match '^0x[0-9a-f]{64}$'}){$f=Join-Path $d.FullName 'expected.json';if(Test-Path $f){$exp[$d.Name]=[IO.File]::ReadAllText($f)}};"+
  "$out=(@{vms=$vms;config=[IO.File]::ReadAllText(\"$a\\privacy-config.json\");policy=[IO.File]::ReadAllText(\"$a\\admitted-shield-policy.json\");expected=$exp}|ConvertTo-Json -Compress -Depth 3)"));
const cfg=JSON.parse(snap.config),policy=JSON.parse(snap.policy),vms=JSON.parse(snap.vms).vms;
if(cfg.version!==2||!Array.isArray(cfg.apps)||!Array.isArray(vms))throw new Error('unexpected agent config or manager record');
const runner=String(cfg.runner).toLowerCase(),remote=f=>agentDir+'\\'+f;

const loadAbi=async n=>readJSON(path.join(here,'..','contracts',n+'.abi.json'));
const [bookAbi,depAbi,catAbi]=await Promise.all(['EnclaveAddressBook','EnclaveDeployments','EnclaveAppCatalog'].map(loadAbi));
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

let domains=null;
try{const r=await fetch('https://api.enclave.host/v1/domains/map',{signal:AbortSignal.timeout(15000)});if(r.ok)domains=(await r.json()).domains||{};}catch{}
const namesFor=id=>{const n=[id.slice(2,10)+'.app.enclave.host'];for(const [h,d] of Object.entries(domains||{}))if(String(d).toLowerCase()===id&&!n.includes(h))n.push(h);return n;};
const targets=(await fs.readFile(targetsFile,'utf8').catch(()=>'')).split('\n').filter(Boolean);
const balanceOf=async a=>{for(const u of cfg.nknRpc){try{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'getbalancebyaddr',params:{address:a},id:1}),signal:AbortSignal.timeout(10000)});const j=await r.json();if(j.result)return BigInt(Math.round(Number(j.result.amount)*1e8));}catch{}}return null;};
// a raw-leaf CIDv1 (bafkrei...) is the sha256 of the bytes themselves
const rawDigest=cid=>{if(!/^bafkrei[a-z2-7]{52}$/.test(cid))return null;let bits=0,v=0;const out=[];for(const ch of cid.slice(1)){v=(v<<5)|'abcdefghijklmnopqrstuvwxyz234567'.indexOf(ch);bits+=5;if(bits>=8){out.push((v>>(bits-8))&255);bits-=8;}}return Buffer.from(out).subarray(4).toString('hex');};

let configChanged=false,expectationsChanged=false,targetsChanged=false;const writes={};
for(const row of mine){
  const id=String(row.id).toLowerCase(),appRef=String(row.appRef),m=appRef.match(/^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i);
  if(!m){log(`${id.slice(0,10)}: appRef ${appRef} is not a catalog reference; skipped`);continue;}
  const version=await withChain(c=>c.readContract({address:catalog,abi:catAbi,functionName:'getVersion',args:[m[1],BigInt(m[2])]}));
  const vm=vms.filter(v=>String(v.name).toLowerCase()===id&&v.status==='running'&&v.appReady===true&&!v.launching&&
      String(v.catalog?.app).toLowerCase()===m[1].toLowerCase()&&Number(v.catalog?.version)===Number(m[2])&&v.cid===String(version.cid))
    .sort((x,y)=>Number(y.startedAt)-Number(x.startedAt))[0];
  if(!vm){log(`${id.slice(0,10)}: no ready partition runs ${appRef} yet; waiting`);continue;}
  const profile=Number(vm.gpuMilli)>0?policy.gpu:policy.cpu,digest=rawDigest(vm.cid);
  const secrets=vm.derivation===V6,bundle=secrets||vm.derivation===V5;
  if(!HEX64.test(vm.appId||'')||!profile?.runtimeId||vm.runtimeId!==profile.runtimeId||(digest&&digest!==vm.componentSha256)||
     (bundle&&profile.configBundleV5!==true)||(secrets&&(profile.secretsV1!==true||String(vm.secretDeployment).toLowerCase()!==id))){
    log(`${id.slice(0,10)}: the manager's record is outside the admitted Shield policy; skipped`);continue;}
  const expected={appRef,configCid:String(row.configCid),appSha256:vm.appId,runtimeId:vm.runtimeId,requiresConfigBundleV5:bundle,requiresSecretsV1:secrets,...(bundle&&JSON.parse(snap.expected?.[id]||'{}').requiresConfigSocketServer===true?{requiresConfigSocketServer:true}:{})};
  const existing=cfg.apps.find(a=>a.deploymentId===id);
  if(existing){
    const cur=snap.expected?.[id]??null;
    if(cur===null||JSON.stringify(JSON.parse(cur))!==JSON.stringify(expected)){
      const was=cur?JSON.parse(cur):{};
      log(`${id.slice(0,10)}: expectation ${String(was.appRef).split('/').pop()}->${appRef.split('/').pop()} app ${String(was.appSha256).slice(0,8)}->${expected.appSha256.slice(0,8)}`);
      writes[id+'\\expected.json']=JSON.stringify(expected);expectationsChanged=true;
    }
    if(domains){const names=namesFor(id);if(JSON.stringify(names)!==JSON.stringify(existing.names)){log(`${id.slice(0,10)}: names ${existing.names} -> ${names}`);existing.names=names;configChanged=true;}}
    continue;
  }
  // enrollment
  if(!domains){log(`${id.slice(0,10)}: new, but the domain map is unavailable; enrolling next round`);continue;}
  log(`${id.slice(0,10)}: enrolling (${namesFor(id).join(', ')})`);
  if(DRY)continue;
  const wallets=JSON.parse(await ps(
    "$d=Join-Path $a $in;New-Item -ItemType Directory -Force -Path $d|Out-Null;$w=@();"+
    "foreach($slot in 0,1){$o=[ordered]@{};foreach($role in 'guard','public','egress'){$s=Join-Path $d \"$slot-$role.seed\";"+
    "if(Test-Path $s){$r=& \"$a\\enclave-tuna.exe\" --wallet-address $s}else{$r=& \"$a\\enclave-tuna.exe\" --init-wallet $s};if($LASTEXITCODE -ne 0){throw \"wallet $s\"};"+
    "$o[$role]=[ordered]@{address=($r|ConvertFrom-Json).address;fundedNkn='0.25';seedFile=$s}};$w+=$o};$out=(ConvertTo-Json -InputObject $w -Depth 3 -Compress)",id));
  if(!Array.isArray(wallets)||wallets.length!==2||wallets.some(w=>['guard','public','egress'].some(r=>!/^NKN[1-9A-HJ-NP-Za-km-z]{33}$/.test(w[r]?.address||''))))throw new Error(`${id.slice(0,10)}: wallet creation returned ${JSON.stringify(wallets)}`);
  const label='nb-'+id.slice(0,10),addrs=wallets.flatMap(w=>['guard','public','egress'].map(r=>w[r].address));
  if(!targets.some(l=>l.startsWith(label+' '))){targets.push(`${label} 0.25 ${addrs.join(' ')}`);targetsChanged=true;}
  const bal=await Promise.all(addrs.map(balanceOf));
  if(bal.some(b=>b===null||b<MIN_FUNDED)){
    if(targetsChanged){await writeAtomic(targetsFile,targets.join('\n')+'\n',0o644);targetsChanged=false;}
    log(`${id.slice(0,10)}: funding its wallets; enrolled once they confirm`);
    await run(topup,[],{timeout:600000}).catch(e=>log('top-up: '+String(e.stderr||e.message).split('\n').slice(-3).join(' ')));
    continue;
  }
  writes[id+'\\wallets.json']=JSON.stringify(wallets);writes[id+'\\expected.json']=JSON.stringify(expected);
  cfg.apps.push({deploymentId:id,names:namesFor(id),walletsFile:remote(id+'\\wallets.json'),expectedFile:remote(id+'\\expected.json'),publishToMirror:true});
  configChanged=true;log(`${id.slice(0,10)}: enrolled`);
}
if(targetsChanged&&!DRY)await writeAtomic(targetsFile,targets.join('\n')+'\n',0o644);
if((configChanged||expectationsChanged)&&!DRY){
  if(configChanged)writes['privacy-config.json']=JSON.stringify(cfg,null,2);
  // Each file is written beside its target and moved over it (the previous copy kept with a timestamp);
  // the config goes last, and is touched when only expectations changed, which is what reloads the agent.
  const order=Object.keys(writes).sort((x,y)=>(x==='privacy-config.json')-(y==='privacy-config.json'));
  await ps("$w=$in|ConvertFrom-Json;$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ');$enc=New-Object Text.UTF8Encoding($false);"+
    "foreach($p in $w.order){if($p -notmatch '^(0x[0-9a-f]{64}\\\\(expected|wallets)\\.json|privacy-config\\.json)$'){throw \"refused path $p\"};"+
    "$f=Join-Path $a $p;[IO.File]::WriteAllText(\"$f.tmp\",$w.files.$p,$enc);if(Test-Path $f){Copy-Item $f \"$f.$stamp\"};Move-Item -Force \"$f.tmp\" $f};"+
    "(Get-Item \"$a\\privacy-config.json\").LastWriteTimeUtc=[DateTime]::UtcNow;$out='ok'",JSON.stringify({order,files:writes}));
  log('agent config '+(configChanged?'written':'touched')+'; the agent reloads within 30 s');
}
log(`${mine.length} leased apps checked; ${configChanged||expectationsChanged?'changes applied':'no changes'}${DRY?' (dry run)':''}`);
