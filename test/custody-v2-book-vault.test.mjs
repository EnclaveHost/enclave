// The deployed production vault 0xE486 (EnclaveSecretVaultV2 at e4e045941) has no hostOwnership/hostRegistry/
// deploymentLedger getters: it reads the administrator's EnclaveAddressBook at each call and classifies its Enclave seat by
// the registry payout declaration. vaultKind "book" reads exactly that, at the agreed block, while the accepted host wallet
// still comes from the deployed EnclaveHostOwnership extension and is never inferred from payout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createChainReaderV2,VAULT_V2_ABI,LEDGER_ABI,REGISTRY_V4_ABI,HOST_OWNERSHIP_ABI,BOOK_ABI,BOOK_KEYS} from '../custody/v2/chain.mjs';
import {createMember,machineBinding} from '../custody/v2/member.mjs';
import {judgeCodePermit} from '../custody/v2/governance.mjs';
import {custodianMeasured} from '../custody/v2/build-config.mjs';
import {readerKindFor} from '../cli/custody-v2.mjs';
import * as D from '../custody/v2/digests.mjs';
import * as hpke from '../custody/hpke.mjs';
import {wireClient} from './helpers/custody-rpc.mjs';

const a=(n)=>'0x'+n.repeat(20);
const vault=a('11'),book=a('12'),ledger=a('22'),registry=a('33'),registry2=a('34'),ownership=a('35');
const enclave=a('0b'),hostOwner=a('44'),stranger=a('66'),zeroA=a('00');
const id='0x'+'55'.repeat(32),zero='0x'+'00'.repeat(32),endpoint='https://host.example',host='0x'+'77'.repeat(32);
const ABIS={[vault]:VAULT_V2_ABI,[book]:BOOK_ABI,[ledger]:LEDGER_ABI,[registry]:REGISTRY_V4_ABI,[registry2]:REGISTRY_V4_ABI,[ownership]:HOST_OWNERSHIP_ABI};
const key=(k)=>BOOK_KEYS[k];

// One RPC's view of the original vault at block 10. `state` is mutable so a test can model an admin book change.
function client(state) {
 return wireClient({getBlockNumber:async()=>10n,getBlock:async({blockNumber})=>({number:blockNumber,timestamp:1000n,hash:'0x'+'ab'.repeat(32)}),readContract:async({address,functionName,args})=>{
  if(address===vault){
   if(['deploymentLedger','hostRegistry','hostOwnership','sessionVaultFactory'].includes(functionName))throw Error('execution reverted: the deployed vault has no '+functionName);
   if(functionName==='book')return state.book??book;
   if(functionName==='enclaveOwner')return enclave;
   if(functionName==='policyOf')return [hostOwner,2n,2n,zero,false,'0x'];
   if(functionName==='bundleOf')return [zero,2n,'0x'];
   if(functionName==='beneficialOwnerOf')return hostOwner;
  }
  if(address===book&&functionName==='addr'){
   if(args[0]===key('deployments'))return state.ledger??ledger;
   if(args[0]===key('registry'))return state.registry??registry;
  }
  if(address===ledger&&functionName==='get')return {owner:hostOwner,runner:zero,leaseUntil:1100n,appRef:'catalog://x/0',configCid:'',id,ports:'',gpuMilli:0,cpuMilli:0,appPort:443,isPublic:false,active:true,createdAt:1n,rate:0n,balance6:0n,spent6:0n,runnerOperator:hostOwner};
  if((address===registry||address===registry2)&&functionName==='get')
   return {endpoint,repo:'',measurement:zero,operator:state.operator??(address===registry2?stranger:hostOwner),registeredAt:1n,lastSeen:1n,active:state.active??true,cpuPricePerSec6:0n,gpuPricePerSec6:0n,proofKey:hostOwner,payoutWallet:state.payout??enclave};
  if(address===ownership&&functionName==='registry')return state.ownershipRegistry??registry;
  if(address===ownership&&functionName==='authority')return [state.accepted??zeroA,zeroA,1n,zero];
  throw Error('unexpected lookup '+address+' '+functionName);
 }},ABIS);
}
const reader=(states,opts={})=>createChainReaderV2({vault,vaultKind:'book',book,hostOwnership:ownership,clients:states.map(client),minAgree:2,maxAgeSec:120,now:()=>1000_000,...opts});

