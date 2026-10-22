'use strict';
// One explicit Start, then: personal_sign (upload authorization), and two eth_sendTransaction (publish EnclaveDNS 0.1.5,
// upgrade the existing deployment through its SessionVault), each prepared and verified by the local process. Adapted from
// the reviewed IPNS Publisher handoff page (ens-public-site-20261021/publisher-wallet-handoff/app.js) for these three
// steps: only the step count, the storage key prefix and the upload size text differ; no other page is linked.
const el=id=>document.getElementById(id);let provider,q,running=false;
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
  el('recovery').hidden=false;el('release').hidden=n.status!=='awaiting-wallet';if(n.hash)el('hash').value=n.hash;else{const h=localStorage.getItem(key(n.step));if(h)el('hash').value=h;}
  if(n.transaction)el('transaction').textContent=JSON.stringify(n.transaction,null,2);
  el('recovery-text').textContent='Step '+n.n+' ('+n.title+') has a wallet request with an unknown outcome. Do not send it again. If MetaMask sent it, verify its hash. If MetaMask never sent it, release the request; the retry reuses the same nonce, so only one can land.';}
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
 const p=await api('/tx/prepare',{step});el('transaction').textContent=JSON.stringify(p.transaction,null,2);
 if(Date.now()>Date.parse(p.expiresAt))throw Error('the prepared request expired before it reached MetaMask; release it and start again');
 el('status').textContent='Review step '+s.n+' in MetaMask: to '+p.transaction.to+', value 0, maximum fee '+eth(p.estimatedFeeLimitWei)+'. Do not edit gas or fees: an edited transaction is refused.';
 let hash;try{hash=await provider.request({method:'eth_sendTransaction',params:[p.transaction]});}
 catch(e){if(e.code===4001){await api('/tx/rejected',{step,code:4001});await load();el('status').textContent='You rejected step '+s.n+'. Paused; press Start to request it again.';return false;}
  await load();el('status').textContent='MetaMask returned no transaction hash ('+e.message+'). Do not resend. Check MetaMask activity, then verify the hash or release the request.';return false;}
 localStorage.setItem(key(step),hash);return await verify(step,hash);}
async function run(){
 if(running)return;running=true;el('start').disabled=true;
 try{if(q.session!=='started'){el('status').textContent='Checking every pin and the owner on two providers…';q={...q,...await api('/start')};render();}
  while(true){await load();if(q.next===null||q.blocked)break;
   const n=q.steps.find(s=>s.step===q.next);
   if(n.step==='upload'){if(!await upload())break;continue;}
   const h=n.hash||localStorage.getItem(key(n.step));
   if(['awaiting-wallet','submitted'].includes(n.status)||(n.recoverable&&h)){if(h&&await verify(n.step,h))continue;break;}
   if(!await sendStep(n.step))break;}
 }catch(e){el('status').textContent=e.message;await load().catch(()=>{});}
 finally{running=false;el('start').disabled=q?.next===null;}}
el('start').onclick=run;
el('check').onclick=async()=>{const s=q.next,h=el('hash').value.trim();try{if(await verify(s,h))run();}catch(e){el('status').textContent=e.message;}};
el('release').onclick=async()=>{try{q={...q,...await api('/tx/release',{step:q.next})};render();el('status').textContent='Released. The retry reuses the same nonce.';}catch(e){el('status').textContent=e.message;}};
