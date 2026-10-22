// Native kill-on-close canary for the circuit firewall sandbox (NATIVE-BOUNDARY-REVIEW.txt). ROOT RUNS IT; elevated, on minipc.
// Question: when WgCircuitRuntime.close() kills a sandbox process (child.stdin.destroy(); child.kill(); await its 'exit'),
// are the sandboxed worker AND its descendants gone, with their sockets closed, before close() would resolve?
//
// What is real: the deployed enclave-circuit-firewall.exe (install / sandbox / remove), the deployed node.exe as the worker
// (production's ingress worker is a copy of node.exe named worker.exe; here the same bytes under a UNIQUE name
// hold-worker-<nonce>.exe, so the firewall's remove matches no live process by basename), AppContainer + WFP + kill-on-close job, real
// loopback TCP streams. The kill sequence is wg-circuit-runtime.mjs launch()/close() verbatim (block sha c196db4c...).
// What is scratch: a unique staging root, unique enclave-circuit-<32 hex> identities (AppContainer profile, WFP sublayer,
// loopback exemption), each removed by the firewall's own `remove` on exactly its own manifest. Nothing else is touched.
//
//   node.exe kill-canary.mjs --firewall <exe> --firewall-sha <hex> --node-sha <hex> --scratch-parent <dir>
//   exit 0 PASS / 1 FAIL (all cleaned) / 2 REFUSED (nothing created) / 3 FAIL or PASS with KEPT scratch (see KEPT lines)
//   --mock (Linux only, local logic check with mock-firewall.mjs; proves nothing native)
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const T0=Date.now(),now=()=>Date.now()-T0;
const emit=o=>console.log(JSON.stringify({t:now(),...o}));
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:undefined;};
const mock=process.argv.includes('--mock');
const K2=Number(arg('--k2')??2);if(!Number.isInteger(K2)||K2<2||K2>4)throw Error('--k2 is 2..4');
let exitCode=0;const refuse=m=>{emit({type:'REFUSED',message:m});process.exit(2);};
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=(file,argv,timeout)=>new Promise(resolve=>{const t=Date.now();
 execFile(file,argv,{timeout,windowsHide:true,maxBuffer:1<<20},(e,stdout,stderr)=>resolve({code:e?(e.code??(e.killed?'timeout':-1)):0,stdout:String(stdout),stderr:String(stderr),ms:Date.now()-t}));});

// The holder runs inside the sandbox (role worker) and starts one DETACHED grandchild (role grandchild): detached, so
// that only the sandbox's job (not libuv's per-child job inside the worker) can end it. Each holds one loopback TCP
// stream to this driver, says who it is, then sends one byte every 100 ms. --eval: no main-file realpath walk (E2 repair).
// No double quotes or backslashes: windows.EscapeArg then only wraps it in quotes (E2-REPAIR-RESULT 2).
const HOLDER=[
 "import net from 'node:net';import {spawn} from 'node:child_process';",
 "const [port,role]=process.argv.slice(2);const nl=String.fromCharCode(10);",
 "const s=net.connect({host:'127.0.0.1',port:Number(port)});",
 "s.on('connect',()=>{s.write(JSON.stringify({role,pid:process.pid,ppid:process.ppid})+nl);setInterval(()=>s.write('.'),100);});",
 "s.on('error',()=>process.exit(3));s.on('close',()=>process.exit(4));",
 "if(role==='worker'){try{const c=spawn(process.execPath,[...process.execArgv,'holder.mjs',port,'grandchild'],{detached:true,stdio:'ignore',windowsHide:true});c.on('error',e=>s.write(JSON.stringify({role:'spawn-error',message:String(e.message)})+nl));c.unref();}",
 "catch(e){s.write(JSON.stringify({role:'spawn-error',message:String(e.message)})+nl);}}",
 "setInterval(()=>{},60000);"].join('');