test('book-bound release reads the ledger and registry the vault itself reads at that block (no pinned getters)',async()=>{
 const r=await reader([{},{}]).readRelease({id,endpoint});
 assert.equal(r.lease.owner,hostOwner);assert.equal(r.endpointOperator,hostOwner);assert.equal(r.policy.owner,hostOwner);
});
test('an administrator book change is followed at the next agreed block, as the vault follows it',async()=>{
 const s={};const r=reader([s,s]);
 assert.equal((await r.readRelease({id,endpoint})).endpointOperator,hostOwner);
 s.registry=registry2;s.ownershipRegistry=registry2;   // admin re-points "registry"; the ownership pin follows a reviewed migration
 assert.equal((await r.readRelease({id,endpoint})).endpointOperator,stranger);
});
test('book mode fails closed on a different book, a missing entry, or RPCs that disagree about the book',async()=>{
 await assert.rejects(reader([{book:a('13')},{book:a('13')}]).readRelease({id,endpoint}),/only 0 RPCs|book_mismatch|differs from the configured pin/);
 await assert.rejects(reader([{ledger:zeroA},{ledger:zeroA}]).readRelease({id,endpoint}),/release_authority_missing|only 0 RPCs/);
 await assert.rejects(reader([{},{registry:registry2}]).readRelease({id,endpoint}),/disagree/);
});
test('book-mode membership never runs without the host-ownership pin, and pinned mode never consults the book',async()=>{
 const noPin=createChainReaderV2({vault,vaultKind:'book',book,clients:[client({}),client({})],minAgree:2,maxAgeSec:120,now:()=>1000_000});
 assert.equal((await noPin.readRelease({id,endpoint})).endpointOperator,hostOwner);     // the owner's release read needs no pin
 await assert.rejects(noPin.readRegistryEntry({registryId:host}),/only 0 RPCs|host_authority_missing/);
 await assert.rejects(noPin.readAuthorization({registryIds:[host]}),/only 0 RPCs|host_authority_missing/);
 assert.throws(()=>createChainReaderV2({vault,vaultKind:'book',hostOwnership:zeroA,clients:[client({})],minAgree:1}),/non-zero address/);
 assert.throws(()=>createChainReaderV2({vault,vaultKind:'auto',hostOwnership:ownership,clients:[client({})],minAgree:1}),/pinned or book/);
 const pinned=createChainReaderV2({vault,clients:[client({}),client({})],minAgree:2,maxAgeSec:120,now:()=>1000_000});
 await assert.rejects(pinned.readRelease({id,endpoint}),/only 0 RPCs/);           // the deployed vault reverts; no book fallback
 await assert.rejects(pinned.readRegistryEntry({registryId:host}),/only 0 RPCs/);
});
test('entries report the vault Enclave flag (payout) separately from the accepted host wallet',async()=>{
 // custody-metal0 today: Enclave-paid, no accepted owner
 let {entry}=await reader([{},{}]).readRegistryEntry({registryId:host});
 assert.deepEqual([entry.vaultEnclave,entry.owner,entry.ownerConflict,entry.payoutWallet],[true,zeroA,false,enclave]);
 ({entry}=await reader([{accepted:enclave},{accepted:enclave}]).readRegistryEntry({registryId:host}));
 assert.deepEqual([entry.vaultEnclave,entry.ownerConflict],[true,false]);
 ({entry}=await reader([{accepted:stranger},{accepted:stranger}]).readRegistryEntry({registryId:host}));
 assert.deepEqual([entry.vaultEnclave,entry.owner,entry.ownerConflict],[true,stranger,true]);
 ({entry}=await reader([{payout:hostOwner,accepted:hostOwner},{payout:hostOwner,accepted:hostOwner}]).readRegistryEntry({registryId:host}));
 assert.deepEqual([entry.vaultEnclave,entry.owner,entry.ownerConflict],[false,hostOwner,false]);
 // an accepted owner equal to the Enclave wallet does NOT make a seat Enclave on this vault: only its payout declaration does
 ({entry}=await reader([{payout:hostOwner,accepted:enclave},{payout:hostOwner,accepted:enclave}]).readRegistryEntry({registryId:host}));
 assert.equal(entry.vaultEnclave,false);
});
test('an ownership extension bound to another registry than the book names fails closed',async()=>{
 await assert.rejects(reader([{ownershipRegistry:registry2},{ownershipRegistry:registry2}]).readRegistryEntry({registryId:host}),/only 0 RPCs|host_authority_mismatch/);
 await assert.rejects(reader([{ownershipRegistry:registry2},{ownershipRegistry:registry2}]).readAuthorization({registryIds:[host]}),/only 0 RPCs|host_authority_mismatch/);
});

