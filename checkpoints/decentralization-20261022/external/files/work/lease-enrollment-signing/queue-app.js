'use strict';
// One explicit start, then one MetaMask request per operation, in order. The CLI prepares and verifies; only MetaMask
// signs and sends. A rejection pauses; anything unknown stops and offers only hash verification or a chain-checked release.
const el=id=>document.getElementById(id);let provider,q,running=false,pauseAfter=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const eth=w=>{const s=BigInt(w).toString().padStart(19,'0');const f=s.slice(-18).replace(/0+$/,'');return s.slice(0,-18)+(f?'.'+f:'')+' ETH';};
const key=i=>'enclave-enrollment:'+q.planSha256+':'+i;
function found(p){if(provider)return;provider=p;el('wallet').textContent='MetaMask detected.';el('connect').disabled=false;}
window.addEventListener('eip6963:announceProvider',event=>{if(event.detail?.info?.rdns==='io.metamask')found(event.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(!provider){const p=window.ethereum?.providers?.find(p=>p.isMetaMask)||window.ethereum;if(p?.isMetaMask)found(p);else el('wallet').textContent='MetaMask was not detected. Enable the extension for this local page.';}},500);
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Signing-Token':q.token},body:JSON.stringify(data||{})});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{http:r.status});return j;}
async function load(){q=await(await fetch('/queue')).json();render();}
function render(){
 el('owner').textContent=q.admin;el('plan').textContent='sha256:'+q.planSha256;
 el('progress').textContent=q.totals.confirmed+' of '+q.totals.operations+' operations confirmed';
 el('remaining').textContent=q.totals.remainingSignatures+' MetaMask confirmations · '+eth(q.totals.remainingWei)+' plus network fees';
 const body=el('ops');body.replaceChildren();
 for(const o of q.operations){const tr=document.createElement('tr');if(o.index===q.next)tr.className='next';
  for(const [t,c] of [[String(o.index+1)],[o.appLabel],[o.title],[eth(o.amountWei)],[o.status+(o.hash?' '+o.hash.slice(0,10)+'…':''),'st-'+o.status]]){const td=document.createElement('td');td.textContent=t;if(c)td.className=c;tr.append(td);}
  body.append(tr);}
 const n=q.next===null?null:q.operations[q.next];
 el('start').textContent=q.session==='started'?'Resume signing sequence':'Start signing sequence';
 el('recovery').hidden=true;
 if(q.next===null){el('status').textContent='All '+q.totals.operations+' operations are confirmed on Base.';el('start').disabled=true;return;}
 if(q.blocked&&!(n&&['awaiting-wallet','submitted'].includes(n.status)))el('status').textContent=q.blocked;
 if(n&&(['awaiting-wallet','submitted'].includes(n.status)||n.recoverable)){
  el('recovery').hidden=false;el('release').hidden=n.status!=='awaiting-wallet';if(n.hash)el('hash').value=n.hash;else{const h=localStorage.getItem(key(n.index));if(h)el('hash').value=h;}
  el('recovery-text').textContent=n.recoverable?'Operation '+(n.index+1)+' was released after an unanswered wallet request. Resume to request it again with the same nonce, or verify the hash if MetaMask did send it.':'Operation '+(n.index+1)+' ('+n.title+') has a wallet request with an unknown outcome. Do not send it again. If MetaMask sent it, verify its hash. If MetaMask never sent it, release the request; the retry reuses the same nonce, so only one can land.';}
}
load().catch(e=>el('status').textContent=e.message);
async function account(){const a=(await provider.request({method:'eth_accounts'}))[0];if(a?.toLowerCase()!==q.admin.toLowerCase())throw Error('Select the administrator account shown above in MetaMask.');
 if(await provider.request({method:'eth_chainId'})!=='0x2105')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});
 if(await provider.request({method:'eth_chainId'})!=='0x2105')throw Error('Select Base in MetaMask.');}
