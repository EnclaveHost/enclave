import {hashMessage,parseAbi} from 'viem';
const ABI=parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
/** Owner comes from the ledger, never the request body. Fail closed on any
 * chain/code/read failure. This does not replace EOA signature verification. */
export async function verifyContractOwnerSignature({client,owner,message,signature}) {
 if(!/^0x[0-9a-fA-F]{40}$/.test(owner||'')||!/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(signature||''))return false;
 try {
  const code=await client.getCode({address:owner});if(!code||code==='0x')return false;
  return await client.readContract({address:owner,abi:ABI,functionName:'isValidSignature',args:[hashMessage(message),signature]})==='0x1626ba7e';
 }catch{return false;}
}
