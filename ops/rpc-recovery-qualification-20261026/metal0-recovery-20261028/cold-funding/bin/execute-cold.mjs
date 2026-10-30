#!/usr/bin/env node
// One root-authorized cold maintenance. No output contains keys, raw transactions, or private configuration.
import fs from 'node:fs';import path from 'node:path';import{execFileSync}from'node:child_process';import{privateKeyToAccount}from'viem/accounts';
import{PRODUCTION as P,COLD,coldProfileSha256,createPreparer,sha256,timingSha256}from'../lib/maintenance.mjs';import{createSender,checkApproval,checkExecutablePlan,COLD_APPROVAL_KIND,journalStore}from'../lib/sender.mjs';import{evaluateColdHost,authorizeKeyAccess}from'../lib/cold-host-gate.mjs';import{hostIo}from'../lib/runtime-hostio.mjs';import{createHoldGuard}from'../lib/sponsor-hold-guard.mjs';
const [evidence,journalDir,holdFile,grantFile]=process.argv.slice(2);
try{
 if(!grantFile)throw Error('explicit evidence, private journal, hold receipt and authority record required');
 const grant=JSON.parse(fs.readFileSync(grantFile,'utf8'));
 if(grant.kind!=='root-record-of-existing-user-authorization'||grant.sponsor!==P.sponsor||grant.operator!==P.operator||grant.valueWei!==String(P.valueWei)||grant.feeCapWei!==String(P.feeCapWei)||grant.walletTransaction!=='0x29e88beb5cf7b5b1c22bcf4185076730828e9a2ca44e0651e9d6710e72bedb3a'||Date.now()/1000>grant.expiresAt)throw Error('authority record does not match this operation');
 if(journalStore(journalDir).others('').length)throw Error('journal already exists: reconcile, never sign again');
 const quiesce=JSON.parse(fs.readFileSync(path.join(evidence,'cold-quiesce.json'),'utf8'));quiesce.providedAt=Math.floor(Date.now()/1000);
 const prepared=await createPreparer({profile:'cold'}).prepare({quiesce});const {plan,text:planText,planHash}=prepared;
 checkExecutablePlan(P,plan,'cold');
 const approval={kind:COLD_APPROVAL_KIND,approvedBy:'root',planHash,profile:COLD.marker,coldProfileSha256:coldProfileSha256(),timingProfileSha256:timingSha256(),chainId:P.chainId,operator:P.operator,executor:P.executor,sponsor:P.sponsor,valueWei:String(P.valueWei),feeCapWei:String(P.feeCapWei),expiresAt:plan.broadcastDeadline,humanApprovals:grant.humanApprovals,authorityRecordSha256:sha256(fs.readFileSync(grantFile)),walletTransaction:grant.walletTransaction};
 const approvalText=JSON.stringify(approval,null,2)+'\n',approvalSha256='0x'+sha256(approvalText);
 checkApproval(P,plan,planHash,approvalText,approvalSha256,Math.floor(Date.now()/1000),'cold');
 fs.mkdirSync(journalDir,{recursive:true,mode:0o700});const audit=journalDir+'-audit';fs.mkdirSync(audit,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(audit,'plan.json'),planText,{flag:'wx',mode:0o600});fs.writeFileSync(path.join(audit,'approval.json'),approvalText,{flag:'wx',mode:0o600});
 const stopReceiptSha256=sha256(fs.readFileSync(path.join(evidence,'cold-stop-observation.json')));const guard=createHoldGuard(holdFile);
 async function liveGate(){const host=await evaluateColdHost({plan,stopReceiptSha256,io:hostIo('/home/steven/enclave-prod/guestd-root')});if(!host.ok)throw Object.assign(Error('cold host gate refused'),{code:'cold_host',findings:host.findings});return authorizeKeyAccess({host,sponsorQuiescence:guard,plan,planHash});}
 await liveGate();
 const operator=privateKeyToAccount(JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json','utf8')).registryKey);
 const pid=execFileSync('systemctl',['--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim();
 const field=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').find(x=>x.startsWith('CUSTODY_SUBMITTER_KEY='));if(!field)throw Error('sponsor unavailable');
 const sponsor=privateKeyToAccount(field.slice(field.indexOf('=')+1));if(operator.address.toLowerCase()!==P.operator||sponsor.address.toLowerCase()!==P.sponsor)throw Error('signer identity mismatch');
 const signers={operator:{address:operator.address,signAuthorization:async t=>{await liveGate();return operator.signAuthorization({chainId:t.chainId,contractAddress:t.address,nonce:t.nonce});}},sponsor:{address:sponsor.address,signTransaction:async t=>{await liveGate();return sponsor.signTransaction(t);}}};
 const out=await createSender({profile:'cold',journalDir,signers}).run({planText,approvalText,approvalSha256});fs.writeFileSync(path.join(audit,'outcome.json'),JSON.stringify(out,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(out));process.exitCode=out.status==='verified'?0:3;
}catch(e){console.error(JSON.stringify({status:'refused-or-recovery-required',code:typeof e.code==='string'?e.code:'error',instruction:'Read private audit and journal; no new signing attempt for any existing signed journal.'}));process.exitCode=3;}
