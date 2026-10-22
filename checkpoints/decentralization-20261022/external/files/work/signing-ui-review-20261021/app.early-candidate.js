'use strict';
// One explicit Start, then: personal_sign (upload authorization), and two eth_sendTransaction (publish EnclaveDNS 0.1.5,
// upgrade the existing deployment through its SessionVault), each prepared and verified by the local process. Adapted from
// the reviewed IPNS Publisher handoff page (ens-public-site-20261021/publisher-wallet-handoff/app.js) for these three
// steps: only the step count, the storage key prefix and the upload size text differ; no other page is linked.
// pending: THIS page's own unsettled eth_sendTransaction ({step, tx, at}). While it is open the page shows the server's
// truth (read-only /state refresh), never offers Release for it, and never sends anything again; a late MetaMask answer is
// still reported (a hash is verified by the server; a rejection resets the attempt only if it is still THIS request).
const el=id=>document.getElementById(id);let provider,q,running=false,pending=null;
const same=(a,b)=>!!a&&!!b&&Object.keys(a).sort().join()===Object.keys(b).sort().join()&&Object.keys(a).every(k=>String(a[k]).toLowerCase()===String(b[k]).toLowerCase());
const clock=ms=>new Date(ms).toISOString().slice(11,19)+' UTC';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const eth=w=>{const s=BigInt(w).toString().padStart(19,'0');const f=s.slice(-18).replace(/0+$/,'');return s.slice(0,-18)+(f?'.'+f:'')+' ETH';};
const key=s=>'enclave-enclavedns-release:'+s;
function found(p){if(provider)return;provider=p;el('wallet').textContent='MetaMask detected.';el('connect').disabled=false;}
window.addEventListener('eip6963:announceProvider',event=>{if(event.detail?.info?.rdns==='io.metamask')found(event.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(!provider){const p=window.ethereum?.providers?.find(p=>p.isMetaMask)||window.ethereum;if(p?.isMetaMask)found(p);else el('wallet').textContent='MetaMask was not detected. Enable the extension for this local page.';}},500);
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Signing-Token':q.token},body:JSON.stringify(data||{})});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{http:r.status});return j;}
async function load(){q=await(await fetch('/state')).json();render();}
function render(){
 if(el('status').textContent==='Loading…')el('status').textContent='Ready. Connect MetaMask, then press Start to review the three confirmations.';
 el('owner').textContent=q.owner;el('plan').textContent=q.plan;
 const done=q.steps.filter(s=>['uploaded','confirmed'].includes(s.status)).length;el('progress').textContent=done+' of 3 steps confirmed';
 const body=el('ops');body.replaceChildren();
 for(const s of q.steps){const tr=document.createElement('tr');if(s.step===q.next)tr.className='next';
  for(const [t,c] of [[String(s.n)],[s.title],[s.destination],[eth(s.amountWei)+(s.kind==='transaction'?' + network fee':'')],[s.status+(s.hash?' '+s.hash.slice(0,10)+'…':''),'st-'+s.status]]){const td=document.createElement('td');td.textContent=t;if(c)td.className=c;tr.append(td);}
  body.append(tr);}
 el('recovery').hidden=true;
 if(q.next===null){el('status').textContent='All three steps are confirmed on Base on two providers. Nothing else to sign.';el('start').disabled=true;return;}
 if(q.upload.lastError&&q.next==='upload')el('status').textContent='Upload not done: '+q.upload.lastError;
 if(q.blocked)el('status').textContent=q.blocked;
 const n=q.steps.find(s=>s.step===q.next);
 if(n&&n.step!=='upload'&&(['awaiting-wallet','submitted'].includes(n.status)||n.recoverable)){
  el('recovery').hidden=false;el('release').hidden=n.status!=='awaiting-wallet'||!!pending;if(n.hash)el('hash').value=n.hash;else{const h=localStorage.getItem(key(n.step));if(h)el('hash').value=h;}
  if(n.transaction)el('transaction').textContent=JSON.stringify(n.transaction,null,2);
  if(pending&&pending.step===n.step&&n.status==='awaiting-wallet')
   el('recovery-text').textContent='Step '+n.n+' ('+n.title+') is waiting for your decision in MetaMask (opened '+clock(pending.at)+', nonce '+n.nonce+'). Approve or reject it in MetaMask; this page reports the answer. Nothing is sent again. If MetaMask shows no request, reject or close it there, or reload this page: the reloaded page offers Verify this hash and the chain-checked Release.';
  else if(pending&&pending.step===n.step)
   el('recovery-text').textContent='The server no longer shows this page\'s MetaMask request for step '+n.n+' as open (status '+n.status+'). A late MetaMask answer is still reported for verification; nothing is sent again.';
  else if(n.status==='awaiting-wallet')
   el('recovery-text').textContent='Step '+n.n+' ('+n.title+') has a wallet request with an unknown outcome (nonce '+n.nonce+'). Do not send it again. If MetaMask sent it, verify its hash. If MetaMask never sent it, release the request; the retry reuses the same nonce, so only one can land.';
  else el('recovery-text').textContent='Step '+n.n+' ('+n.title+') was released after an unknown outcome. If MetaMask did send it, verify its hash. Start opens a NEW request with the SAME nonce '+n.nonce+' (only one can land), and asks you first.';}
}
load().catch(e=>el('status').textContent=e.message);
async function account(){const a=(await provider.request({method:'eth_accounts'}))[0];if(a?.toLowerCase()!==q.owner)throw Error('Select the owner account shown above in MetaMask.');
 if(await provider.request({method:'eth_chainId'})!==q.chainId)await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:q.chainId}]});
 if(await provider.request({method:'eth_chainId'})!==q.chainId)throw Error('Select Base in MetaMask.');}
