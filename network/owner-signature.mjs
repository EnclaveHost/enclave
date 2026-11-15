// Is `signature` over `message` the deployment owner's? The owner on the ledger may be a wallet (EOA), a passkey vault
// (ERC-1271), or a SessionVault from the address book's sessionVaultFactory, whose own owner (a wallet or passkey
// vault) answers for it, as the relay's beneficialOwner does. Every client must agree; any read failure is "no".
import {recoverMessageAddress,hashMessage,parseAbi,stringToHex} from 'viem';
const ERC1271=parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const BOOK=parseAbi(['function addr(bytes32) view returns (address)']);
const FACTORY=parseAbi(['function isVault(address) view returns (bool)']);
const VAULT=parseAbi(['function owner() view returns (address)']);
const addr=/^0x[0-9a-fA-F]{40}$/;

async function signedBy(client,owner,message,signature,eoa,blockNumber){
 if(eoa&&eoa.toLowerCase()===owner.toLowerCase())return true;
 const code=await client.getCode({address:owner,blockNumber});if(!code||code==='0x')return false;
 return (await client.readContract({address:owner,abi:ERC1271,functionName:'isValidSignature',args:[hashMessage(message),signature],blockNumber}).catch(()=>null))==='0x1626ba7e';
}
async function oneClient(client,{owner,message,signature,addressBook,eoa,sessionVaultFactory,blockNumber}){
 if(await signedBy(client,owner,message,signature,eoa,blockNumber))return true;
 if(sessionVaultFactory===undefined&&!addressBook)return false;
 const factory=sessionVaultFactory===undefined?await client.readContract({address:addressBook,abi:BOOK,functionName:'addr',args:[stringToHex('sessionVaultFactory',{size:32})],blockNumber}):sessionVaultFactory;
 if(!addr.test(factory)||/^0x0{40}$/i.test(factory))return false;
 if(!await client.readContract({address:factory,abi:FACTORY,functionName:'isVault',args:[owner],blockNumber}))return false;
 const controller=await client.readContract({address:owner,abi:VAULT,functionName:'owner',blockNumber});
 return addr.test(controller)&&await signedBy(client,controller,message,signature,eoa,blockNumber);
}
export async function verifyOwnerSignature({clients,reader,owner,message,signature,addressBook,sessionVaultFactory}){
 if(!addr.test(owner||'')||!/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(signature||''))return false;
 if(sessionVaultFactory!==undefined&&!addr.test(sessionVaultFactory))return false;
 let eoa=null;if(signature.length===132){try{eoa=await recoverMessageAddress({message,signature});}catch{}}
 if(eoa&&eoa.toLowerCase()===owner.toLowerCase())return true;
 if(reader){
   try{return (await reader.agreed(async(client,blockNumber)=>({valid:await oneClient(client,{owner,message,signature,addressBook,eoa,sessionVaultFactory,blockNumber})}))).valid;}
   catch{return false;}
 }
 if(!clients?.length)return !!eoa&&eoa.toLowerCase()===owner.toLowerCase();
 const r=await Promise.all(clients.map(c=>oneClient(c,{owner,message,signature,addressBook,eoa,sessionVaultFactory}).catch(()=>false)));
 return r.every(Boolean);
}

// A verification that succeeded is not asked again for `ttlMs`: verify(owner,message,signature) for a contract-wallet
// owner reads the chain at an agreed block, which through a host's own circuits takes seconds, and an agent asks for
// every answer of every directory in every refresh round. Measured on a host whose one such app got its first signed
// policy (2026-11-15): rounds went from 15 s to 46 s, past the leases' freshness at times, and every app on the host
// lost its network for a minute. Only a yes is kept, and no longer than `ttlMs`: an owner that changes on chain is
// believed for at most that long, and a signature that fails is checked again each time.
export function rememberVerified(verify,{now=Date.now,ttlMs=10*60_000,max=256}={}){
 const seen=new Map(),pending=new Map();
 return async(owner,message,signature)=>{
  const key=String(owner).toLowerCase()+'|'+signature+'|'+message,at=seen.get(key);
  if(at!==undefined&&now()-at<ttlMs)return true;
  // the same question asked while it is being answered shares the answer
  let p=pending.get(key);
  if(!p){p=Promise.resolve().then(()=>verify(owner,message,signature)).finally(()=>pending.delete(key));pending.set(key,p);}
  const ok=await p===true;
  if(ok){seen.delete(key);seen.set(key,now());if(seen.size>max)seen.delete(seen.keys().next().value);}else seen.delete(key);
  return ok;
 };
}
