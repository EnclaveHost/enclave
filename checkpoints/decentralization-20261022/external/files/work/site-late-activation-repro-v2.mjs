// The coordinator's late-activation scenario (work/site-late-activation-repro.mjs), ported to the fixed API: a sent
// activation is delayed before it acquires the root lock; resolve runs first; then that same activation arrives.
// Expected now: resolve settles the lost send with a durable cancel tombstone, and the late arrival cannot commit.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {prepareRelease} from './enclave/scripts/site-release/release.mjs';
import {mirrorLocal} from './enclave/scripts/site-release/targets.mjs';
import {rootActivate,rootStatus} from './enclave/scripts/site-release/root-state.mjs';
import {resolve,targetIdentity} from './enclave/scripts/site-release/rollout.mjs';
const here=path.dirname(new URL(import.meta.url).pathname);
const tmp=fs.mkdtempSync(path.join(here,'site-late-activation-v2-'));
const dir=n=>{const p=path.join(tmp,n);fs.mkdirSync(p,{recursive:true});return p;};
try{
 const inst=dir('installers');for(const n of ['install.sh','install.ps1','host.ps1'])fs.writeFileSync(path.join(inst,n),'# fixture\n');
 const releases=[];
 for(const name of ['x','y']){const dist=dir('dist-'+name);fs.writeFileSync(path.join(dist,'index.html'),'<script>'+name+'</script>');fs.writeFileSync(path.join(dist,'csp-script-src.txt'),"script-src 'self' 'sha256-"+createHash('sha256').update(name).digest('base64')+"';\n");releases.push(prepareRelease({dist,installers:inst,out:dir('out'),...(releases.length?{base:releases[0].dir}:{noBase:true})}));}
 const t={name:'t',kind:'local-root',root:dir('root'),activate:{}};
 for(const r of releases)await mirrorLocal(t,r.dir);
 const st0=await rootStatus(t);
 await rootActivate(t,{opId:randomBytes(16).toString('hex'),cid:releases[0].cid,expectGeneration:0,rootId:st0.rootId});
 const st=await rootStatus(t),opId=randomBytes(16).toString('hex'),rolloutId=randomBytes(16).toString('hex');
 const journal=path.join(dir('journal'),rolloutId+'.json');
 fs.writeFileSync(journal,JSON.stringify({v:2,rolloutId,cid:releases[1].cid,targets:[{name:'t',kind:'local-root',identity:targetIdentity(t),state:'sent',rootId:st.rootId,opId,expectGeneration:st.generation,previous:st.current}]}));
 const settled=await resolve([t],journal);
 const late=await rootActivate(t,{opId,cid:releases[1].cid,expectGeneration:st.generation,rootId:st.rootId});
 const actual=await rootStatus(t);
 const evidence={at:new Date().toISOString(),scenario:'A sent activation is delayed before it acquires the root lock. Resolve runs first. The same activation later reaches the root.',reported:settled.status,targetState:settled.targets[0].state,lateOutcome:late.outcome,lateReplay:late.replay===true,actual:{generation:actual.generation,current:actual.current},original:releases[0].cid,requested:releases[1].cid,
  fixed:settled.status==='reverted'&&settled.targets[0].state==='cancelled'&&late.outcome==='cancelled'&&actual.current===releases[0].cid&&actual.generation===st.generation};
 fs.writeFileSync(path.join(here,'site-late-activation-repro-v2.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
 if(!evidence.fixed)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
