import {writeFileSync,mkdirSync} from 'node:fs';
import {encodeDeployData,keccak256,parseAbi,stringToHex} from 'viem';
import {LeaseReader} from './network/lease-reader.mjs';
import {compileHostOwnership} from './scripts/deploy-secret-vault-v2.mjs';
const book='0xab214342d5A490150A4A977063A2f88E21F80907',from='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const reader=new LeaseReader({rpc:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],addressBook:book});
const a=await reader.agreed(async(client,blockNumber)=>{
 const registry=await client.readContract({address:book,abi:parseAbi(['function addr(bytes32) view returns (address)']),functionName:'addr',args:[stringToHex('registry',{size:32})],blockNumber});
 const code=await client.getCode({address:registry,blockNumber});if(!code||code==='0x')throw Error('registry has no code');
 return {registry:registry.toLowerCase(),registryCodeHash:keccak256(code)};
});
const artifact=compileHostOwnership(),data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode,args:[a.registry]});
const gas=await reader.clients[0].estimateGas({account:from,data,value:0n});
const dir='../../outputs/host-ownership-release';mkdirSync(dir,{recursive:true});
writeFileSync(dir+'/transaction.json',JSON.stringify({status:'prepared-not-signed',preparedAt:new Date().toISOString(),sourceCommit:'0bd0ef552bfce640be05b4ab7477b3f0b412bdac',purpose:'Deploy host-local wallet authority with an immutable registry binding. Deployment grants no host ownership; each host operator must nominate an owner and that wallet must accept.',authorityObservation:a,transaction:{chainId:8453,from,value:'0x0',data,estimatedGas:gas.toString()},notes:['No transaction has been signed or broadcast.','Revalidate registry code/address and owner device address before signing.','Do not update custody discovery or retire existing custody on this deployment alone.','Host admission runtime integration, ownership enrollment, measured custody release and independent quorum are still required.']},null,2)+'\n');
writeFileSync(dir+'/abi.json',JSON.stringify(artifact.abi,null,2)+'\n');
console.log(JSON.stringify({registry:a.registry,blockNumber:a.blockNumber,estimatedGas:gas.toString(),status:'prepared-not-signed'}));
