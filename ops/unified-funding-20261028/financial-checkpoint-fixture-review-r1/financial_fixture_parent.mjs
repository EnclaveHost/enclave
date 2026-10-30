// SOURCE ONLY, NOT RUN. Review exact profile/resource envelope before execution.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
const profileFile=process.argv[2];
if(process.argv[3]!=='--execute-owned-financial-fixture')throw Error('explicit owned-fixture flag required');
const p=JSON.parse(fs.readFileSync(profileFile));
if(!p.syntheticOnly||p.productionAcceptance!==false||!p.ownedRoot.startsWith('/var/tmp/enclave-financial-fixture-'))throw Error('profile scope');
if(!fs.readFileSync('/proc/self/cgroup','utf8').includes('/'+p.expectedUnit))throw Error('dedicated owned cgroup required');
if(fs.readlinkSync('/proc/self/ns/net')===fs.readlinkSync('/proc/1/ns/net'))throw Error('isolated network namespace required');
if(fs.readFileSync('/proc/net/route','utf8').trim().split('\n').length!==1)throw Error('no external IPv4 route permitted');
if(process.env.NODE_OPTIONS||process.env.LD_PRELOAD)throw Error('no preload');
function digestFile(file){const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),b=Buffer.alloc(65536);try{for(let n;(n=fs.readSync(fd,b))>0;)h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
for(const [file,hash] of Object.entries(p.pins))if(digestFile(file)!==hash)throw Error('source drift');
if(fs.existsSync(p.ownedRoot))throw Error('exclusive fixture root already exists');
fs.mkdirSync(p.ownedRoot,{mode:0o700});
const {parseTransaction}=await import(pathToFileURL(p.viemIndex));
const childSource=path.join(path.dirname(fileURLToPath(import.meta.url)),'financial_fixture_child.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const modes=['A_pre_record','B_rpc_held','C_replacement','D_write_fail','D_rename_fail','D_stale_same','E_sigkill','F_pruned_unknown','F_archived_unknown','G_exit_send'];
const report=[];
function predicate(f) {
  const reasons=[];
  if(!f.profileQualified)reasons.push('source profile changed');
  if(!f.ownedChildDead||f.signal!=='SIGTERM'||f.code!==0)reasons.push('clean writer death not established');
  if(!f.checkpointMarkerMatches)reasons.push('final checkpoint not established');
  if(!f.attributedSignalRename)reasons.push('no attributed successful final rename');
  if(f.delegations.some(x=>!x.covered))reasons.push('record missing before delegation');
  if(f.rpcNonces.some(n=>!f.coveredNonces.includes(n)))reasons.push('uncovered RPC delegation');
  if(f.retentionUnknowns.some(n=>!f.coveredNonces.includes(n)))reasons.push('pruned unresolved attempt');
  return {coverage:reasons.length?'REFUSE':'COVERED_SYNTHETIC',reasons,financialOutcome:f.rpcNonces.length?'UNKNOWN':'NO_SYNTHETIC_DELEGATION',writeResumptionAllowed:false};
}
for(const mode of modes) {
 const dir=path.join(p.ownedRoot,mode);fs.mkdirSync(dir,{mode:0o700});
 const marker=crypto.randomBytes(12).toString('hex');
 const rpcs=[],delegations=[],renames=[],held=[],sockets=new Set();let child,exited,exitResult,ready=false,armed=false,buffer='';
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',b=>{body+=b;if(body.length>16384)req.destroy();});
  req.on('end',()=>{
   try {
    const x=JSON.parse(body),reply=result=>res.end(JSON.stringify({jsonrpc:'2.0',id:x.id,result}));
    if(x.method==='eth_chainId')return reply('0x7a69');
    if(x.method!=='eth_sendRawTransaction')throw Error('unexpected RPC method');
    const tx=parseTransaction(x.params[0]);if(Number(tx.chainId)!==31337)throw Error('not TEST chain');
    rpcs.push({nonce:tx.nonce}); // Never store raw signed transaction bytes.
    if(mode==='C_replacement'&&rpcs.length===1)return reply('0x'+'11'.repeat(32));
    held.push(()=>reply('0x'+'22'.repeat(32)));
   }catch {res.statusCode=400;res.end('TEST request refused');}
  });
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cleanEnv={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:dir,TMPDIR:dir};
 let stderrBytes=0;
 try {
  child=spawn(p.node,['--max-old-space-size=96',childSource,profileFile,mode,dir,String(server.address().port),marker],{env:cleanEnv,stdio:['pipe','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exitResult={code,signal};resolve(exitResult);}));
  child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>65536)child.kill('SIGKILL');});
  child.stdout.on('data',b=>{
   buffer+=b.toString();if(buffer.length>65536){child.kill('SIGKILL');return;}
   for(let at;(at=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const x=JSON.parse(line);if(x.event==='ready')ready=true;if(x.event==='armed')armed=true;if(x.event==='delegating')delegations.push(x);if(x.event==='journalRename')renames.push(x);}catch{}}
  });
  const deadline=Date.now()+7000,want=mode==='A_pre_record'?0:mode==='C_replacement'?2:1;
  while(!(ready&&rpcs.length>=want)&&!exitResult&&Date.now()<deadline)await sleep(10);
  if(!ready||rpcs.length<want||exitResult)throw Error('fixture failed before controlled stop');
  child.stdin.write(JSON.stringify({action:'arm-final',marker})+'\n');
  const armDeadline=Date.now()+1000;
  while(!armed&&!exitResult&&Date.now()<armDeadline)await sleep(10);
  if(!armed||exitResult)throw Error('final marker not armed at held boundary');
  const signal=mode==='E_sigkill'?'SIGKILL':'SIGTERM';child.kill(signal);
  await Promise.race([exited,sleep(1500).then(()=>{if(!exitResult)throw Error('owned child stop timeout');})]);
  // A TEST exit hook may synchronously deliver into the owned receiver at death.
  await sleep(50);
  for(const respond of held)respond(); // Mock RPC can respond after child death.
  let checkpoint=null;try{checkpoint=JSON.parse(fs.readFileSync(path.join(dir,'sessions-relayer.json')));}catch{}
  const archive=mode==='F_archived_unknown'?[1000]:[];
  const facts={mode,profileQualified:mode!=='G_exit_send',ownedChildDead:!!exitResult,signal,code:exitResult.code,
   checkpointMarkerMatches:checkpoint?.fixtureMarker===marker,delegations,rpcNonces:rpcs.map(x=>x.nonce),
   attributedSignalRename:renames.some(x=>x.duringSignal),renameEvidence:'TEST fs wrapper + prepended signal marker; no production observer qualified',
   coveredNonces:[...(checkpoint?.txs||[]).map(x=>x.nonce),...archive],retentionUnknowns:mode.startsWith('F_')?[1000]:[],
   archiveScope:archive.length?'TEST known unresolved intent retained; NOT outcome resolved':'none',stderrBytes};
  const result=predicate(facts),expected=['A_pre_record','B_rpc_held','C_replacement','F_archived_unknown'].includes(mode)?'COVERED_SYNTHETIC':'REFUSE';
  report.push({facts,result,expected,passed:result.coverage===expected});
 }catch(e){report.push({mode,passed:false,error:String(e.message)});}
 finally {
  if(child&&!exitResult){child.kill('SIGKILL');await Promise.race([exited,sleep(1500)]);if(!exitResult)report.push({mode,passed:false,error:'owned child exit still unknown; outer cgroup must clean up'});}
  for(const s of sockets)s.destroy();await Promise.race([new Promise(r=>server.close(r)),sleep(1000)]);
 }
}
// H is a model of the rollback contract, NOT a tested production systemd driver.
function rollbackContract(state){if(state.tailUnknown)return {stopOwnedCandidate:true,retainGate:true,originalStopped:true,restoreJournal:false,restartOriginal:false};throw Error('outside failure fixture');}
const h=rollbackContract({tailUnknown:true,candidateStartupFailed:true});
report.push({mode:'H_rollback_contract_model',passed:h.originalStopped&&h.retainGate&&!h.restartOriginal&&!h.restoreJournal,result:h,productionDriverVerified:false});
fs.writeFileSync(path.join(p.ownedRoot,'report.json'),JSON.stringify({syntheticOnly:true,productionAcceptance:false,executed:true,cases:report},null,2),{mode:0o600});
console.log(JSON.stringify({cases:report.map(x=>({mode:x.facts?.mode||x.mode,passed:x.passed,coverage:x.result?.coverage})),productionAcceptance:false}));
if(report.some(x=>!x.passed))process.exitCode=1;