el('connect').onclick=async()=>{try{const accounts=await provider.request({method:'eth_requestAccounts'});if(accounts[0]?.toLowerCase()!==q.owner)throw Error('Select the owner account shown above in MetaMask.');
 el('wallet').textContent='Connected: '+accounts[0];el('connect').disabled=true;el('start').disabled=false;}catch(e){el('status').textContent=e.message;}};
async function verify(step,hash){
 for(let i=0;i<60;i++){try{const r=await api('/tx/result',{step,hash});q={...q,...r};render();
   if(r.verification.outcome!=='confirmed'){el('status').textContent='Step '+step+' REVERTED on Base ('+hash+'). Halted for review.';return false;}
   localStorage.removeItem(key(step));return true;}
  catch(e){if(e.http===409)throw e;el('status').textContent='Submitted ('+hash+'). Waiting for two confirmations on both providers: '+e.message;await sleep(5000);}}
 el('status').textContent='Still unverified. Do not resend; use Verify this hash.';return false;}
async function upload(){
 await account();
 const p=await api('/upload/prepare');
 el('current').hidden=false;el('current-title').textContent='Step 1 of 3: authorize the upload';el('current-detail').textContent='MetaMask will show exactly: '+p.message+' (a signature, not a transaction: no fee, nothing on chain)';
 el('transaction').textContent=p.message;
 let sig;try{sig=await provider.request({method:'personal_sign',params:[p.hexMessage,p.account]});}
 catch(e){if(e.code===4001){el('status').textContent='You rejected the upload authorization. Press Start to request it again.';return false;}throw e;}
 el('status').textContent='Checking the signature, uploading 2.6 MB and verifying the CID and every block…';
 q={...q,...await api('/upload/signature',{signature:sig})};render();return true;}