// ---- membership: the Enclave seat keeps serving; another wallet's host cannot be seated as Enclave; unowned others refused
const sha=b=>'0x'+createHash('sha256').update(b).digest('hex');
function rig(entry) {
 const op=privateKeyToAccount(generatePrivateKey()),ident=privateKeyToAccount(generatePrivateKey()),kp=hpke.generateKeyPair();
 const meas=Buffer.alloc(48,7),chip=Buffer.alloc(64,3),cid='0x'+'c1'.repeat(32);
 const m={identity:ident.address.toLowerCase(),encKey:'0x'+Buffer.from(kp.publicKey).toString('hex'),endpoint:'https://custody.example',registryId:host,measurement:sha(meas),chipId:sha(chip)};
 const full={active:true,operator:op.address.toLowerCase(),payoutWallet:enclave,owner:zeroA,...entry};
 const chain={readRegistryEntry:async()=>({entry:full}),readCommittee:async()=>({committee:{committeeId:cid,epoch:1,t:1,W:1,machines:[],commitments:Buffer.alloc(0)},pending:null}),
  readAuthorization:async({registryIds})=>({committee:null,entries:Object.fromEntries(registryIds.map(r=>[r,full])),codeActiveAt:{[sha(meas)]:1},valid:[],blockNumber:10n,blockTimestamp:1000})};
 const member=createMember({chainId:8453,vault,identity:ident,encPrivateKey:kp.privateKey,machine:m,enclaveOwner:enclave,chain,store:{load:()=>null,save:()=>{}},
  submit:()=>{throw Error('no tx');},attestSelf:()=>{throw Error('not needed');},capacityCheck:async()=>({ok:false,reason:'no capacity'}),log:()=>{},
  fetchJson:async(url,{nonce})=>({machine:m,hostSig:member._hs,report:Buffer.from(machineBinding(m,Buffer.from(nonce,'hex'))).toString('base64')}),
  verifyPeerQuote:async()=>({ok:true,measurement:meas.toString('hex'),chipId:chip.toString('hex')})});
 return {member,m,cid,sign:()=>D.signDigest(op,D.hostDigest({chainId:8453,vault,machine:m}))};
}
test('book mode: an unenrolled Enclave-paid seat keeps its binding (existing epoch) but is not admissible to a future epoch',async()=>{
 const r=rig({vaultEnclave:true,ownerConflict:false});          // custody-metal0 today: payout == Enclave wallet, no accepted owner
 const sig=await r.sign();r.member._hs=sig;
 assert.deepEqual(await r.member.setHostSig(sig),{enclave:true,admissible:false,reason:'host wallet ownership has not been accepted'});
 await assert.rejects(r.member.join({machine:r.m,hostSig:sig},r.cid),/ownership has not been accepted/);
 await assert.rejects(r.member.genesis({salt:'0x'+'01'.repeat(32),codeSet:[r.m.measurement]}),/genesis: host wallet ownership has not been accepted/);
});
test('book mode: an Enclave-owned AND Enclave-seated host is admissible as the Enclave seat',async()=>{
 const r=rig({vaultEnclave:true,ownerConflict:false,owner:enclave});
 const sig=await r.sign();r.member._hs=sig;
 assert.deepEqual(await r.member.setHostSig(sig),{enclave:true});
 assert.deepEqual(await r.member.join({machine:r.m,hostSig:sig},r.cid),{ok:true,enclave:true});
});
test('book mode: payout-versus-owner mismatches are refused in both directions, before any seat is proposed',async()=>{
 const r=rig({vaultEnclave:true,ownerConflict:true,owner:stranger});   // formerly Enclave host now owned by a stranger
 const sig=await r.sign();r.member._hs=sig;
 await assert.rejects(r.member.setHostSig(sig),/another wallet accepted its ownership/);
 await assert.rejects(r.member.join({machine:r.m,hostSig:sig},r.cid),/another wallet accepted its ownership/);
 const x=rig({vaultEnclave:false,ownerConflict:false,payoutWallet:hostOwner,owner:enclave});   // Enclave-owned, no Enclave payout
 const s2=await x.sign();x.member._hs=s2;
 await assert.rejects(x.member.setHostSig(s2),/independent seat/);
 await assert.rejects(x.member.join({machine:x.m,hostSig:s2},x.cid),/independent seat/);
});
test('book mode: a non-Enclave host still needs an accepted owner; payout alone is never ownership',async()=>{
 const r=rig({vaultEnclave:false,ownerConflict:false,payoutWallet:hostOwner,owner:zeroA});
 const sig=await r.sign();r.member._hs=sig;
 assert.equal((await r.member.setHostSig(sig)).admissible,false);
 await assert.rejects(r.member.join({machine:r.m,hostSig:sig},r.cid),/ownership has not been accepted/);
 const owned=rig({vaultEnclave:false,ownerConflict:false,payoutWallet:hostOwner,owner:hostOwner});
 const s2=await owned.sign();owned.member._hs=s2;
 assert.deepEqual(await owned.member.setHostSig(s2),{enclave:false});
 // the capacity/admission check still applies to the non-Enclave candidate
 await assert.rejects(owned.member.join({machine:owned.m,hostSig:s2},owned.cid),/proof of capacity: no capacity/);
});
test('pinned entries (no vaultEnclave field) keep the accepted-owner classification unchanged',async()=>{
 const r=rig({owner:zeroA});const sig=await r.sign();
 await assert.rejects(r.member.setHostSig(sig),/ownership has not been accepted/);
 const e=rig({owner:enclave});const s=await e.sign();
 assert.deepEqual(await e.member.setHostSig(s),{enclave:true});
});

