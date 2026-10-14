// On-chain qualification for paid Enclave-network providers (docs/design/enclave-network.md, "Paid providers"). The
// EnclaveConnectivity contract pays a provider only while a quorum of the app's trusted checkers (by default its
// bootstrap checkers, the Enclave network's own) attests, on chain, to the provider's registry host, current operator
// and address, for at most 5 minutes at a time. So:
//   - a checker that passed a community (registry-host) provider on every check also signs the contract's
//     qualificationDigest for it, and publishes that signature with its verdict (signOnchainQualification);
//   - the provider - the party paid - submits those attestations itself while it serves (submitAttestations), and keeps
//     its on-chain price equal to its record's (ensureHost). Anyone may submit an attestation: the contract checks the
//     checker's signature.
import {keccak256,stringToHex,parseAbi,recoverMessageAddress} from 'viem';

export const ALL_CHECKS=511,ONCHAIN_MAX_S=300;
export const connectivityQualificationABI=parseAbi([
 'function qualificationDigest(bytes32 hostId,bytes32 addressHash,uint64 issuedAt,uint64 expires,uint16 checks) view returns (bytes32)',
 'function qualify(bytes32 hostId,bytes32 addressHash,uint64 issuedAt,uint64 expires,uint16 checks,bytes signature)',
 'function attestations(bytes32 hostId,address signer) view returns (address operator,bytes32 addressHash,uint64 expires)',
 'function hosts(bytes32) view returns (bool direct,bool provider,uint64 pricePerGiB6,uint64 qualifiedUntil,bytes32 addressHash,address operator,address qualifier)',
 'function setHost(bytes32 hostId,bool direct,bool provider,uint64 pricePerGiB6)',
 'function ledger() view returns (address)',
]);
const bookABI=parseAbi(['function addr(bytes32) view returns (address)']);
export const addressHash=address=>keccak256(stringToHex(address));

// the connectivity contract the address book publishes, or null while none is (no paid providers then)
export async function connectivityAddress(client,addressBook){
 const a=await client.readContract({address:addressBook,abi:bookABI,functionName:'addr',args:[stringToHex('connectivity',{size:32})]});
 return /^0x0{40}$/i.test(a)?null:a;
}

export function validateOnchain(o){
 const k=o&&typeof o==='object'?Object.keys(o).sort().join(','):'';
 if(k!=='addressHash,checks,expires,hostId,issuedAt,signature'||!/^0x[0-9a-f]{64}$/.test(o.hostId)||!/^0x[0-9a-f]{64}$/.test(o.addressHash)||o.checks!==ALL_CHECKS||
    !Number.isSafeInteger(o.issuedAt)||!Number.isSafeInteger(o.expires)||o.expires<=o.issuedAt||o.expires-o.issuedAt>ONCHAIN_MAX_S||!/^0x[0-9a-fA-F]{130}$/.test(o.signature))
  throw new Error('invalid on-chain qualification');
 return o;
}

// The checker's attestation for a provider record that passed every check (null for an Enclave-run, unpaid provider).
export async function signOnchainQualification({account,client,connectivity,record,now=Date.now()}){
 if(record.kind!=='community'||!record.hostId||!connectivity)return null;
 // issued slightly in the past: the contract requires issuedAt <= the including block's time, and blocks trail clocks
 const issuedAt=Math.floor(now/1000)-30,expires=issuedAt+ONCHAIN_MAX_S,hash=addressHash(record.address);
 const digest=await client.readContract({address:connectivity,abi:connectivityQualificationABI,functionName:'qualificationDigest',args:[record.hostId,hash,BigInt(issuedAt),BigInt(expires),ALL_CHECKS]});
 return {hostId:record.hostId,addressHash:hash,issuedAt,expires,checks:ALL_CHECKS,signature:await account.signMessage({message:{raw:digest}})};
}

// The provider: submit every current attestation for its own host and address that the chain does not already hold.
// -> the number submitted.
export async function submitAttestations({wallet,client,connectivity,hostId,address,attestations,minRemainingS=60,now=Date.now()}){
 let sent=0;const t=Math.floor(now/1000),hash=addressHash(address);
 for(const raw of attestations){
  let o;try{o=validateOnchain(raw);}catch{continue;}
  if(o.hostId!==hostId||o.addressHash!==hash||o.expires<=t+minRemainingS||o.issuedAt>t+60)continue;
  // the checker that signed it (the contract recovers the same address and decides whether it is trusted)
  const digest=await client.readContract({address:connectivity,abi:connectivityQualificationABI,functionName:'qualificationDigest',args:[o.hostId,o.addressHash,BigInt(o.issuedAt),BigInt(o.expires),o.checks]});
  const signer=await recoverMessageAddress({message:{raw:digest},signature:o.signature});
  const [,,held]=await client.readContract({address:connectivity,abi:connectivityQualificationABI,functionName:'attestations',args:[hostId,signer]});
  if(Number(held)>=o.expires)continue;
  const tx=await wallet.writeContract({address:connectivity,abi:connectivityQualificationABI,functionName:'qualify',
   args:[o.hostId,o.addressHash,BigInt(o.issuedAt),BigInt(o.expires),o.checks,o.signature]});
  if((await client.waitForTransactionReceipt({hash:tx,timeout:60000})).status!=='success')throw new Error('qualify reverted (tx '+tx+')');sent++;
 }
 return sent;
}

// The provider's on-chain offer: a provider-path ("network provider") host at exactly its record's price. -> true if changed.
export async function ensureHost({wallet,client,connectivity,hostId,pricePerGiB6}){
 const [direct,provider,price]=await client.readContract({address:connectivity,abi:connectivityQualificationABI,functionName:'hosts',args:[hostId]});
 if(provider&&!direct&&BigInt(price)===BigInt(pricePerGiB6))return false;
 const tx=await wallet.writeContract({address:connectivity,abi:connectivityQualificationABI,functionName:'setHost',args:[hostId,false,true,BigInt(pricePerGiB6)]});
 if((await client.waitForTransactionReceipt({hash:tx,timeout:60000})).status!=='success')throw new Error('setHost reverted (tx '+tx+')');return true;
}
