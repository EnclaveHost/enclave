// Is `signature` over `message` the deployment owner's? The owner on the ledger may be a wallet (EOA), a passkey vault
// (ERC-1271), or a SessionVault from the address book's sessionVaultFactory, whose own owner (a wallet or passkey
// vault) answers for it, as the relay's beneficialOwner does. Every client must agree; any read failure is "no".
import {recoverMessageAddress,hashMessage,parseAbi,stringToHex} from 'viem';
const ERC1271=parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const BOOK=parseAbi(['function addr(bytes32) view returns (address)']);
const FACTORY=parseAbi(['function isVault(address) view returns (bool)']);
const VAULT=parseAbi(['function owner() view returns (address)']);
const addr=/^0x[0-9a-fA-F]{40}$/;

async function signedBy(client,owner,message,signature,eoa){
 if(eoa&&eoa.toLowerCase()===owner.toLowerCase())return true;
 const code=await client.getCode({address:owner});if(!code||code==='0x')return false;
 return (await client.readContract({address:owner,abi:ERC1271,functionName:'isValidSignature',args:[hashMessage(message),signature]}).catch(()=>null))==='0x1626ba7e';
}
async function oneClient(client,{owner,message,signature,addressBook,eoa}){
 if(await signedBy(client,owner,message,signature,eoa))return true;
 if(!addressBook)return false;
 const factory=await client.readContract({address:addressBook,abi:BOOK,functionName:'addr',args:[stringToHex('sessionVaultFactory',{size:32})]});
 if(!addr.test(factory)||/^0x0{40}$/i.test(factory))return false;
 if(!await client.readContract({address:factory,abi:FACTORY,functionName:'isVault',args:[owner]}))return false;
 const controller=await client.readContract({address:owner,abi:VAULT,functionName:'owner'});
 return addr.test(controller)&&await signedBy(client,controller,message,signature,eoa);
}
export async function verifyOwnerSignature({clients,owner,message,signature,addressBook}){
 if(!addr.test(owner||'')||!/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(signature||''))return false;
 let eoa=null;if(signature.length===132){try{eoa=await recoverMessageAddress({message,signature});}catch{}}
 if(!clients?.length)return !!eoa&&eoa.toLowerCase()===owner.toLowerCase();
 const r=await Promise.all(clients.map(c=>oneClient(c,{owner,message,signature,addressBook,eoa}).catch(()=>false)));
 return r.every(Boolean);
}