test('code permits: the Enclave seat votes only while the Enclave wallet is its accepted owner and its vault seat agrees',()=>{
 const com={t:2,machines:[{registryId:host,enclave:true},{registryId:'0x'+'78'.repeat(32),enclave:false},{registryId:'0x'+'79'.repeat(32),enclave:false}]};
 const snap=(e0)=>({committee:com,blockTimestamp:1000,entries:{[host]:e0,['0x'+'78'.repeat(32)]:{active:true,owner:hostOwner},['0x'+'79'.repeat(32)]:{active:true,owner:stranger}}});
 const permit={expiresAt:1500},j=(e0,signers)=>judgeCodePermit({snapshot:snap(e0),index:0,permit,signers:new Set(signers),enclaveOwner:enclave});
 assert.deepEqual(j({active:true,owner:enclave,vaultEnclave:true,ownerConflict:false},[enclave]),{ok:true,owner:enclave});
 assert.equal(j({active:true,owner:zeroA,vaultEnclave:true,ownerConflict:false},[enclave]).ok,false,'payout alone (unenrolled) never authorizes code');
 assert.equal(j({active:true,owner:stranger,vaultEnclave:true,ownerConflict:true},[enclave,stranger]).ok,false);
 assert.equal(j({active:true,owner:enclave,vaultEnclave:false,ownerConflict:false},[enclave]).ok,false,'payout cleared: the vault no longer seats it as Enclave');
 assert.equal(j({active:true,owner:enclave,vaultEnclave:true,ownerConflict:false},[hostOwner]).ok,false);
 // pinned (no vaultEnclave): unchanged - the accepted owner must be the Enclave wallet
 assert.equal(j({active:true,owner:zeroA},[enclave]).ok,false);
 assert.equal(j({active:true,owner:enclave},[enclave]).ok,true);
});

test('measured build: --book selects the reviewed book-bound vault with its code hash; pinned images stay byte-identical; no independent genesis',()=>{
 const v='0xe48699b8401564aace7a814ae4569b67a3f7eef5',h='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7',b='0xab214342d5a490150a4a977063a2f88e21f80907';
 const pinned=custodianMeasured({vault:a('e4'),hostOwnership:h});
 assert.equal('vaultKind' in pinned.measured,false);assert.equal('book' in pinned.measured,false);assert.equal('vaultCodeHash' in pinned.measured,false);
 const bound=custodianMeasured({vault:v,hostOwnership:h,book:b});
 assert.equal(bound.measured.vaultKind,'book');assert.equal(bound.measured.book,b);assert.equal(bound.policy,null);
 assert.equal(bound.measured.vaultCodeHash,'0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b');
 assert.throws(()=>custodianMeasured({vault:v,hostOwnership:h,book:b,admission:'owner-permits'}),/independent genesis/);
 assert.throws(()=>custodianMeasured({vault:v,hostOwnership:h,book:zeroA}),/--book/);
 assert.throws(()=>custodianMeasured({vault:v,hostOwnership:h,book:a('13')}),/reviewed book-bound vault/,'another book');
 assert.throws(()=>custodianMeasured({vault:'0x56b81b3970a8ac2c52f9874bd2758ede30758228',hostOwnership:h,book:b}),/reviewed book-bound vault/,'the pinned variant is not book-bound');
 assert.throws(()=>custodianMeasured({vault:v,book:b}),/--host-ownership/);
});

