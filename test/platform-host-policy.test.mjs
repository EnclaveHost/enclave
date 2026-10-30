// Platform host policy: format, two-key 32-byte book anchor, quorum snapshot, loader, persistence and judgement.
// The chain is three fake RPC clients behind the REAL custody quorum reader (custody/v2/quorum.mjs), so minority
// poisoning is exercised against the production agreement rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {encodeFunctionData,decodeFunctionData,encodeFunctionResult,keccak256} from 'viem';
import {createQuorumReader} from '../custody/v2/quorum.mjs';
import {validatePolicy,policyTypedData,policyDigest,verifySignedPolicy,encodeAnchor,decodeAnchor,anchorTransaction,ANCHOR_KEYS,
        createPlatformHostGate,judgeHost,policyStatus,POLICY_FORMAT,PLATFORM_POLICY_OFF} from '../network/platform-host-policy.mjs';

const book='0xab214342d5a490150a4a977063a2f88e21f80907',registry='0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',own='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7';
const Z32='0x'+'00'.repeat(32),ZA='0x'+'00'.repeat(20);
const admin=privateKeyToAccount(generatePrivateKey()),next=privateKeyToAccount(generatePrivateKey()),mallory=privateKeyToAccount(generatePrivateKey());
const H={bad:'0x'+'4d'.repeat(32),good:'0x'+'11'.repeat(32),fresh:'0x'+'12'.repeat(32)};
const OP={bad:'0x'+'c9'.repeat(20),good:'0x'+'22'.repeat(20),fresh:'0x'+'23'.repeat(20)};
const NOW=2_000_000_000;
const doc=(o={})=>({format:POLICY_FORMAT,chainId:8453,book,registry,hostOwnership:own,sequence:1,issuedAt:NOW-100,expiresAt:NOW+86400,maxStaleSec:3*86400,
  previousDigest:Z32,mode:'denylist',deny:[{kind:'operator',value:OP.bad,reason:'malware distribution'}],admit:[],...o});
const sign=async(acct,p)=>({document:JSON.stringify(p),signature:await acct.signTypedData(policyTypedData(p))});

