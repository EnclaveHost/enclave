// Source candidate: pure linking and authenticated code-pin checks. No transactions.
// Bundle/profile must come from the reviewed local authority configuration, never
// caller JSON or an RPC-provided label. A snapshot callback is a supplied capability,
// not something this module creates or authenticates from a function-shaped value.
import {keccak256, getAddress, parseAbi} from 'viem';
const hex=x=>typeof x==='string' && /^0x(?:[0-9a-f]{2})+$/i.test(x);
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const zero='0x'+'00'.repeat(20);
function address(x){const a=getAddress(x);if(equal(a,zero))throw Error('zero binding');return a;}
function flat(refs={}){
 const out=[];
 for(const [source,names] of Object.entries(refs))for(const [name,slots] of Object.entries(names)){
  if(!Array.isArray(slots)||slots.length===0)throw Error('empty link references');
  for(const slot of slots)out.push({...slot,key:source+':'+name});
 }
 return out;
}
export function dependencies(artifact){
 return [...new Set([...flat(artifact.creationLinks),...flat(artifact.runtimeLinks)].map(x=>x.key))].sort();
}
export function linkTemplate(template,refs,bindings){
 if(typeof template!=='string'||!template.startsWith('0x')||template.length%2)throw Error('invalid bytecode template');
 let body=template.slice(2);const taken=new Set();
 const slots=flat(refs);
 const expected=[...new Set(slots.map(x=>x.key))].sort();
 if(JSON.stringify(Object.keys(bindings).sort())!==JSON.stringify(expected))throw Error('missing or extra library binding');
 for(const {key,start,length} of slots){
  if(!Number.isSafeInteger(start)||start<0||length!==20||(start+length)*2>body.length)throw Error('invalid link range');
  for(let i=start;i<start+length;i++){if(taken.has(i))throw Error('overlapping link ranges');taken.add(i);}
  const before=body.slice(start*2,(start+length)*2);
  if(!/^__\$[0-9a-f]{34}\$__$/.test(before))throw Error('link range is not compiler placeholder');
  body=body.slice(0,start*2)+address(bindings[key]).slice(2).toLowerCase()+body.slice((start+length)*2);
 }
 if(!hex('0x'+body))throw Error('unresolved bytecode');
 return '0x'+body;
}
function subset(keys,bindings){return Object.fromEntries(keys.map(k=>[k,bindings[k]]));}
function patch(body,start,length,value,used){
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<=0||(start+length)*2>body.length||!hex(value)||value.length!==2+length*2)throw Error('invalid runtime binding');
 for(let i=start;i<start+length;i++){if(used.has(i))throw Error('overlapping runtime bindings');used.add(i);}
 return body.slice(0,start*2)+value.slice(2).toLowerCase()+body.slice((start+length)*2);
}
export function resolveRuntime(artifact,{address:deployedAddress,libraries={},immutables={}}){
 const needed=dependencies(artifact);
 if(JSON.stringify(Object.keys(libraries).sort())!==JSON.stringify(needed))throw Error('missing or extra artifact library binding');
 const runtimeKeys=[...new Set(flat(artifact.runtimeLinks).map(x=>x.key))];
 let body=linkTemplate(artifact.runtimeTemplate,artifact.runtimeLinks,subset(runtimeKeys,libraries)).slice(2);
 const used=new Set(flat(artifact.runtimeLinks).flatMap(x=>Array.from({length:x.length},(_,i)=>x.start+i)));
 const ranges={...(artifact.immutableReferences||{})};
 let selfSlots=[];
 if(artifact.kind==='library'){
  const self=artifact.librarySelfAddress;
  if(self?.format!=='solc-viair-library-immutable32'||self.immutableId!=='library_deploy_address'||!Array.isArray(ranges[self.immutableId])||!ranges[self.immutableId].length)throw Error('unsupported Solidity library self binding');
  selfSlots=ranges[self.immutableId];
  for(const slot of selfSlots)if(slot.length!==32||!Number.isSafeInteger(slot.start)||slot.start<0||artifact.runtimeTemplate.slice(2+slot.start*2,2+(slot.start+32)*2)!=='00'.repeat(32))throw Error('invalid library self range');
  delete ranges[self.immutableId];
 }else if(artifact.librarySelfAddress||ranges.library_deploy_address)throw Error('unexpected self binding');
 if(JSON.stringify(Object.keys(ranges).sort())!==JSON.stringify(Object.keys(immutables).sort()))throw Error('missing or extra immutable binding');
 for(const [id,slots] of Object.entries(ranges)){
  if(!Array.isArray(slots)||!slots.length)throw Error('empty immutable range');
  for(const {start,length} of slots)body=patch(body,start,length,immutables[id],used);
 }
 for(const {start,length} of selfSlots)body=patch(body,start,length,'0x'+'00'.repeat(12)+address(deployedAddress).slice(2),used);
 return '0x'+body;
}
const abi=parseAbi([
 'function lifecycleSchema() view returns(uint256)','function deploymentsSchema() view returns(uint256)',
 'function lifecycleController() view returns(address)','function selfHostingIdentity() view returns(address)',
 'function registry() view returns(address)','function prover() view returns(address)',
 'function ledger() view returns(address)','function deployments() view returns(address)',
 'function lifecycle() view returns(address)','function lifecycleProofSchema() view returns(uint256)',
]);
/** Called INSIDE the trusted snapshot. The caller must authenticate its result.
 * Library code is checked independently; ledger bytecode only commits to address.
 */
