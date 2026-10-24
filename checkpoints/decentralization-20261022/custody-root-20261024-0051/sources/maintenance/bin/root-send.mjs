#!/usr/bin/env node
// Root-only operational wiring. NEVER run without the explicit reviewed approval and a quiesced host.
// Usage: root-send.mjs run PLAN APPROVAL APPROVAL_SHA PRIVATE_JOURNAL
//        root-send.mjs resume PLAN PRIVATE_JOURNAL [--rebroadcast]
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {privateKeyToAccount} from 'viem/accounts';
import {createSender,checkExecutablePlan,checkApproval} from '../lib/sender.mjs';
import {PRODUCTION,sha256} from '../lib/maintenance.mjs';
const [mode,planFile,...args]=process.argv.slice(2);
try {
 if(!['run','resume'].includes(mode)||!planFile)throw Error('usage');
 const planText=fs.readFileSync(planFile,'utf8'),plan=JSON.parse(planText);
 checkExecutablePlan(PRODUCTION,plan);
 if(mode==='resume'){
  if(args.length<1||args.length>2||(args[1]&&args[1]!=='--rebroadcast'))throw Error('usage');
  const out=await createSender({journalDir:args[0]}).resume({planText,rebroadcast:args[1]==='--rebroadcast'});
  console.log(JSON.stringify(out));process.exitCode=out.status==='verified'?0:3;
 }else{
  if(args.length!==3)throw Error('usage');
  const [approvalFile,approvalSha256,journalDir]=args,approvalText=fs.readFileSync(approvalFile,'utf8');
  checkApproval(PRODUCTION,plan,'0x'+sha256(planText),approvalText,approvalSha256,Math.floor(Date.now()/1000));
  for(const unit of ['enclave-metal.service','enclave-custody-protected-leases-20261023.service']){
   const state=execFileSync('systemctl',['--user','show',unit,'-p','ActiveState','--value'],{encoding:'utf8',timeout:10000}).trim();
   if(!['inactive','failed'].includes(state))throw Error('operator signers are not stopped');
  }
  const operator=privateKeyToAccount(JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json','utf8')).registryKey);
  const pid=execFileSync('systemctl',['--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],{encoding:'utf8',timeout:10000}).trim();
  if(!/^\d+$/.test(pid)||Number(pid)<=1)throw Error('submitter service unavailable');
  const field=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').find(x=>x.startsWith('CUSTODY_SUBMITTER_KEY='));
  if(!field)throw Error('submitter unavailable');
  const sponsor=privateKeyToAccount(field.slice(field.indexOf('=')+1));
  const signers={operator:{address:operator.address,signAuthorization:t=>operator.signAuthorization({chainId:t.chainId,contractAddress:t.address,nonce:t.nonce})},sponsor};
  const out=await createSender({journalDir,signers}).run({planText,approvalText,approvalSha256});
  console.log(JSON.stringify(out));process.exitCode=out.status==='verified'?0:3;
 }
}catch(e){console.error(JSON.stringify({status:'refused-or-recovery-required',code:typeof e.code==='string'?e.code:'error',instruction:'Inspect the private journal and public chain; never start another signing attempt for an unresolved plan.'}));process.exitCode=3}
