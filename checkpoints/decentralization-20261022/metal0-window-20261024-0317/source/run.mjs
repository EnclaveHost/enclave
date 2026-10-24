// Root-only finite incident operation. No automatic approval, initialization, polling, service stops or retries.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {extendWindow,digest,validateApproval,LIMIT} from './window.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),parent=path.dirname(here),old=path.join(parent,'custody-protected-lease-keeper-20261023');
const refuse=()=>{throw Error('maintenance window runtime precondition failed');};
const checkSource=()=>{for(const [name,sha] of [['deps.mjs','1a32baed32e47e1ca89ab2aabf96b00bb3a0d820cba7308c7f15cbe9c4382dcb'],['lib.mjs','2f45331948e1768b3ace1481da66432bda1313f062e8cf9c4559bd0a0dd3086b']])if(digest(fs.readFileSync(path.join(old,name)))!==sha)refuse();};
const stopped=async()=>{
 for(const name of ['enclave-metal.service','enclave-custody-protected-leases-20261023.service']){
  let s;try{s=execFileSync('/usr/bin/systemctl',['--user','show',name,'-p','ActiveState','-p','SubState','-p','MainPID'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});}catch{refuse();}
  const r=Object.fromEntries(s.trim().split('\n').map(x=>x.split('=')));if(!['inactive','failed'].includes(r.ActiveState)||r.MainPID!=='0')refuse();
 }
};
const health=async()=>{let v;try{v=JSON.parse(execFileSync('python3',[path.join(parent,'custody-v2-live-20261023/probes/protected-public-health.py')],{encoding:'utf8',timeout:40000,maxBuffer:16384,stdio:['ignore','pipe','pipe']}));}catch{refuse();}if(v.ok!==true||v.apps.length!==2)refuse();};
try{
 const [file,approvalHash]=process.argv.slice(2);if(!file||!/^[a-f0-9]{64}$/.test(approvalHash??''))refuse();
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>16384)refuse();
 const approval=JSON.parse(fs.readFileSync(file,'utf8'));validateApproval(approval,Math.floor(Date.now()/1000));if(digest(JSON.stringify(approval))!==approvalHash)refuse();checkSource();
 const {lock}=await import(pathToFileURL(path.join(old,'lib.mjs')).href),dir=path.join(here,'private');
 // Root must create this ONE fixed 0700 directory after approval. There is no --init or alternate journal path.
 const ds=fs.lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||(ds.mode&0o777)!==0o700)refuse();
 const unlock=lock(dir);if(!unlock)refuse();const timer=setTimeout(()=>{process.stderr.write('maintenance window timed out; reconcile journal before any retry\n');process.exit(3);},240000);
 try{
  const repo=path.join(parent,'custody-recipient-restore-20261023/repo');
  for(const [rel,sha] of [['client/lease-executor-authority.mjs','88dd8a6adca0a744416f3c467739503a5370f23fae1dfc738233705d81eaab99'],['network/lease-gas-owner.mjs','a3163e386c2718dd31cdbf91ecc0eab3865c2c34d46b33809bbede6ab340cde9'],['client/lease-executor-client.mjs','5193da71542098cbad98a723be575abc575147e0a9649e804d27697c8e3c7dfe']])if(digest(fs.readFileSync(path.join(repo,rel)))!==sha)refuse();
  const {createPublicClient,http}=await import(pathToFileURL(path.join(repo,'node_modules/viem/_esm/index.js')).href);
  const clients=['https://mainnet.base.org','https://base-rpc.publicnode.com'].map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
  const guardedStop=async()=>{await stopped();const rows=await Promise.all(clients.map(async c=>{if(await c.getChainId()!==8453)refuse();return Promise.all([c.getCode({address:LIMIT.operator}),c.getTransactionCount({address:LIMIT.operator,blockTag:'latest'}),c.getTransactionCount({address:LIMIT.operator,blockTag:'pending'})]);}));if(rows.some(r=>r[0]?.toLowerCase()!=='0xef0100'+LIMIT.executor.slice(2)||r[1]!==r[2])||rows[0][1]!==rows[1][1])refuse();await stopped();};
  const {deps}=await import(pathToFileURL(path.join(old,'deps.mjs')).href);
  const result=await extendWindow({oldDir:path.join(old,'state'),dir,approval,approvalHash,deps,stopped:guardedStop,health});console.log(JSON.stringify(result));
 }
 finally{clearTimeout(timer);unlock();}
}catch{console.error('maintenance window refused or uncertain; inspect the private journal through the reviewed reconciliation procedure before retrying');process.exitCode=3;}