export async function verifyLinkedLifecycleCode({client,blockNumber,bundle,profile}){
 if(bundle?.schema!==1||profile?.chainId!==8453||profile.lifecycleSchema!==3||profile.lifecycleProofSchema!==2)throw Error('unsupported linked profile');
 const keys=Object.keys(bundle.contracts||{}).sort();
 if(JSON.stringify(keys)!==JSON.stringify(Object.keys(profile.bindings||{}).sort()))throw Error('missing or extra profile code binding');
 const addresses=new Set();
 for(const key of keys){
  const art=bundle.contracts[key],binding=profile.bindings[key],a=address(binding.address);
  if(addresses.has(a.toLowerCase()))throw Error('duplicate code address');addresses.add(a.toLowerCase());
  if(!/^0x[0-9a-f]{64}$/i.test(binding.codeHash||'')||equal(binding.codeHash,'0x'+'00'.repeat(32)))throw Error('missing deployed code pin');
  const libraries={};
  for(const lib of dependencies(art)){
   if(bundle.contracts[lib]?.kind!=='library'||!profile.bindings[lib])throw Error('unknown library dependency');
   libraries[lib]=profile.bindings[lib].address;
  }
  const expected=resolveRuntime(art,{address:a,libraries,immutables:binding.immutables||{}});
  if((expected.length-2)/2>24576)throw Error('oversized runtime');
  if(!equal(keccak256(expected),binding.codeHash))throw Error('profile pin differs from resolved runtime');
  const actual=await client.getCode({address:a,blockNumber});
  if(!hex(actual)||!equal(keccak256(actual),binding.codeHash))throw Error('deployed linked code differs');
 }
 const registryAddress=address(profile.registry);
 if(!/^0x[0-9a-f]{64}$/i.test(profile.registryCodeHash||''))throw Error('missing registry code pin');
 const registryCode=await client.getCode({address:registryAddress,blockNumber});
 if(!hex(registryCode)||!equal(keccak256(registryCode),profile.registryCodeHash))throw Error('registry code differs');
 const names=profile.roles||{};
 for(const name of ['ledger','controller','identity','prover'])if(!keys.includes(names[name])||bundle.contracts[names[name]].kind!=='contract')throw Error('missing role');
 if(new Set(Object.values(names)).size!==4||Object.keys(names).length!==4)throw Error('duplicate or extra role');
 const read=(role,fn)=>client.readContract({address:profile.bindings[names[role]].address,abi,functionName:fn,blockNumber});
 const at=role=>profile.bindings[names[role]].address;
 const [schema,life,controller,identity,registry,prover,boundLedger,pLedger,pRegistry,pController,pSchema]=await Promise.all([
  read('ledger','deploymentsSchema'),read('ledger','lifecycleSchema'),read('ledger','lifecycleController'),read('ledger','selfHostingIdentity'),read('ledger','registry'),read('ledger','prover'),
  read('controller','ledger'),read('prover','deployments'),read('prover','registry'),read('prover','lifecycle'),read('prover','lifecycleProofSchema')]);
 if(schema!==17n||life!==3n||pSchema!==2n||!equal(controller,at('controller'))||!equal(identity,at('identity'))||!equal(prover,at('prover'))||!equal(boundLedger,at('ledger'))||!equal(pLedger,at('ledger'))||!equal(pController,at('controller'))||!equal(registry,address(profile.registry))||!equal(pRegistry,registry))throw Error('linked profile authority pair differs');
 return {codePinsVerified:true,libraryCount:keys.filter(k=>bundle.contracts[k].kind==='library').length,blockNumber};
}
export async function readLinkedLifecyclePreflight({snapshot,bundle,profile}){
 if(typeof snapshot!=='function')throw Error('trusted snapshot capability required');
 const r=await snapshot((client,blockNumber)=>verifyLinkedLifecycleCode({client,blockNumber,bundle,profile}));
 if(r?.value?.blockNumber!==r?.blockNumber)throw Error('snapshot block differs');
 if(r?.evidence?.proofVerified!==true||r.evidence.tier!=='l1-finalized-derived'||!/^0x[0-9a-f]{64}$/i.test(r.blockHash||'')||equal(r.blockHash,'0x'+'00'.repeat(32)))throw Error('authenticated in-domain snapshot required');
 return {readOnly:true,executable:false,code:r.value,blockHash:r.blockHash,blockNumber:r.blockNumber,evidence:r.evidence,
  remaining:['Owner-consented independent admission and financial profile','Old-runner and escrow migration conservation','Host capacity, sponsor and independent offline funding','Live positive authority and production consumer integration']};
}
