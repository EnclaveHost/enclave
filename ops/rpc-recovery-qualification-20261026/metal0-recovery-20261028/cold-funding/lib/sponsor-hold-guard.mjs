import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {PRODUCTION} from './maintenance.mjs';
export function checkHoldFacts(h,pid,stat,children,now=Date.now()/1000){
 if(h.scope!=='parent-only'||h.sponsor!==PRODUCTION.sponsor||!Number.isSafeInteger(h.pid)||h.pid<=1||String(pid)!==String(h.pid))throw Error('sponsor parent identity mismatch');
 if(stat.startTicks!==h.startTicks||!['T','t'].includes(stat.state))throw Error('sponsor parent not held');
 if(!Number.isFinite(h.heldAt)||now-h.heldAt<15||now-h.heldAt>240)throw Error('sponsor hold age invalid');
 if(!Array.isArray(h.qemuPids)||!h.qemuPids.length||h.qemuPids.some(p=>!children.some(c=>c.pid===p&&!['T','t','Z'].includes(c.state))))throw Error('custodian QEMU child not live');
 return true;
}
function proc(pid){const a=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').slice(1).join(') ').trim().split(/\s+/);return{pid,state:a[0],startTicks:a[19]};}
export function createHoldGuard(file){return {id:'pinned-custodian-parent-pidfd-hold/v1',async check(ctx){
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid())throw Error('hold receipt not private');
 const h=JSON.parse(fs.readFileSync(file,'utf8'));const pid=execFileSync('systemctl',['--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim();
 const ids=fs.readFileSync(`/proc/${h.pid}/task/${h.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number);checkHoldFacts(h,pid,proc(h.pid),ids.map(proc));
 for(const url of PRODUCTION.rpcs){for(const tag of ['latest','pending']){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionCount',params:[PRODUCTION.sponsor,tag]}),signal:AbortSignal.timeout(10000)});const d=await r.json();if(d.error||BigInt(d.result)!==BigInt(ctx.sponsorNonce))throw Error('sponsor nonce not settled');}}
 return {quiesced:true,sponsor:PRODUCTION.sponsor,sponsorNonce:ctx.sponsorNonce,holdUntil:'verified'};
 }};}
