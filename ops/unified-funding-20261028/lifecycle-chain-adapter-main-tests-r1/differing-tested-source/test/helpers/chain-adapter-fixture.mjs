// Inert contract-state and finality doubles; real reviewed runtime templates,
// typed signatures, transaction bytes, headers and receipt tries. No network.
import { getAddress, keccak256, toBytes, hexToBytes, bytesToHex, hashTypedData, encodeEventTopics, encodeAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';
import { loadSchema3Bundle, SCHEMA3_ROLES } from '../../network/lifecycle-schema3-profile.mjs';
import { loadHostRegistryArtifact, HOST_REGISTRY_ARTIFACT_SHA256, HOST_REGISTRY_FEATURE } from '../../network/lifecycle-host-registry-profile.mjs';
import { resolveRuntime, dependencies } from '../../network/lifecycle-linked-artifacts.mjs';
import { transitionTypedData } from '../../network/deployment-transition-intent.mjs';
import { consensusReceiptsRoot, orderedTrieRoot, logsBloom } from '../../network/op-receipts-root.mjs';
import { headerHash } from '../../network/derived-reader/vendor/anchor-bootstrap.mjs';

export const zero='0x'+'00'.repeat(20), zero32='0x'+'00'.repeat(32);
const hash=s=>keccak256(toBytes(s)), addr=n=>getAddress('0x'+n.toString(16).padStart(40,'0'));
const kc=b=>hexToBytes(keccak256(b)), hex=n=>'0x'+BigInt(n).toString(16);
export function chainFixture() {
 const f={now:1800000000000, timestamp:1800000000000, number:100n, blockHash:hash('block'), calls:[], sent:[],
  id:hash('app-deployment'),host:hash('host'),measurement:hash('measurement'),revision:1n,generation:1n,state:1,
  lastIntent:zero32,hostRevision:1n,hostStatus:1,proof:true,tier:'l1-finalized-derived',maxGas:1000n,maxCharge:100n};
 f.owner=privateKeyToAccount(generatePrivateKey());f.operator=privateKeyToAccount(generatePrivateKey());
 f.relayAccount=privateKeyToAccount(generatePrivateKey());f.witness=privateKeyToAccount(generatePrivateKey());
 const roles=['lifecycle','ledger','identity','registry','l1Oracle','catalog','hostOwnership','usdc','legacyLedger','connectivity',
  'pinnedSessionAuthority','proofOfTime','secretVaultV2','sessionVaultFactory','sessionVaultImplementation','verificationFees','accountingLibrary'];
 const C=Object.fromEntries(roles.map((r,i)=>[r,{address:addr(i+1),codeHash:keccak256('0x6000')}]));C.hostOwnership.address=C.registry.address;
 const code=new Map(roles.map(r=>[C[r].address.toLowerCase(),'0x6000']));
 const B=(role,bindings)=>Object.assign(C[role],{abi:role,bindings});
 B('connectivity',{ledger:'ledger',registry:'registry'});
 B('pinnedSessionAuthority',{appCatalog:'catalog',deployments:'ledger',sessionVaultFactory:'sessionVaultFactory'});
 B('proofOfTime',{deployments:'ledger',owner:'admin:proofOfTimeOwner',pendingOwner:'admin:proofOfTimePendingOwner',registry:'registry'});
 B('secretVaultV2',{book:'pinnedSessionAuthority',deploymentLedger:'ledger',enclaveOwner:'external:enclaveOwner',hostOwnership:'hostOwnership',hostRegistry:'registry',sessionVaultFactory:'sessionVaultFactory'});
 B('sessionVaultFactory',{'authorityPins.ledger':'legacyLedger','authorityPins.catalog':'catalog','authorityPins.authority':'pinnedSessionAuthority',implementation:'sessionVaultImplementation'});
 B('sessionVaultImplementation',{book:'pinnedSessionAuthority',factory:'sessionVaultFactory',keyAttestations:'external:keyAttestations',owner:'zero',router:'external:router',usdc:'usdc'});
 B('verificationFees',{ledger:'ledger',proof:'proofOfTime',token:'usdc'});
 const bundle=loadSchema3Bundle('bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e');
 const targets={ledger:['registry','usdc'],lifecycle:['l1Oracle','ledger'],proofOfTime:['ledger','lifecycle','registry','uint64:3600'],identity:[],accountingLibrary:[]};
 const immutables=Object.fromEntries(Object.entries(targets).map(([role,ts])=>[role,Object.fromEntries(Object.keys(bundle.contracts[SCHEMA3_ROLES[role]].immutableReferences??{}).filter(k=>k!=='library_deploy_address').sort().map((k,i)=>[k,ts[i]]))]));
 for(const [role,key] of Object.entries(SCHEMA3_ROLES)){
  const art=bundle.contracts[key],libraries=Object.fromEntries(dependencies(art).map(k=>[k,C.accountingLibrary.address]));
  const im=Object.fromEntries(Object.entries(immutables[role]).map(([k,t])=>[k,t.startsWith('uint64:')?'0x'+BigInt(t.slice(7)).toString(16).padStart(64,'0'):'0x'+'0'.repeat(24)+C[t].address.slice(2).toLowerCase()]));
  const runtime=resolveRuntime(art,{address:C[role].address,libraries,immutables:im});C[role].codeHash=keccak256(runtime);code.set(C[role].address.toLowerCase(),runtime);
 }
 const registry=loadHostRegistryArtifact();for(const r of ['registry','hostOwnership'])C[r].codeHash=registry.runtimeCodeHash;code.set(C.registry.address.toLowerCase(),registry.runtime);
 f.pins={chainId:8453,profile:'independent-host-registry-r1',host:f.host,payee:f.relayAccount.address,maxChargeWei:'100',maxGasPriceWei:'1000',
  allowedMeasurements:[f.measurement],contracts:C,externals:{keyAttestations:addr(50),router:addr(51),enclaveOwner:addr(52)},
  identityFactories:[{factory:C.sessionVaultFactory.address,codeHash:C.sessionVaultFactory.codeHash}],preservedFactories:['sessionVaultFactory'],
  admins:{ledgerOwner:[f.owner.address],ledgerPendingOwner:[zero],proofOfTimeOwner:[f.owner.address],proofOfTimePendingOwner:[zero]},
  schema3:{immutables},hostRegistry:{artifactSha256:HOST_REGISTRY_ARTIFACT_SHA256}};
 const authorityTuple=()=>[f.operator.address,zero,f.hostRevision,zero32];
 const assignment=()=>[f.owner.address,f.state,f.generation,f.revision,f.state===2?f.host:zero32,f.state===2?f.operator.address:zero,1n,0n,0n,false,f.lastIntent];
 const roleOf=a=>roles.find(r=>C[r].address.toLowerCase()===a.toLowerCase());
 const binding=t=>t==='zero'?zero:t.startsWith('admin:')?f.pins.admins[t.slice(6)][0]:t.startsWith('external:')?f.pins.externals[t.slice(9)]:C[t].address;
 const client={
  getCode:async q=>{f.calls.push(q);if(q.blockNumber!==f.number)throw Error('test mixed block');return code.get(q.address.toLowerCase());},
  getStorageAt:async q=>{if(q.blockNumber!==f.number)throw Error('test mixed block');const slot=BigInt(q.slot),start=BigInt(keccak256(zero32));
   if(slot===0n)return '0x'+'0'.repeat(63)+'1';if(slot===start)return '0x'+'0'.repeat(24)+C.sessionVaultFactory.address.slice(2);if(slot===start+1n)return C.sessionVaultFactory.codeHash;throw Error('unknown storage');},
  readContract:async q=>{
   f.calls.push(q);if(q.blockNumber!==f.number)throw Error('test mixed block');const role=roleOf(q.address),n=q.functionName;
   if(f.onCall)await f.onCall(role,n);
   if(n==='authorityPins')return ['legacyLedger','catalog','pinnedSessionAuthority'].map(r=>C[r].address);
   if(C[role]?.bindings?.[n])return binding(C[role].bindings[n]);
   const simple={lifecycleSchema:3n,deploymentsSchema:17n,proofSchema:2n,lifecycleProofSchema:2n,registrySchema:5n,hostLifecycleSchema:1n,
    registryFeature:HOST_REGISTRY_FEATURE,STATUS_ONLINE:1,STATUS_OFFLINE:2,lifecycleController:C.lifecycle.address,selfHostingIdentity:C.identity.address,
    registry:C.registry.address,ledger:C.ledger.address,deployments:C.ledger.address,lifecycle:C.lifecycle.address,prover:C.proofOfTime.address,l1Oracle:C.l1Oracle.address,
    owner:f.owner.address,pendingOwner:zero};if(n in simple)return simple[n];
   if(n==='authority')return authorityTuple();
   if(n==='hostState')return [1n,f.hostStatus,1n,1800009999n,...['hardware','descriptor','qualification','resource','trust'].map(hash),zero32];
   if(n==='reporterPolicy')return [[f.witness.address],1,f.hostRevision];
   if(n==='assignments')return assignment();if(n==='budgets')return [10000n,f.maxCharge,100n,f.maxGas];
   if(n==='ownerAuthority')return f.owner.address;if(n==='lifecycleOperator')return f.operator.address;
   if(n==='witnessesOf')return [f.witness.address];if(n==='threshold')return 1n;if(n==='maxAnchorAgeSec')return 20n;
   if(n==='offline')return [0n,0n,false,false,zero32,zero];if(n==='lastEmergency')return zero32;
   if(n==='digest')return hashTypedData(transitionTypedData({chainId:8453,lifecycle:C.lifecycle.address},q.args[0]));
   if(n==='get'&&role==='ledger')return {owner:f.owner.address,active:true,isPublic:false,appRef:'catalog://'+hash('app')+'/0',leaseUntil:2n**64n-1n,
    balance6:1000n,cpuMilli:100n,gpuMilli:0n,configCid:'test-cid'};
   if(n==='get'&&role==='registry')return {active:f.hostStatus===1,operator:f.operator.address,measurement:f.measurement};
   if(n==='getApp')return {appId:hash('app'),versionCount:1n,active:true};
   if(n==='getVersion')return {cid:'test-cid',createdAt:1n,yanked:false,approval:1,memMb:1,cpuGflops:1,vramMb:0,gpuGflops:0};
   if(n==='rateFor')return 0n;if(n==='lifecycleFunded')return true;if(n==='spendable')return 10000n;if(n==='retired')return false;
   throw Error('unhandled test contract read '+role+'.'+n);
  }
 };
 f.authority={kind:'derived',snapshot:async read=>{const header={number:f.number,hash:f.blockHash,timestamp:f.timestamp};
  const value=await read(client,f.number,f.headerOverride?.(header)??header);
  return {blockNumber:f.number,blockHash:f.blockHash,timestamp:f.timestamp,value,evidence:{proofVerified:f.proof,tier:f.tier},...f.resultOverride};}};
 f.receipts={locate:async()=>f.block?{blockNumber:Number(f.number),transactionHash:f.txHash}:null,header:async()=>f.block.header,block:async()=>structuredClone(f.block)};
 const options={pins:f.pins,authority:f.authority,receipts:f.receipts,hostPolicy:{load:async()=>{throw Error('no policy document');}},now:()=>f.now,
  actorSigner:async q=>{if(f.onSign)await f.onSign();const a=q.target==='running'?f.operator:f.owner;return {address:a.address,signature:await a.signTypedData(q.typedData)};},
  approvals:async q=>{if(f.onApprovals)await f.onApprovals();return [await f.witness.signTypedData(q.typedData)];},
  relay:{address:f.relayAccount.address,send:async q=>{f.sent.push(q);if(f.loseResponse)throw Error('test response lost');}}};
 f.create=over=>createLifecycleChainAdapter({...options,...over});f.adapter=f.create();
 f.mine=async intent=>{
  const sent=f.sent.at(-1),x=JSON.parse(intent.payload).intent;f.state=x.target;f.generation=BigInt(x.generation)+1n;f.lastIntent=intent.digest;
  const abi=bundle.contracts[SCHEMA3_ROLES.lifecycle].abi;
  const log=(eventName,args)=>{const event=abi.find(e=>e.type==='event'&&e.name===eventName),plain=event.inputs.filter(i=>!i.indexed);
   return {address:C.lifecycle.address,topics:encodeEventTopics({abi,eventName,args}),data:encodeAbiParameters(plain,plain.map(i=>args[i.name]))};};
  const logs=[log('Transitioned',{id:f.id,generation:f.generation,state:f.state,host:f.state===2?f.host:zero32,operator:f.state===2?f.operator.address:zero}),
   log('TransitionPaid',{id:f.id,intent:intent.digest,payee:f.relayAccount.address,chargedWei:1n})];
  const raw=await f.relayAccount.signTransaction({chainId:8453,type:'eip1559',nonce:0,gas:100000n,maxFeePerGas:sent.maxFeePerGasWei,maxPriorityFeePerGas:1n,to:sent.to,data:sent.data});
  const consensus={type:'0x2',status:1,cumulativeGasUsed:100n,logs:logs.map(l=>({address:hexToBytes(l.address),topics:l.topics.map(hexToBytes),data:hexToBytes(l.data)}))};
  const bloom=bytesToHex(logsBloom(consensus.logs,kc)),header={parentHash:zero32,sha3Uncles:zero32,miner:zero,stateRoot:hash('state'),
   transactionsRoot:orderedTrieRoot([hexToBytes(raw)],kc),receiptsRoot:consensusReceiptsRoot([consensus],kc),logsBloom:bloom,difficulty:'0x0',number:hex(f.number),
   gasLimit:'0x100000',gasUsed:'0x64',timestamp:hex(f.timestamp/1000),extraData:'0x',mixHash:zero32,nonce:'0x'+'00'.repeat(8)};
  f.blockHash=headerHash(header,kc);f.txHash=keccak256(raw);header.hash=f.blockHash;
  const common={blockHash:f.blockHash,blockNumber:hex(f.number),transactionHash:f.txHash,transactionIndex:'0x0'};
  f.block={header,transactions:[raw],receipts:[{...common,type:'0x2',status:'0x1',cumulativeGasUsed:'0x64',logsBloom:bloom,logs:logs.map((l,i)=>({...l,...common,logIndex:hex(i)}))}]};
 };
 return f;
}
