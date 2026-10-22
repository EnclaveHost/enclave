'use strict';
const el=id=>document.getElementById(id);let provider,config,hash;
function found(p){if(provider)return;provider=p;el('wallet').textContent='MetaMask detected.';el('connect').disabled=false;}
window.addEventListener('eip6963:announceProvider',event=>{if(event.detail?.info?.rdns==='io.metamask')found(event.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(!provider){const p=window.ethereum?.providers?.find(p=>p.isMetaMask)||window.ethereum;if(p?.isMetaMask)found(p);else el('wallet').textContent='MetaMask was not detected. Enable the extension for this local page.';}},500);
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Signing-Token':config.token},body:JSON.stringify(data||{})});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}
async function load(){config=await(await fetch('/request')).json();const tx=config.request.transaction;el('owner').textContent=tx.from;el('destination').textContent=tx.to||'New contract deployment';el('transaction').textContent=JSON.stringify(tx,null,2);hash=config.state.hash;el('status').textContent=config.state.status==='ready'?'Ready to connect your owner account.':config.state.status==='confirmed'?document.body.dataset.done:'Existing attempt: '+config.state.status+'. Do not resend.';el('verify').hidden=!hash||config.state.status==='confirmed';}
load().catch(e=>el('status').textContent=e.message);
el('connect').onclick=async()=>{try{if(!config)throw Error('Request is still loading');const accounts=await provider.request({method:'eth_requestAccounts'});if(accounts[0]?.toLowerCase()!==config.request.transaction.from.toLowerCase())throw Error('Select the owner account shown above in MetaMask.');el('wallet').textContent='Connected: '+accounts[0];el('connect').disabled=true;el('sign').disabled=config.state.status!=='ready';el('status').textContent='Owner account connected. Ready for the transaction request.';}catch(e){el('status').textContent=e.message;}};
el('sign').onclick=async()=>{el('sign').disabled=true;let prepared=false;try{
 if((await provider.request({method:'eth_accounts'}))[0]?.toLowerCase()!==config.request.transaction.from.toLowerCase())throw Error('Owner account changed.');
 if(await provider.request({method:'eth_chainId'})!=='0x2105')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});
 if(await provider.request({method:'eth_chainId'})!=='0x2105')throw Error('Select Base before signing.');
 el('status').textContent='CLI is rechecking chain state and simulating the transaction…';
 const result=await api('/prepare');prepared=true;el('transaction').textContent=JSON.stringify(result.transaction,null,2);el('status').textContent='Review and confirm the transaction in MetaMask.';
 hash=await provider.request({method:'eth_sendTransaction',params:[result.transaction]});el('status').textContent='Submitted: '+hash+'. CLI is verifying confirmation…';el('verify').hidden=false;await verify();
 }catch(e){el('status').textContent=e.message;if(e.code===4001){if(prepared)await api('/rejected',{code:4001});await load();el('sign').disabled=false;}else if(!prepared)el('sign').disabled=false;}};
async function verify(){el('verify').disabled=true;try{const r=await api('/result',{hash});el('status').textContent='Confirmed on Base: '+r.transactionHash+'. '+document.body.dataset.done;el('verify').hidden=true;}catch(e){el('status').textContent='Submitted '+hash+'. Verification pending: '+e.message;}finally{el('verify').disabled=false;}}
el('verify').onclick=verify;