test('the owner CLI reads the deployed 0xE486 vault through its book and every other vault as pinned',()=>{
 assert.deepEqual(readerKindFor('0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5'),{vaultKind:'book',book:'0xab214342d5a490150a4a977063a2f88e21f80907'});
 assert.deepEqual(readerKindFor('0x56b81b3970a8ac2c52f9874Bd2758eDE30758228'),{vaultKind:'pinned'});
});

// ---- reviewed vault identity and the production pin document ----
import fs from 'node:fs';
import {REVIEWED_CUSTODY_VAULTS,PRODUCTION_CUSTODY_VAULT,custodyVaultKind,checkCustodyVaultIdentity} from '../network/custody-vaults.mjs';
import {validateContractPins} from '../network/contract-pins.mjs';
test('reviewed vault identity: the production vault is book-bound with its book and ownership pin; code and immutables must match',()=>{
 const P='0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5',V='0x56b81b3970a8ac2c52f9874Bd2758eDE30758228';
 assert.deepEqual(custodyVaultKind(P),{vaultKind:'book',book:'0xab214342d5a490150a4a977063a2f88e21f80907',hostOwnership:'0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7'});
 assert.deepEqual(custodyVaultKind(V),{vaultKind:'pinned'});
 assert.equal(custodyVaultKind(vault),null,'an unreviewed vault has no table kind');
 const good={codeHash:'0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b',runtimeBytes:19719,book:'0xab214342d5a490150a4a977063a2f88e21f80907',enclaveOwner:'0x0b2d009c0c9af05b12100d77f3c815fea822ee61'};
 assert.equal(checkCustodyVaultIdentity(P,good).vaultKind,'book');
 assert.throws(()=>checkCustodyVaultIdentity(P,{...good,codeHash:'0x'+'00'.repeat(32)}),/runtime differs/);
 assert.throws(()=>checkCustodyVaultIdentity(P,{...good,book:a('13')}),/book differs/);
 assert.throws(()=>checkCustodyVaultIdentity(P,{...good,enclaveOwner:a('13')}),/enclaveOwner differs/);
 assert.throws(()=>checkCustodyVaultIdentity(vault,good),/not a reviewed/);
 const pv=REVIEWED_CUSTODY_VAULTS[V.toLowerCase()];
 assert.throws(()=>checkCustodyVaultIdentity(V,{codeHash:pv.codeHash,runtimeBytes:pv.runtimeBytes,book:pv.immutable.book,enclaveOwner:pv.immutable.enclaveOwner}),/hostOwnership differs/);
 assert.equal(PRODUCTION_CUSTODY_VAULT,P.toLowerCase());
});
test('production pins name the production custody vault and the original session factory, never the unused alternates',()=>{
 const prod=validateContractPins(JSON.parse(fs.readFileSync(new URL('../contracts/deployments/contract-pins-production-base.json',import.meta.url),'utf8')));
 assert.equal(prod.secretVaultV2,PRODUCTION_CUSTODY_VAULT);
 assert.equal(REVIEWED_CUSTODY_VAULTS[prod.secretVaultV2].production,true);
 assert.equal(prod.sessionVaultFactory,'0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c','the ORIGINAL production session factory is kept, never zeroed and never the alternate factory');
 const optional=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/contract-pins-base.json',import.meta.url),'utf8'));
 for(const k of ['registry','deployments','appCatalog','proofOfTime','enclavePay','verificationFees'])assert.equal(prod[k],optional.contracts[k].toLowerCase(),k+' is shared with the optional profile pins');
 assert.equal(optional.contracts.secretVaultV2.toLowerCase(),'0x56b81b3970a8ac2c52f9874bd2758ede30758228','the optional profile export stays as reviewed');
});