if(/["\\]/.test(HOLDER)||HOLDER.length>8000)throw Error('holder text must stay quote/backslash free');

// ---- preflight: nothing is created before every check passes
const firewall=arg('--firewall'),parent=arg('--scratch-parent');
if(mock&&process.platform==='win32')refuse('--mock is a local logic check only');
if(!mock&&process.platform!=='win32')refuse('native canary: Windows only');
if(!firewall||!path.isAbsolute(firewall)||!fs.existsSync(firewall))refuse('--firewall <absolute path> required');
if(!parent||!path.isAbsolute(parent)||!fs.statSync(parent,{throwIfNoEntry:false})?.isDirectory())refuse('--scratch-parent <existing absolute dir> required');
if(!mock){
 const fw=sha(firewall),nd=sha(process.execPath);
 emit({type:'HASH',file:firewall,sha256:fw});emit({type:'HASH',file:process.execPath,sha256:nd,version:process.version});
 if(fw!==arg('--firewall-sha'))refuse('firewall binary differs from --firewall-sha');
 if(nd!==arg('--node-sha'))refuse('node.exe differs from --node-sha');
 const elevated=await run('fltmc.exe',[],15000);if(elevated.code!==0)refuse('elevated (Administrator) session required');
}
const root=path.join(parent,'hold-kill-canary-'+crypto.randomBytes(6).toString('hex'));
// recovery locator first, next to this script, then the root (exclusive): an interrupted run leaves a pointer
const locator=path.join(path.dirname(fileURLToPath(import.meta.url)),path.basename(root)+'.locator.txt');
fs.writeFileSync(locator,root+'\n',{flag:'wx'});fs.mkdirSync(root);emit({type:'ROOT',root,locator});

// ---- the driver's loopback listener: one record per connection, keyed by the reported pid
const streams=new Map(),pending=[],ids=new Map(); // ids: pid -> Promise<'image|creation'> recorded when it said hello
const server=net.createServer(sock=>{
 const r={sock,hello:null,beats:0,lastAt:null,closedAt:null,buf:''};sock.on('error',()=>{});
 sock.on('data',b=>{r.lastAt=now();if(r.hello){r.beats+=b.length;return;}r.buf+=b.toString('latin1');const i=r.buf.indexOf('\n');
  if(i<0)return;try{r.hello=JSON.parse(r.buf.slice(0,i));}catch{r.hello={role:'garbled'};}r.beats+=r.buf.length-i-1;
  if(r.hello.role==='spawn-error')emit({type:'NOTE',message:'grandchild spawn refused: '+r.hello.message});
  else{streams.set(r.hello.pid,r);if(Number.isInteger(r.hello.pid)&&!ids.has(r.hello.pid))ids.set(r.hello.pid,identityOf(r.hello.pid));}});
 sock.on('close',()=>{r.closedAt=now();});pending.push(r);});
await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
const port=server.address().port;emit({type:'LISTEN',port});

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM'?'eperm':false;}};
async function imagePath(pid){
 if(mock){try{return fs.readlinkSync('/proc/'+pid+'/exe');}catch{return null;}}
 const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').ExecutablePath`],20000);
 return r.code===0?r.stdout.trim()||null:null;
}
// a process identity: image path + creation time, so a recycled pid is never mistaken for one of ours
async function identityOf(pid){
 if(mock){try{return fs.readlinkSync('/proc/'+pid+'/exe')+'|'+fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch{return null;}}
 const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | ForEach-Object { [string]$_.ExecutablePath + '|' + $_.CreationDate.ToUniversalTime().ToString('o') }`],20000);
 return r.code===0?r.stdout.trim()||null:null;
}
// End one of OUR processes: wait up to waitMs for it to exit by itself; if still alive, kill it ONLY when it is still the
// recorded process (same image and creation time); then wait up to 10 s more. -> gone | killed | not-ours | left
async function endOurs(pid,why,waitMs=10000){
 const live=()=>alive(pid)!==false;
 for(const end=Date.now()+waitMs;Date.now()<end&&live();)await sleep(50);
 if(!live())return 'gone';
 const want=await ids.get(pid),have=await identityOf(pid);
 if(!want||have!==want){emit({type:'NOTE',pid,why,message:'a live pid that is not the recorded process: not touched'});return 'not-ours';}
 emit({type:'CLEANUP',pid,why,kill:true});
 if(mock){try{process.kill(pid,'SIGKILL');}catch{}}else await run('taskkill.exe',['/F','/PID',String(pid)],20000);
 for(const end=Date.now()+10000;Date.now()<end&&live();)await sleep(50);
 return live()?'left':'killed';
}
const same=(a,b)=>!!a&&!!b&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function waitFor(f,ms,what){const end=Date.now()+ms;while(Date.now()<end){const v=f();if(v)return v;await sleep(20);}throw Error('timeout: '+what);}

// ---- one scratch circuit: install a worker-shaped policy (the E2 shape that passed natively) and launch its sandbox
const circuits=[];
async function circuit(label){
 const dir=path.join(root,'enclave-circuit-'+crypto.randomBytes(16).toString('hex')),exe=path.join(dir,'hold-worker-'+crypto.randomBytes(4).toString('hex')+'.exe');
 fs.mkdirSync(dir);fs.copyFileSync(process.execPath,exe);
 const c={label,dir,exe,installed:false,removed:false,pids:{}};circuits.push(c);
 const cfg=path.join(dir,'firewall-config.json');
 fs.writeFileSync(cfg,JSON.stringify({directory:dir,appContainer:true,programs:[{path:exe,connect:['127.0.0.1:'+port],listen:[]}]}));
 const ins=await run(firewall,['install',cfg],60000);c.installed=fs.existsSync(path.join(dir,'firewall.json'));
 if(ins.code!==0)throw Error(`${label} install exit ${ins.code}: ${(ins.stdout+ins.stderr).slice(0,300)}`);
 const sb=path.join(dir,'worker-sandbox.json');
 fs.writeFileSync(sb,JSON.stringify({directory:dir,executable:exe,args:['--input-type=module','--eval',HOLDER,'holder.mjs',String(port),'worker']}));
 // wg-circuit-runtime.mjs launch(): spawn(firewallBinary,['sandbox',<json>],{stdio:['pipe','pipe','pipe'],windowsHide:true})
 const child=spawn(firewall,['sandbox',sb],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const exited=new Promise(r=>{child.once('error',r);child.once('exit',r);});child.stdin.on('error',()=>{});
 let err='';child.stderr.on('data',b=>{err+=b;});child.stdout.on('data',()=>{});
 Object.assign(c,{child,exited,stderr:()=>err});
 const m=await waitFor(()=>/AppContainer verified: (S-1-15-2-[0-9-]+), PID (\d+)/.exec(err),20000,label+' sandbox start');
 c.sid=m[1];c.pids.worker=Number(m[2]);
 const w=await waitFor(()=>streams.get(c.pids.worker),20000,label+' worker stream');
 const g=await waitFor(()=>[...streams.values()].find(s=>s.hello.role==='grandchild'&&s.hello.ppid===c.pids.worker),20000,label+' grandchild stream');
 c.pids.grandchild=g.hello.pid;
 await waitFor(()=>w.beats>=3&&g.beats>=3,10000,label+' heartbeats');
 // identity: the worker the sandbox started is the one on our stream, its parent is the sandbox, the grandchild is its child
 c.identity={sandboxPid:child.pid,workerPid:c.pids.worker,workerPpid:w.hello.ppid,grandchildPid:g.hello.pid,grandchildPpid:g.hello.ppid,sid:c.sid,
  ok:w.hello.ppid===child.pid&&g.hello.ppid===c.pids.worker&&same(await imagePath(c.pids.worker),exe)};
 return c;
}
function snapshot(c,at){
 const s={};for(const role of ['worker','grandchild']){const pid=c.pids[role],r=streams.get(pid);s[role]={pid,alive:alive(pid),closed:r?.closedAt!=null&&r.closedAt<=at,closedAt:r?.closedAt??null,lastAt:r?.lastAt??null};}
 return s;
}
// wg-circuit-runtime.mjs close(): c.stdin.destroy(); if(c.exitCode===null)c.kill(); await Promise.all(exits); then (Windows)
// `firewall remove <folder>\firewall.json` for each installed folder; close() resolves only after those.
async function closeLikeRuntime(c){
 const killAt=now();c.child.stdin.destroy();if(c.child.exitCode===null)c.child.kill();
 await Promise.race([c.exited,sleep(30000).then(()=>{throw Error(c.label+' sandbox did not exit within 30 s');})]);
 const exitAt=now(),atExit=snapshot(c,exitAt);
 const rm=await run(firewall,['remove',path.join(c.dir,'firewall.json')],20000);
 const removeAt=now(),atRemove=snapshot(c,removeAt);c.removed=rm.code===0;
 return {killAt,exitAt,sandboxExit:c.child.exitCode,atExit,removeAt,remove:{code:rm.code,ms:rm.ms,panic:(/panic: (.*)/.exec(rm.stderr+rm.stdout)||[])[1]||null},atRemove};
}
async function observe(c,res){
 // up to 3 s: when each stream closed, and any heartbeat that arrived later than 200 ms after the sandbox exit
 const end=Date.now()+3000;while(Date.now()<end&&['worker','grandchild'].some(r=>streams.get(c.pids[r])?.closedAt==null||alive(c.pids[r])))await sleep(10);
 const late={};for(const role of ['worker','grandchild']){const r=streams.get(c.pids[role]);late[role]={closedAt:r?.closedAt??null,aliveAfter3s:alive(c.pids[role]),lastBeatAt:r?.lastAt??null,
  beatAfterExit:r?.lastAt!=null&&r.lastAt>res.exitAt+200};}
 res.after=late;
 const gone=s=>s.alive===false;
 res.verdict={
  identity:c.identity.ok,
  // strict: already gone when close()'s `await Promise.all(exits)` resumes
  goneAtExit:gone(res.atExit.worker)&&gone(res.atExit.grandchild),
  // the property root needs: gone, streams closed, no further bytes, by the time close() would resolve (after remove)
  goneBeforeCloseResolves:gone(res.atRemove.worker)&&gone(res.atRemove.grandchild)&&res.atRemove.worker.closed&&res.atRemove.grandchild.closed&&!late.worker.beatAfterExit&&!late.grandchild.beatAfterExit,
  removeOk:res.remove.code===0};
 return res;
}

const results=[];
const control={child:null,pids:{}}; // N1's plain parent and grandchild: tracked before any assertion can throw
try{
 // K1: one circuit at a time, three times
 for(let i=1;i<=3;i++){const c=await circuit('K1.'+i);emit({type:'UP',label:c.label,identity:c.identity});
  const r=await observe(c,await closeLikeRuntime(c));results.push({label:c.label,...r});emit({type:'RESULT',label:c.label,...r});}
 // K2: --k2 (default 2; root pins 2) circuits closed at once (production's remove failures cluster at mass closes)
 const batch=[];for(let i=1;i<=K2;i++)batch.push(await circuit('K2.'+i));for(const c of batch)emit({type:'UP',label:c.label,identity:c.identity});
 const closes=await Promise.all(batch.map(c=>closeLikeRuntime(c)));
 for(const [i,c] of batch.entries()){const r=await observe(c,closes[i]);results.push({label:c.label,...r});emit({type:'RESULT',label:c.label,...r});}
 // N1 negative control: the same detector, the same kill, a parent that is NOT a kill-on-close sandbox (plain node.exe).
 // Its detached grandchild must be reported surviving; otherwise the detector cannot see a survivor and nothing above counts.
 {
  const child=control.child=spawn(process.execPath,['--input-type=module','--eval',HOLDER,'holder.mjs',String(port),'worker'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  control.pids.worker=child.pid;
  const exited=new Promise(r=>{child.once('error',r);child.once('exit',r);});child.stdin.on('error',()=>{});
  const w=await waitFor(()=>streams.get(child.pid),20000,'N1 worker stream');
  const g=await waitFor(()=>[...streams.values()].find(s=>s.hello.role==='grandchild'&&s.hello.ppid===child.pid),20000,'N1 grandchild stream');
  await waitFor(()=>w.beats>=3&&g.beats>=3,10000,'N1 heartbeats');
  control.pids.grandchild=g.hello.pid;
  const n={label:'N1',pids:{worker:child.pid,grandchild:g.hello.pid},identity:{ok:w.hello.ppid===process.pid&&g.hello.ppid===child.pid}};
  child.stdin.destroy();if(child.exitCode===null)child.kill();await exited;const exitAt=now();await sleep(1500);
  const gs=streams.get(n.pids.grandchild);
  const survived=alive(n.pids.grandchild)===true&&gs.closedAt==null&&gs.lastAt>exitAt+1000;
  emit({type:'CONTROL',label:'N1',identity:n.identity,workerGone:alive(child.pid)===false,grandchildSurvivedAndStillSending:survived});
  results.push({label:'N1',control:true,identity:n.identity.ok,survived});
  // the control's survivor is ours (recorded identity): end it now and prove it gone
  const ended=await endOurs(n.pids.grandchild,'N1 survivor',0);emit({type:'CONTROL-CLEANUP',pid:n.pids.grandchild,result:ended});
  if(ended!=='killed'&&ended!=='gone')throw Error('N1 survivor not ended: '+ended);
 }
}catch(e){exitCode=1;emit({type:'FAIL',message:e.message});}
finally{
 // 1. every stream ends: a holder exits when its stream closes or errors
 server.close();for(const r of pending)r.sock.destroy();
 // 2. every parent: each sandbox (as close() does) and N1's plain node parent
 for(const p of [...circuits.map(c=>c.child),control.child])try{p?.stdin?.destroy();if(p&&p.exitCode===null&&p.signalCode===null)p.kill();}catch{}
 // 3. every process this run recorded (each holder that said hello, N1's parent): bounded wait, identity-checked kill, verify
 if(control.pids.worker&&!ids.has(control.pids.worker))ids.set(control.pids.worker,identityOf(control.pids.worker));
 const tracked=[...new Set([...ids.keys(),...circuits.flatMap(c=>Object.values(c.pids)),...Object.values(control.pids)])].filter(Number.isInteger);
 const ends={};for(const pid of tracked)ends[pid]=await endOurs(pid,'cleanup');
 const left=tracked.filter(pid=>ends[pid]==='left');
 emit({type:'CLEANUP-PROCESSES',tracked:tracked.length,ends,left});if(left.length)exitCode=Math.max(exitCode,3);
 // 4. each scratch circuit's own manifest, nothing else
 for(const c of circuits){
  if(c.installed&&!c.removed)for(let i=0;i<3&&!c.removed;i++){if(i)await sleep(2000);const rm=await run(firewall,['remove',path.join(c.dir,'firewall.json')],20000);c.removed=rm.code===0;
   if(!c.removed)emit({type:'CLEANUP',label:c.label,removeAttempt:i+1,code:rm.code,panic:(/panic: (.*)/.exec(rm.stderr+rm.stdout)||[])[1]||null});}
  let state=null;try{state=JSON.parse(fs.readFileSync(path.join(c.dir,'firewall.json'),'utf8')).state;}catch{}
  if(c.installed&&(!c.removed||state!=='removed')){emit({type:'KEPT',dir:c.dir,state});exitCode=Math.max(exitCode,3);continue;}
  try{fs.rmSync(c.dir,{recursive:true,force:false,maxRetries:5,retryDelay:500});}catch(e){emit({type:'KEPT',dir:c.dir,error:e.code});exitCode=Math.max(exitCode,3);}
 }
 if(exitCode<3){try{fs.rmdirSync(root);fs.unlinkSync(locator);}catch(e){emit({type:'KEPT',dir:root,error:e.code});exitCode=3;}}
}
// summary: the property holds only if every K circuit holds it AND the control proves the detector sees survivors
const ks=results.filter(r=>!r.control),n1=results.find(r=>r.control);
const summary={circuits:ks.length,identityAll:ks.every(r=>r.verdict.identity),goneBeforeCloseResolvesAll:ks.length===3+K2&&ks.every(r=>r.verdict.goneBeforeCloseResolves),
 goneAtExit:ks.filter(r=>r.verdict.goneAtExit).length,removeOk:ks.filter(r=>r.verdict.removeOk).length,removePanics:ks.map(r=>r.remove.panic).filter(Boolean),
 controlDetectsSurvivor:!!n1&&n1.identity&&n1.survived};
const pass=exitCode!==1&&summary.identityAll&&summary.goneBeforeCloseResolvesAll&&summary.controlDetectsSurvivor;
emit({type:'SUMMARY',...summary,property:pass?'PASS':'FAIL'});
console.log('KILL-CANARY-RC='+(exitCode===3?3:pass?0:1));process.exit(exitCode===3?3:pass?0:1);