el('connect').onclick=async()=>{try{const accounts=await provider.request({method:'eth_requestAccounts'});if(accounts[0]?.toLowerCase()!==q.admin.toLowerCase())throw Error('Select the administrator account shown above in MetaMask.');
 el('wallet').textContent='Connected: '+accounts[0];el('connect').disabled=true;el('start').disabled=false;}catch(e){el('status').textContent=e.message;}};
async function verify(i,hash){
 for(let n=0;n<60;n++){try{const r=await api('/result',{index:i,hash});q={...q,...r};render();
   if(r.verification.outcome!=='confirmed'){el('status').textContent='Operation '+(i+1)+' REVERTED on Base ('+hash+'). The sequence is halted for review.';return false;}
   localStorage.removeItem(key(i));return true;}
  catch(e){if(e.http===409)throw e;el('status').textContent='Operation '+(i+1)+' submitted ('+hash+'). Waiting for two confirmations on both providers: '+e.message;await sleep(5000);}}
 el('status').textContent='Operation '+(i+1)+' is still unverified. Do not resend; use Verify this hash.';return false;}
async function run(){
 running=true;pauseAfter=false;el('start').disabled=true;el('pause').hidden=false;
 try{if(q.session!=='started'){el('status').textContent='Checking the reserve binding and every operation on two providers…';q={...q,...await api('/start')};render();}
  while(running){await load();if(q.next===null)break;const i=q.next,o=q.operations[i];
   const h=o.hash||localStorage.getItem(key(i));
   if(['awaiting-wallet','submitted'].includes(o.status)||(o.recoverable&&h)){if(h&&await verify(i,h))continue;if(!h)el('status').textContent='Operation '+(i+1)+' has a wallet request with an unknown outcome; see the options below.';break;}
   if(q.blocked)break;
   if(pauseAfter){el('status').textContent='Paused before operation '+(i+1)+'.';break;}
   await account();
   el('current').hidden=false;el('current-title').textContent='Operation '+(i+1)+' of '+q.totals.operations+': '+o.title;
   el('current-detail').textContent=o.appLabel+' · '+eth(o.amountWei)+' plus network fee · after this: '+(q.totals.remainingSignatures-1)+' more, '+eth(BigInt(q.totals.remainingWei)-BigInt(o.amountWei));
   el('status').textContent='CLI is rechecking chain state and simulating operation '+(i+1)+'…';
   const p=await api('/prepare',{index:i});el('transaction').textContent=JSON.stringify(p.transaction,null,2);
   el('status').textContent='Review operation '+(i+1)+' in MetaMask: '+o.title+'.';
   let hash;
   try{hash=await provider.request({method:'eth_sendTransaction',params:[p.transaction]});}
   catch(e){if(e.code===4001){await api('/rejected',{index:i,code:4001});await load();el('status').textContent='You rejected operation '+(i+1)+' in MetaMask. The sequence is paused; press Resume to request it again.';break;}
    await load();el('status').textContent='MetaMask returned no transaction hash ('+e.message+'). Do not resend. Check MetaMask activity, then verify the hash or release the request.';break;}
   localStorage.setItem(key(i),hash);
   if(!await verify(i,hash))break;}
 }catch(e){el('status').textContent=e.message;await load().catch(()=>{});}
 finally{running=false;el('pause').hidden=true;el('start').disabled=q?.next===null;}}
el('start').onclick=run;
el('pause').onclick=()=>{pauseAfter=true;el('status').textContent='Will pause after the current operation.';};
el('check').onclick=async()=>{const i=q.next,h=el('hash').value.trim();try{if(await verify(i,h))run();}catch(e){el('status').textContent=e.message;}};
el('release').onclick=async()=>{try{q={...q,...await api('/release',{index:q.next})};render();el('status').textContent='Released. The retry of operation '+(q.next+1)+' will reuse the same nonce.';}catch(e){el('status').textContent=e.message;}};
