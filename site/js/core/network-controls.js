import {ADDRESS_BOOK_ADDRESS,DEPLOYMENTS_ADDRESS,REGISTRY_ADDRESS} from './config.js';
import {baseRpc,depGet,encCall,encUint,encBytes32,encBytesTail,waitReceipt} from './chain.js';
import {Enclave} from './api.js';import {ensureBaseChain,sendTx,personalSignBytes} from './wallet.js';
import {keccak256Hex} from './keccak.js';
const call=(to,data,block='latest')=>baseRpc('eth_call',[{to,data},block],{emptyRetry:true});
const words=h=>{if(!/^0x(?:[a-f0-9]{64})+$/i.test(h))throw Error('Incomplete network contract response');return h.slice(2).match(/.{64}/g);};
const addr=w=>'0x'+w.slice(24),number=w=>BigInt('0x'+w);
export function networkAmount6(value){if(!/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/.test(String(value)))throw Error('Enter a nonnegative USDC amount with at most six decimals.');const [a,b='']=String(value).split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));}
export const showNetworkAmount=n=>{const s=String(n).padStart(7,'0');return (s.slice(0,-6)+'.'+s.slice(-6)).replace(/\.?0+$/,'')||'0';};
export function networkPolicyDigest({connectivity,ledger,id,owner,nonce,expires,maxPricePerGiB6,budget6,chainId=8453}) {
 return keccak256Hex(encCall('',[{t:'str',v:'EnclaveConnectivity.policy.v1'},{t:'uint',v:chainId},{t:'addr',v:connectivity},{t:'addr',v:ledger},{t:'bytes32',v:id},{t:'addr',v:owner},{t:'uint',v:nonce},{t:'uint',v:expires},{t:'uint',v:maxPricePerGiB6},{t:'uint',v:budget6}]));
}
export async function networkSettings(id){
 const address=addr(words(await call(ADDRESS_BOOK_ADDRESS,'0x3b3b57de'+BufferlessKey('connectivity')))[0]);
 if(/^0x0{40}$/.test(address))return null;
 const block=await baseRpc('eth_blockNumber',[]);
 const ledger=addr(words(await call(address,'0x56397c35',block))[0]);
 if(ledger.toLowerCase()!==DEPLOYMENTS_ADDRESS.toLowerCase())throw Error('Network contract does not match the current app ledger.');
 const d=await depGet(id,block);
 const [p,h,c,back,host]=await Promise.all([
  call(address,'0xddbfd8ef'+encBytes32(id),block),call(address,'0x7c33a665'+encBytes32(d.runner),block),call(address,'0xc2ead131'+encBytes32(d.runner),block),
  call(ledger,'0x23d9291e'+encBytes32(id),block),call(REGISTRY_ADDRESS,'0x8eaa6ac0'+encBytes32(d.runner),block)]);
 const policy=words(p),provider=words(h),capabilities=words(c),hostWords=words(host),offset=Number(number(hostWords[0])/32n);
 const selfHosted=addr(hostWords[offset+10]).toLowerCase()===d.owner.toLowerCase();
 return {address,ledger,id,owner:d.owner,nonce:number(policy[1]),expires:Number(number(policy[2])),maxPricePerGiB6:number(policy[3]),budget6:number(policy[4]),spent6:number(policy[5]),providerBps:Number(number(policy[6])),
  direct:number(capabilities[0])===1n,rate6:selfHosted?0n:number(provider[2]),selfHosted,backingGap6:number(words(back)[0]),active:d.active};
}
function BufferlessKey(s){return [...new TextEncoder().encode(s)].map(n=>n.toString(16).padStart(2,'0')).join('').padEnd(64,'0');}
export async function saveNetworkSettings(current,{mode,maxPrice,budget,hours,viaVault=false}){
 if(!viaVault)await ensureBaseChain();const fresh=await networkSettings(current.id);
 if(!fresh||fresh.address!==current.address||fresh.ledger!==current.ledger||fresh.owner.toLowerCase()!==current.owner.toLowerCase()||(!viaVault&&fresh.owner.toLowerCase()!==Enclave.address?.toLowerCase()))throw Error('Connect the wallet that owns this app.');
 let data;
 if(mode==='tuna'&&viaVault)return savePasskeyNetwork(fresh,{expires:'0',maxPricePerGiB6:'0',budget6:'0'});
 if(mode==='tuna')data='0x427121b3'+encBytes32(current.id);
 else{
  if(!fresh.active||!fresh.direct)throw Error('The current host must pass provider qualification and enable direct service first.');
  const maxPricePerGiB6=networkAmount6(maxPrice),budget6=networkAmount6(budget),duration=Number(hours);
  if(!Number.isFinite(duration)||duration<=0||duration>720)throw Error('Choose a duration from 1 to 720 hours.');
  if(maxPricePerGiB6>=1n<<64n||budget6>=1n<<128n)throw Error('Bandwidth limit is too large.');
  if(fresh.rate6>maxPricePerGiB6)throw Error('The host rate exceeds your price limit.');
  if(fresh.rate6>0n&&(budget6===0n||fresh.backingGap6>0n))throw Error('Paid direct bandwidth needs a budget and fully backed app USDC.');
  const expires=Math.floor(Date.now()/1000+duration*3600),nonce=fresh.nonce+1n;
  const digest=networkPolicyDigest({...fresh,connectivity:fresh.address,expires,nonce,maxPricePerGiB6,budget6});
  if(viaVault)return savePasskeyNetwork(fresh,{expires:String(expires),maxPricePerGiB6:String(maxPricePerGiB6),budget6:String(budget6)});
  const signature=await personalSignBytes(digest);
  data='0xd14cf349'+encBytes32(current.id)+encUint(expires)+encUint(maxPricePerGiB6)+encUint(budget6)+encUint(160)+encBytesTail(signature);
 }
 const hash=await sendTx(fresh.address,data);await waitReceipt(hash);return networkSettings(current.id);
}
export async function renderNetworkControls(box,id,{viaVault=false}={}){
 const current=await networkSettings(id);if(!current)return;
 const section=document.createElement('form');section.className='enc-network-controls';
 section.innerHTML='<label>Internet route <select name="mode"><option value="tuna">TUNA provider</option><option value="direct">Direct host</option></select></label><div data-direct><label>Maximum USDC per GiB <input name="price" type="text" inputmode="decimal" required></label><label>Bandwidth budget (USDC) <input name="budget" type="text" inputmode="decimal" required></label><label>Authorization (hours) <input name="hours" type="number" min="1" max="720" value="24" required></label></div><p data-info></p><button type="submit" class="btn sm">Save internet route</button><p role="status" aria-live="polite"></p>';
 const form=section.elements;form.mode.value=current.expires>0?'direct':'tuna';form.price.value=showNetworkAmount(current.maxPricePerGiB6||current.rate6);form.budget.value=showNetworkAmount(current.budget6);
 const info=section.querySelector('[data-info]'),status=section.querySelector('[role=status]'),save=section.querySelector('button');
 const update=()=>{section.querySelector('[data-direct]').hidden=form.mode.value!=='direct';info.textContent=form.mode.value==='direct'?(current.selfHosted?'Eligible self-hosting has no bandwidth charge.':`Host rate: ${showNetworkAmount(current.rate6)} USDC/GiB, charged from this app’s balance.`):'Use a TUNA provider. Direct routing will not be used as a fallback.';if(form.mode.value==='direct'&&!current.direct)info.textContent+=' This host has not enabled qualified direct service.';if(form.mode.value==='direct'&&current.expires>0&&current.expires<=Date.now()/1000)info.textContent+=' Your direct authorization expired. Save new limits to renew it.';};
 form.mode.addEventListener('change',update);update();
 if(!viaVault&&Enclave.address?.toLowerCase()!==current.owner.toLowerCase()){save.disabled=true;status.textContent='Connect the app owner’s wallet to change its route.';}
 section.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;status.textContent='Confirm the route and spending limits in your wallet.';try{await saveNetworkSettings(current,{mode:form.mode.value,maxPrice:form.price.value,budget:form.budget.value,hours:form.hours.value,viaVault});status.textContent='Saved on-chain. The host will apply your route after its next authorization refresh.';}catch(e){status.textContent=e.message;}finally{save.disabled=false;}});
 box.append(section);
}

