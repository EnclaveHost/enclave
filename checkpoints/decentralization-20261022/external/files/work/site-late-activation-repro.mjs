import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {prepareRelease} from './enclave/scripts/site-release/release.mjs';
import {mirrorLocal} from './enclave/scripts/site-release/targets.mjs';
import {rootActivate,rootStatus} from './enclave/scripts/site-release/root-state.mjs';
import {resolve} from './enclave/scripts/site-release/rollout.mjs';
const tmp=fs.mkdtempSync(path.resolve('work/site-late-activation-'));
const dir=n=>{const p=path.join(tmp,n);fs.mkdirSync(p,{recursive:true});return p;};
try{
 const inst=dir('installers');for(const n of ['install.sh','install.ps1','host.ps1'])fs.writeFileSync(path.join(inst,n),'# fixture\n');
 const releases=[];
 for(const name of ['x','y']){const dist=dir('dist-'+name);fs.writeFileSync(path.join(dist,'index.html'),'<script>'+name+'</script>');fs.writeFileSync(path.join(dist,'csp-script-src.txt'),"script-src 'self' 'sha256-"+createHash('sha256').update(name).digest('base64')+"';\n");releases.push(prepareRelease({dist,installers:inst,out:dir('out'),...(releases.length?{base:releases[0].dir}:{noBase:true})}));}
 const t={name:'t',kind:'local-root',root:dir('root'),activate:{}};
 for(const r of releases)mirrorLocal(t,r.dir);
 await rootActivate(t,{opId:randomBytes(16).toString('hex'),cid:releases[0].cid,expectGeneration:0});
 const opId=randomBytes(16).toString('hex'),rolloutId=randomBytes(16).toString('hex');
 const journal=path.join(dir('journal'),rolloutId+'.json');
 fs.writeFileSync(journal,JSON.stringify({v:1,rolloutId,cid:releases[1].cid,targets:[{name:'t',kind:'local-root',state:'sent',opId,expectGeneration:1,previous:releases[0].cid}]}));
 const settled=await resolve([t],journal);
 const late=await rootActivate(t,{opId,cid:releases[1].cid,expectGeneration:1});
 const actual=await rootStatus(t);
 const evidence={at:new Date().toISOString(),scenario:'A sent SSH activation is delayed before it acquires root lock. Resolve asks result first. The same activation later reaches root.',reported:settled.status,targetState:settled.targets[0].state,lateOutcome:late.outcome,actual,original:releases[0].cid,requested:releases[1].cid,reproduced:settled.status==='reverted'&&late.outcome==='committed'&&actual.current===releases[1].cid};
 fs.writeFileSync('work/site-late-activation-repro.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
 if(!evidence.reproduced)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