async function sendStep(step){
 await account();const s=q.steps.find(x=>x.step===step);
 el('current').hidden=false;el('current-title').textContent='Step '+s.n+' of 3: '+s.title;el('current-detail').textContent=s.destination+' · '+eth(s.amountWei)+' plus network fee (gas limit at most '+s.gasCap+')';
 el('status').textContent='Rechecking chain state and simulating step '+s.n+' on two providers…';
 const p=await api('/tx/prepare',{step});
 // the server journaled this request as awaiting-wallet: show THAT (read-only), not the stale pre-prepare view
 pending={step,tx:p.transaction,at:Date.now()};await load().catch(()=>{});el('transaction').textContent=JSON.stringify(p.transaction,null,2);
 if(Date.now()>Date.parse(p.expiresAt))throw Error('the prepared request expired before it reached MetaMask; release it and start again');
 const review='Review step '+s.n+' in MetaMask: to '+p.transaction.to+', value 0, maximum fee '+eth(p.estimatedFeeLimitWei)+'. Do not edit gas or fees: an edited transaction is refused.';
 el('status').textContent=review;
 // while MetaMask holds it: a read-only refresh every 10 s keeps the page honest (no POST, no resend, no timeout-to-retry)
 const poll=setInterval(()=>{load().then(()=>{if(pending&&el('status').textContent===review)el('status').textContent=review+' Still waiting since '+clock(pending.at)+'.';}).catch(()=>{});},10000);
 let hash;try{hash=await provider.request({method:'eth_sendTransaction',params:[p.transaction]});}
 catch(e){clearInterval(poll);pending=null;
  if(e.code===4001){
   // reset only if the server's open request is still EXACTLY this one (a newer request, e.g. after a release in a reloaded
   // page, must not be reset by a late rejection of an older one)
   await load();const c=q.steps.find(x=>x.step===step);
   if(c?.status==='awaiting-wallet'&&same(c.transaction,p.transaction)){await api('/tx/rejected',{step,code:4001});await load();el('status').textContent='You rejected step '+s.n+'. Paused; press Start to request it again.';}
   else el('status').textContent='MetaMask rejected an older request for step '+s.n+'; the server has since moved on (status '+(c?.status)+'). Nothing was reset or sent.';
   return false;}
  await load();el('status').textContent='MetaMask returned no transaction hash ('+e.message+'). Do not resend. Check MetaMask activity, then verify the hash or release the request.';return false;}
 clearInterval(poll);pending=null;
 localStorage.setItem(key(step),hash);
 await load().catch(()=>{});const c=q.steps.find(x=>x.step===step);if(c?.status==='confirmed'&&c.hash===String(hash).toLowerCase()){localStorage.removeItem(key(step));return true;}
 return await verify(step,hash);}
async function run(){
 if(running)return;running=true;el('start').disabled=true;
 try{if(q.session!=='started'){el('status').textContent='Checking every pin and the owner on two providers…';q={...q,...await api('/start')};render();}
  while(true){await load();if(q.next===null||q.blocked)break;
   const n=q.steps.find(s=>s.step===q.next);
   if(n.step==='upload'){if(!await upload())break;continue;}
   const h=n.hash||localStorage.getItem(key(n.step));
   if(['awaiting-wallet','submitted'].includes(n.status)||(n.recoverable&&h)){if(h&&await verify(n.step,h))continue;break;}
   // after a release: a NEW wallet request only on an explicit confirmation (same nonce: only one can land)
   if(n.recoverable&&!confirm('Step '+n.n+' ('+n.title+') was released after an unknown outcome. Open a NEW MetaMask request with the SAME nonce '+n.nonce+'? Only one can land. First make sure MetaMask shows no open request for this page.'))break;
   if(!await sendStep(n.step))break;}
 }catch(e){el('status').textContent=e.message;await load().catch(()=>{});}
 finally{running=false;el('start').disabled=q?.next===null;}}
el('start').onclick=run;
el('check').onclick=async()=>{const s=q.next,h=el('hash').value.trim();try{if(await verify(s,h))run();}catch(e){el('status').textContent=e.message;}};
el('release').onclick=async()=>{
 if(pending){el('status').textContent='This page is still waiting for MetaMask on step '+(q.steps.find(x=>x.step===pending.step)?.n)+'. Answer or close it in MetaMask (or reload this page) before releasing.';return;}
 const n=q.steps.find(x=>x.step===q.next);
 if(!confirm('Release step '+n.n+' only if MetaMask never sent it. The server first checks on chain that nonce '+n.nonce+' is unused; a later request reuses that nonce. Release now?'))return;
 try{q={...q,...await api('/tx/release',{step:q.next})};render();el('status').textContent='Released. The retry reuses the same nonce '+n.nonce+'; Start asks before opening it.';}catch(e){el('status').textContent=e.message;}};