export function networkPasskeyDigest(raw){
 const prefix=[...new TextEncoder().encode('\x19Ethereum Signed Message:\n32')].map(b=>b.toString(16).padStart(2,'0')).join('');
 return keccak256Hex('0x'+prefix+raw.slice(2));
}
export function verifyNetworkPrepare(prep,current,intent){
 if(prep.chainId!==8453||prep.address?.toLowerCase()!==current.address.toLowerCase()||prep.ledger?.toLowerCase()!==current.ledger.toLowerCase()||prep.vault?.toLowerCase()!==current.owner.toLowerCase()||prep.id!==current.id||String(prep.nonce)!==String(current.nonce+1n)||['expires','maxPricePerGiB6','budget6'].some(k=>String(prep[k])!==String(intent[k])))throw Error('The relay described different network settings. Nothing was signed.');
 const digest=networkPasskeyDigest(networkPolicyDigest({...current,connectivity:current.address,nonce:current.nonce+1n,...intent}));
 if(prep.digest?.toLowerCase()!==digest.toLowerCase())throw Error('The network signing challenge does not match your settings.');
 return digest;
}
async function savePasskeyNetwork(current,intent){
 const prep=await Enclave.vaultPrepare({op:'network',id:current.id,...intent});
 const digest=verifyNetworkPrepare(prep,current,intent);
 const bytes=new Uint8Array(digest.slice(2).match(/../g).map(h=>parseInt(h,16)));
 const challenge=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const {startAuthentication}=await import('/vendor/webauthn.js');
 const asr=await startAuthentication({optionsJSON:{challenge,allowCredentials:[{id:prep.credId,type:'public-key'}],userVerification:'preferred',timeout:120000}});
 await Enclave.vaultExec({op:'network',args:{id:current.id,...intent},assertion:{credId:asr.id,authenticatorData:asr.response.authenticatorData,clientDataJSON:asr.response.clientDataJSON,signature:asr.response.signature}});
 return networkSettings(current.id);
}