// ---- fake chain: state shared by honest RPCs; a poisoned RPC overrides some reads ----
const ABI=[
 {type:'function',name:'owner',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
 {type:'function',name:'addr',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'}]},
 {type:'function',name:'authority',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'},{type:'address'},{type:'uint64'},{type:'bytes32'}]},
 {type:'function',name:'isValidSignature',stateMutability:'view',inputs:[{type:'bytes32'},{type:'bytes'}],outputs:[{type:'bytes4'}]},
 {type:'function',name:'get',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:[{name:'endpoint',type:'string'},{name:'repo',type:'string'},
   {name:'measurement',type:'bytes32'},{name:'operator',type:'address'},{name:'registeredAt',type:'uint64'},{name:'lastSeen',type:'uint64'},{name:'active',type:'bool'}]}]}];
function chainState(){return {owner:admin.address.toLowerCase(),ownerCode:'0x',valid1271:new Set(),hi:ZA,lo:ZA,blockTimestamp:BigInt(Math.floor(Date.now()/1000)),
 hosts:{[H.bad]:{operator:OP.bad,owner:'0x'+'aa'.repeat(20)},[H.good]:{operator:OP.good,owner:'0x'+'bb'.repeat(20)},[H.fresh]:{operator:OP.fresh,owner:'0x'+'cc'.repeat(20)}}};}
function client(state,poison={}){
 const s=()=>({...state,...poison});
 // A fixed block hash must keep the same timestamp across reads and clients.
 return {getBlockNumber:async()=>10n,getBlock:async({blockNumber})=>({number:blockNumber,hash:'0x'+'ab'.repeat(32),timestamp:state.blockTimestamp}),
  async request({method,params}){
   const st=s();
   if(method==='eth_getCode')return params[0].toLowerCase()===st.owner?st.ownerCode:'0x';
   const {to,data}=params[0];const {functionName,args}=decodeFunctionData({abi:ABI,data});const T=to.toLowerCase();
   let r;
   if(T===book&&functionName==='owner')r=st.owner;
   else if(T===book&&functionName==='addr')r=args[0]===ANCHOR_KEYS.hi?st.hi:args[0]===ANCHOR_KEYS.lo?st.lo:registry;
   else if(T===registry&&functionName==='get'){const h=st.hosts[args[0]];r={endpoint:'https://'+args[0].slice(2,8)+'.host',repo:'',measurement:Z32,operator:h?.operator||ZA,registeredAt:1n,lastSeen:1n,active:!!h};}
   else if(T===own&&functionName==='authority'){const h=st.hosts[args[0]];r=[h?.owner||ZA,ZA,1n,Z32];}
   else if(T===st.owner&&functionName==='isValidSignature')r=st.valid1271.has(args[0]+':'+args[1])?'0x1626ba7e':'0xffffffff';
   else throw Error('unexpected '+T+' '+functionName);
   return encodeFunctionResult({abi:ABI,functionName,result:r});
  }};
}
function rig(state,{poison=null,mirrors=[],store=null,allowUnanchored=false,now=()=>NOW*1000}={}){
 const clients=[client(state),client(state),client(state,poison||{})];
 const agreed=createQuorumReader({clients,minAgree:2,maxAgeSec:120});
 const snapshot=(fn)=>agreed(async(c,b)=>fn({block:b.blockNumber,
   call:async(address,abi,functionName,args=[])=>{const d=encodeFunctionData({abi,functionName,args});const res=await c.request({method:'eth_call',params:[{to:address,data:d},{blockHash:b.blockHash}]});
     const {decodeFunctionResult}=await import('viem');return decodeFunctionResult({abi,functionName,data:res});},
   code:(a)=>c.request({method:'eth_getCode',params:[a,{blockHash:b.blockHash}]})}));
 return createPlatformHostGate({book,hostOwnership:own,snapshot,mirrors,store,allowUnanchored,now});
}
const mirror=(...signed)=>async(digest)=>signed.filter((x)=>!digest||policyDigest(JSON.parse(x.document))===digest);
const anchorTo=(state,p)=>{const a=encodeAnchor(policyDigest(p));state.hi=a.hi;state.lo=a.lo;};

test('anchor: full 32 bytes in two padded halves; torn, malformed and unpadded values refused; exact unsigned setMany',()=>{
 const d=policyDigest(doc()),a=encodeAnchor(d);
 assert.match(a.hi,/^0x00000000[0-9a-f]{32}$/);assert.deepEqual(decodeAnchor(a.hi,a.lo),{state:'anchored',digest:d});
 assert.deepEqual(decodeAnchor(ZA,ZA),{state:'unanchored'});
 assert.throws(()=>decodeAnchor(a.hi,ZA),/torn/);assert.throws(()=>decodeAnchor(ZA,a.lo),/torn/);
 assert.throws(()=>decodeAnchor('0x01'+a.hi.slice(4),a.lo),/left-padded/);
 assert.throws(()=>decodeAnchor('0x1234',a.lo),/addresses/);
 const tx=anchorTransaction(book,d);
 assert.equal(tx.to,book);assert.match(tx.data,/^0x[0-9a-f]+$/);
 const {functionName,args}=decodeFunctionData({abi:[{type:'function',name:'setMany',inputs:[{type:'bytes32[]'},{type:'address[]'}],outputs:[],stateMutability:'nonpayable'}],data:tx.data});
 assert.equal(functionName,'setMany');assert.deepEqual(args[0],[ANCHOR_KEYS.hi,ANCHOR_KEYS.lo]);assert.deepEqual(args[1].map((x)=>x.toLowerCase()),[a.hi,a.lo]);
});
test('format binds book, registry and ownership extension; strict bounds',()=>{
 assert.throws(()=>validatePolicy({...doc(),extra:1}),/exact fields/);
 assert.throws(()=>validatePolicy(doc({expiresAt:NOW+31*86400})),/validity/);
 assert.throws(()=>validatePolicy(doc({admit:[{kind:'operator',value:OP.good}]})),/admits nothing/);
 assert.throws(()=>validatePolicy(doc({deny:[{kind:'owner',value:'0xABC',reason:''}]})),/entry/);
 assert.notEqual(policyDigest(doc()),policyDigest(doc({registry:'0x'+'99'.repeat(20)})),'the registry binding is signed');
});
test('anchored loader: exact digest only; a withheld newer policy cannot be replaced by an older signed one; missing mirror fails closed',async()=>{
 const st=chainState(),p1=doc(),p2=doc({sequence:2,previousDigest:policyDigest(p1),deny:[...p1.deny,{kind:'registryId',value:H.fresh,reason:'abuse'}]});
 const s1=await sign(admin,p1),s2=await sign(admin,p2);
 anchorTo(st,p2);
 await assert.rejects(rig(st,{mirrors:[mirror(s1)]}).refresh(),{code:'anchor_unavailable'},'cold client offered only the older policy');
 await assert.rejects(rig(st,{mirrors:[]}).refresh(),{code:'anchor_unavailable'},'no mirror');
 const g=rig(st,{mirrors:[async()=>{throw Error('down');},mirror(s1,s2)]});
 assert.equal((await g.refresh()).policy.sequence,2,'one reachable honest mirror suffices');
 st.hi=encodeAnchor(policyDigest(p2)).hi;st.lo=ZA;
 await assert.rejects(rig(st,{mirrors:[mirror(s2)]}).refresh(),{code:'torn_anchor'});
});
test('minority RPC poisoning cannot change the anchor, the owner or a host fact; a poisoned majority-free read does not count',async()=>{
 const st=chainState(),p1=doc(),s1=await sign(admin,p1);anchorTo(st,p1);
 const poison={hi:ZA,lo:ZA,owner:mallory.address.toLowerCase(),hosts:{...st.hosts,[H.bad]:{operator:OP.good,owner:'0x'+'bb'.repeat(20)}}};
 const g=rig(st,{poison,mirrors:[mirror(s1)]});
 assert.equal((await g.refresh()).digest,policyDigest(p1));
 const d=await g.decide({registryIds:[H.bad,H.good]});
 assert.equal(d.decisions[H.bad].admit,false);assert.match(d.decisions[H.bad].reason,/banned by platform policy #1 \(operator\)/);
 assert.equal(d.decisions[H.good].admit,true);
});
test('book owner rotation: the former owner\'s signature stops verifying; an ERC-1271 owner answers at the snapshot block',async()=>{
 const st=chainState(),p1=doc();anchorTo(st,p1);
 const old=await sign(admin,p1);
 st.owner=next.address.toLowerCase();
 await assert.rejects(rig(st,{mirrors:[mirror(old)]}).refresh(),{code:'anchor_unavailable'},'signed by the previous owner: not acceptable');
 assert.equal((await rig(st,{mirrors:[mirror(await sign(next,p1))]}).refresh()).policy.sequence,1);
 const safe='0x'+'5a'.repeat(20);st.owner=safe;st.ownerCode='0x6080';
 const unsigned={document:JSON.stringify(p1),signature:'0x1234'};
 await assert.rejects(rig(st,{mirrors:[mirror(unsigned)]}).refresh(),{code:'anchor_unavailable'},'the contract owner has not approved this digest');
 st.valid1271.add(policyDigest(p1)+':0x1234');
 assert.equal((await rig(st,{mirrors:[mirror(unsigned)]}).refresh()).digest,policyDigest(p1));
});
test('persistence: a tampered record is discarded and reported; a persisted newer policy refuses an anchored rollback',async()=>{
 const st=chainState(),p1=doc(),p2=doc({sequence:2,previousDigest:policyDigest(p1)});
 const s1=await sign(admin,p1),s2=await sign(admin,p2);
 let saved=null;const store={load:()=>saved,save:(x)=>{saved=x;}};
 anchorTo(st,p2);await rig(st,{mirrors:[mirror(s2)],store}).refresh();
 assert.equal(JSON.parse(saved).sequence,2);
 anchorTo(st,p1);
 await assert.rejects(rig(st,{mirrors:[mirror(s1,s2)],store}).refresh(),{code:'rollback'},'the book cannot silently roll a node back below its persisted policy');
 const t=JSON.parse(saved);t.document=JSON.stringify({...p2,deny:[]});saved=JSON.stringify(t);
 anchorTo(st,p2);
 const g=rig(st,{mirrors:[mirror(s2)],store});
 assert.equal((await g.refresh()).digest,policyDigest(p2),'the anchor and mirrors recover the real policy');
 assert.match(g.problems()[0],/persisted policy discarded/);
 assert.equal(JSON.parse(saved).document,s2.document,'the repaired record is persisted');
});
test('decisions use the ACCEPTED owner and operator at the agreed block, deny overrides admit, and a node behind the anchor refuses',async()=>{
 const st=chainState(),p=doc({mode:'allowlist',admit:[{kind:'owner',value:'0x'+'bb'.repeat(20)},{kind:'operator',value:OP.bad}],
   deny:[{kind:'owner',value:'0x'+'aa'.repeat(20),reason:'fraud'}]});
 anchorTo(st,p);const g=rig(st,{mirrors:[mirror(await sign(admin,p))]});await g.refresh();
 let d=await g.decide({registryIds:[H.bad,H.good,H.fresh,'0x'+'77'.repeat(32)]});
 assert.equal(d.decisions[H.bad].admit,false,'operator admitted but its accepted owner is denied: deny wins');
 assert.equal(d.decisions[H.good].admit,true,'admitted by its accepted owner');
 assert.match(d.decisions[H.fresh].reason,/not admitted by platform allowlist/);
 assert.equal(d.decisions['0x'+'77'.repeat(32)].admit,false,'unregistered host');
 st.hosts[H.good].owner='0x'+'aa'.repeat(20);           // ownership moves to the denied wallet
 d=await g.decide({registryIds:[H.good]});
 assert.equal(d.decisions[H.good].admit,false,'the owner at THIS block decides, not a cached one');
 const p2=doc({sequence:2,previousDigest:policyDigest(p)});anchorTo(st,p2);
 d=await g.decide({registryIds:[H.good]});assert.match(d.decisions[H.good].reason,/has not loaded the policy the book anchors/);
});
test('expiry never lifts a ban; stale refuses new hosts; unanchored operation is refused unless explicitly allowed; OFF is explicit',async()=>{
 const p=doc(),bad={operator:OP.bad},good={operator:OP.good};
 assert.equal(policyStatus(p,NOW),'current');assert.equal(policyStatus(p,NOW+86400+10),'stale-grace');assert.equal(policyStatus(p,NOW+5*86400),'stale');
 for(const t of [NOW,NOW+86400+10,NOW+10**8])assert.equal(judgeHost(p,bad,t,{previouslyAdmitted:true}).admit,false);
 assert.equal(judgeHost(p,good,NOW+5*86400).admit,false);assert.equal(judgeHost(p,good,NOW+5*86400,{previouslyAdmitted:true}).admit,true);
 const st=chainState();
 await assert.rejects(rig(st,{mirrors:[mirror(await sign(admin,p))]}).refresh(),{code:'unanchored'});
 assert.equal((await rig(st,{mirrors:[mirror(await sign(admin,p))],allowUnanchored:true}).refresh()).policy.sequence,1);
 assert.equal(PLATFORM_POLICY_OFF.decideHost({}).status,'off');
 void keccak256;
});

// ---- the shared runtime constructor (relay / supervisor / CLI / Windows) over the same quorum and an HTTP mirror ----
import {createHostPolicyRuntime,parseHostPolicyConfig} from '../network/host-policy-runtime.mjs';
test('runtime: absent config is OFF, malformed config throws, a configured runtime enforces through HTTPS mirrors',async()=>{
 assert.equal(parseHostPolicyConfig(undefined),null);assert.equal(parseHostPolicyConfig(''),null);
 assert.throws(()=>parseHostPolicyConfig('{"book":"0x1"}'),/nonzero address|book and hostOwnership|mirrors|config/);
 assert.throws(()=>parseHostPolicyConfig({book,hostOwnership:own,mirrors:['http://plain.example']}),/HTTPS/);
 const st=chainState(),p=doc(),s=await sign(admin,p);anchorTo(st,p);
 const served=[];
 const fetch=async(u)=>{served.push(u);const d=policyDigest(p);return u.endsWith('/'+d+'.json')?new Response(JSON.stringify(s)):new Response(null,{status:404});};
 const rt=createHostPolicyRuntime({book,hostOwnership:own,mirrors:['https://mirror-a.example/policy','https://mirror-b.example']},
   {clients:[client(st),client(st),client(st,{hi:ZA,lo:ZA})],minAgree:2,fetch});
 const d=await rt.admissions([H.bad,H.good]);
 assert.equal(d[H.bad].admit,false);assert.equal(d[H.good].admit,true);
 assert.ok(served[0].startsWith('https://mirror-a.example/policy/0x'),'content-addressed by the anchored digest');
 const m=await rt.measured(H.bad).check();assert.deepEqual([m.serving,m.banned],[false,true]);
});

test('anchored NON-EXPIRING mode: no renewal schedule; the fresh anchor alone keeps it current, revokes it and replaces it',async()=>{
 const st=chainState(),p=doc({expiresAt:0,maxStaleSec:0}),s=await sign(admin,p);
 assert.throws(()=>validatePolicy(doc({expiresAt:0,maxStaleSec:60})),/maxStaleSec 0/);
 anchorTo(st,p);
 const far=()=>(NOW+10*365*86400)*1000;                       // ten years later, never re-signed
 const g=rig(st,{mirrors:[mirror(s)],now:far});await g.refresh();
 let d=await g.decide({registryIds:[H.bad,H.good]});
 assert.equal(d.decisions[H.good].admit,true);assert.equal(d.decisions[H.good].status,'current');assert.equal(d.decisions[H.bad].admit,false);
 // revocation / replacement only by the anchor: a new anchored policy unbans; until this node loads it, it refuses
 const p2=doc({sequence:2,expiresAt:0,maxStaleSec:0,deny:[]});anchorTo(st,p2);
 d=await g.decide({registryIds:[H.bad]});assert.equal(d.decisions[H.bad].status,'behind');
 await assert.rejects(g.refresh(),{code:'anchor_unavailable'},'not mirrored yet: refuse rather than keep the replaced policy');
 const g2=rig(st,{mirrors:[mirror(s,await sign(admin,p2))],now:far});await g2.refresh();
 assert.equal((await g2.decide({registryIds:[H.bad]})).decisions[H.bad].admit,true);
 // an anchored-only document is never used unanchored, even by an explicitly unanchored gate
 st.hi=ZA;st.lo=ZA;
 await assert.rejects(rig(st,{mirrors:[mirror(s)],allowUnanchored:true,now:far}).refresh(),{code:'policy_unavailable'});
 assert.match((await g2.decide({registryIds:[H.good]})).decisions[H.good].reason,/valid only while anchored|no platform host policy is anchored/);
 // owner rotation still invalidates it; a TIME-LIMITED anchored policy still expires
 anchorTo(st,p);st.owner=next.address.toLowerCase();
 await assert.rejects(rig(st,{mirrors:[mirror(s)],now:far}).refresh(),{code:'anchor_unavailable'});
 st.owner=admin.address.toLowerCase();const tl=doc({sequence:3});anchorTo(st,tl);
 const g3=rig(st,{mirrors:[mirror(await sign(admin,tl))],now:far});await g3.refresh();
 const x=await g3.decide({registryIds:[H.good]});assert.deepEqual([x.decisions[H.good].admit,x.decisions[H.good].status],[false,'stale']);
});

test('core v2: current-owner authority is re-checked at EVERY decision block; rotation or ERC-1271 withdrawal stops admission; re-signing the same document restores it',async()=>{
 const st=chainState(),p=doc({expiresAt:0,maxStaleSec:0,deny:[]}),d=policyDigest(p);anchorTo(st,p);
 const byAdmin=await sign(admin,p);
 const g=rig(st,{mirrors:[mirror(byAdmin)]});await g.refresh();
 assert.equal((await g.decide({registryIds:[H.good]})).decisions[H.good].admit,true);
 st.owner=next.address.toLowerCase();                                   // the book's two-step handoff completed
 let x=(await g.decide({registryIds:[H.good]})).decisions[H.good];
 assert.deepEqual([x.admit,x.status],[false,'authority'],'an anchored policy signed by the FORMER owner no longer admits');
 await assert.rejects(g.refresh(),{code:'authority'},'refresh does not fast-path a digest whose signer is no longer the owner');
 const g2=rig(st,{mirrors:[mirror(byAdmin,await sign(next,p))]});      // the NEW owner re-signs the same document: same digest, no anchor write
 assert.equal((await g2.refresh()).digest,d);
 assert.equal((await g2.decide({registryIds:[H.good]})).decisions[H.good].admit,true);
 // a CONTRACT owner withdraws its ERC-1271 approval without changing the anchor
 const safe='0x'+'5a'.repeat(20);st.owner=safe;st.ownerCode='0x6080';const unsigned={document:JSON.stringify(p),signature:'0x1234'};
 st.valid1271.add(d+':0x1234');
 const g3=rig(st,{mirrors:[mirror(unsigned)]});await g3.refresh();
 assert.equal((await g3.decide({registryIds:[H.good]})).decisions[H.good].admit,true);
 st.valid1271.delete(d+':0x1234');
 x=(await g3.decide({registryIds:[H.good]})).decisions[H.good];
 assert.deepEqual([x.admit,x.status],[false,'authority'],'withdrawn ERC-1271 approval: refused at the next decision block');
 const facts={anchorHi:st.hi,anchorLo:st.lo,hosts:{}};
 assert.equal(g3.decideHost({operator:OP.good},facts).status,'authority-unread','a caller snapshot without the current owner is UNREAD authority (undecided, refused)');
 assert.deepEqual(g3.currentAuthorityChecks(),[{digest:d,signature:'0x1234'}],'callers learn which ERC-1271 question their own snapshot must ask');
});
