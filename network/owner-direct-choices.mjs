// Discovery only: reconcilers may skip NKN wallet creation for an owner-selected
// direct route. The agent still independently verifies the quorum lease/policy.
import {parseAbi,stringToHex} from 'viem';
const abi=parseAbi(['function addr(bytes32) view returns (address)','function viaTuna(bytes32) view returns (bool)','function policies(bytes32) view returns (address,uint64,uint64,uint64,uint128,uint128,uint16)']);
export async function ownerDirectChoices(client,book,rows,runner,now=Date.now()){
 const address=await client.readContract({address:book,abi,functionName:'addr',args:[stringToHex('connectivity',{size:32})]});
 const ids=new Set();if(/^0x0{40}$/i.test(address))return ids;
 for(const row of rows.filter(r=>r.active&&String(r.runner).toLowerCase()===runner)){
  const policy=await client.readContract({address,abi,functionName:'policies',args:[row.id]});
  if(String(policy[0]).toLowerCase()===String(row.owner).toLowerCase()&&Number(policy[2])>0&&!await client.readContract({address,abi,functionName:'viaTuna',args:[row.id]}))ids.add(String(row.id).toLowerCase());
 }
 return ids;
}
