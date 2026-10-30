// PREPARED ONLY. Read-only RPC; run only after coordinator reviews this exact package.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {QuorumChain, validateRpcOrigins} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {parseAbi, getContractAddress, decodeEventLog, keccak256, encodeAbiParameters, toHex} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {sessionVaultAbi, sessionVaultFactoryAbi, ACTIONS} from '/home/steven/Documents/Codex/2026-10-23/it/work/wallet-release-ui-r1-20261029/readonly-reference/sessions.live.js';

const dir=fileURLToPath(new URL('.',import.meta.url));
if(process.argv.length!==3 || process.argv[2]!=='--execute-reviewed-read') throw Error('explicit --execute-reviewed-read required; preparation is not execution');
const sha=b=>createHash('sha256').update(b).digest('hex');
const pins=JSON.parse(fs.readFileSync(dir+'INPUT-PINS.json'));
for(const [f,h] of Object.entries(pins)) if(sha(fs.readFileSync(f))!==h) throw Error('pinned input drift: '+f);
const cfg=JSON.parse(fs.readFileSync(dir+'config.json'));
const fd=fs.openSync(dir+'attempt.json','wx',0o600);
fs.writeFileSync(fd,JSON.stringify({startedAt:new Date().toISOString(),pid:process.pid,readOnly:true})+'\n');fs.closeSync(fd);
const lower=a=>String(a).toLowerCase(), zero='0x'+'0'.repeat(40), empty=c=>!c||c==='0x';
const addressWord=a=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');
const deadline=Date.now()+cfg.bounds.wallSeconds*1000, counts=new Map();
const assert=(v,m)=>{if(!v)throw Error(m);};
const abi=parseAbi(['event DelegateSet(address indexed owner,address indexed delegate,bool allowed)',
 'event VaultCreated(address indexed owner,address vault)',
 'event SessionOpened(bytes32 indexed sid,bytes32 indexed keyHash,uint64 expiresAt,uint256 actions,uint8 envs,uint256 budget6,string label)',
 'function deploymentsSchema() view returns(uint256)','function epoch() view returns(uint64)',
 'function factory() view returns(address)','function owner() view returns(address)','function book() view returns(address)',
 'function addr(bytes32) view returns(address)','function implementation() view returns(address)']);
const topics={DelegateSet:keccak256(new TextEncoder().encode('DelegateSet(address,address,bool)')),
 VaultCreated:keccak256(new TextEncoder().encode('VaultCreated(address,address)')),
 SessionOpened:keccak256(new TextEncoder().encode('SessionOpened(bytes32,bytes32,uint64,uint256,uint8,uint256,string)'))};
function bounded(c){
 const key=c.transport?.url||String(counts.size);let n=0,next=0,tail=Promise.resolve();counts.set(key,0);
 return new Proxy(c,{get(target,k){const value=target[k];if(typeof value!=='function')return value;return async(...args)=>{
  const reserve=tail.then(async()=>{const delay=next-Date.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));next=Date.now()+750;});tail=reserve.catch(()=>{});await reserve;
  assert(Date.now()<deadline,'wall-time bound reached');assert(++n<=cfg.bounds.rpcCallsPerPeerPhase,'RPC call bound reached');counts.set(key,n);try{return await value.apply(target,args);}catch(e){throw new Error(String(k)+': '+String(e.details||e.shortMessage||e.message).slice(0,700));}
 };}});
}
const r=(c,address,functionName,args=[],blockNumber, a=abi)=>c.readContract({address,abi:a,functionName,args,blockNumber});
async function code(c,address,b,want){const v=await c.getCode({address,blockNumber:b});if(want)assert(!empty(v)&&keccak256(v)===want,'code mismatch '+address);return v;}
const normalizeLog=x=>({address:lower(x.address),topics:x.topics.map(lower),data:lower(x.data),blockNumber:BigInt(x.blockNumber),blockHash:lower(x.blockHash),transactionHash:lower(x.transactionHash),transactionIndex:BigInt(x.transactionIndex),logIndex:BigInt(x.logIndex)});
async function scan(c,address,event,extraTopics,from,to){
 if(from>to)return {logs:[],ranges:[]};
 const step=BigInt(cfg.bounds.blocksPerRange),size=(to-from+step)/step;
 assert(size<=BigInt(cfg.bounds.rangesPerStream),'history range bound exceeded; incomplete '+event);
 const logs=[],ranges=[];let seen=new Set();
 for(let lo=from;lo<=to;lo+=step){const hi=lo+step-1n>to?to:lo+step-1n;
  const raw=await c.request({method:'eth_getLogs',params:[{address,topics:[topics[event],...extraTopics],fromBlock:toHex(lo),toBlock:toHex(hi)}]});
  assert(Array.isArray(raw)&&raw.length<cfg.bounds.logsPerResponse,'invalid/potentially truncated logs');
  ranges.push({from:lo,to:hi,count:raw.length});
  for(const a of raw){assert(!a.removed,'removed log');const x=normalizeLog(a);
   assert(x.address===lower(address)&&x.topics[0]===topics[event]&&x.blockNumber>=lo&&x.blockNumber<=hi,'log outside requested identity/range');
   // Local topic validation: do not trust a provider to honor the owner filter.
   extraTopics.forEach((t,i)=>assert(t===null||(Array.isArray(t)?t.map(lower).includes(x.topics[i+1]):lower(t)===x.topics[i+1]),'log topic filter mismatch'));
   const key=x.blockHash+':'+x.logIndex;assert(!seen.has(key),'duplicate log');seen.add(key);logs.push(x);
   assert(logs.length<=cfg.bounds.eventsPerStream,'event count bound reached');
  }
 }
 logs.sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.logIndex<b.logIndex?-1:a.logIndex>b.logIndex?1:0);
 return {logs,ranges};
}
const decode=(event,x)=>decodeEventLog({abi,eventName:event,data:x.data,topics:x.topics,strict:true}).args;
async function ledgerBirth(c,b){
 // Verified immutable runtime at an artifact's historical review block; find creation, then REQUIRE actual creation receipt.
 let lo=0n,hi=BigInt(cfg.ledger.firstVerifiedBlock);assert(hi<=b,'verification block is in future');
 assert(empty(await code(c,cfg.ledger.address,lo)),'ledger exists at genesis; unsupported history');
 await code(c,cfg.ledger.address,hi,cfg.ledger.codeHash);
 for(let i=0;hi-lo>1n;i++){assert(i<cfg.bounds.birthSearchSteps,'birth search bound');const mid=(lo+hi)/2n,v=await code(c,cfg.ledger.address,mid);if(empty(v))lo=mid;else {assert(keccak256(v)===cfg.ledger.codeHash,'historical runtime mismatch');hi=mid;}}
 assert(empty(await code(c,cfg.ledger.address,hi-1n)),'precreation code exists');await code(c,cfg.ledger.address,hi,cfg.ledger.codeHash);
 const block=await c.getBlock({blockNumber:hi,includeTransactions:true});
 assert(block.transactions.length<=cfg.bounds.transactionsAtBirth,'birth block too large for reviewed search');
 const creations=block.transactions.filter(t=>t&&typeof t==='object'&&t.to===null);
 assert(creations.length<=cfg.bounds.creationReceipts,'too many creation candidates');const matches=[];
 for(const tx of creations){const rc=await c.getTransactionReceipt({hash:tx.hash});if(lower(rc.contractAddress)===cfg.ledger.address){
  assert(rc.status==='success'&&rc.blockHash===block.hash&&rc.blockNumber===hi,'creation receipt mismatch');matches.push({txHash:tx.hash,blockHash:block.hash});}}
 assert(matches.length===1,'no unique direct creation receipt; internal creation requires separate artifact, never guess lower bound');
 return {block:hi,...matches[0],method:'verified runtime bracket + adjacent getCode + exact successful direct-creation receipt',assumption:'canonical creation receipt and RPC history; not receipt-trie proof'};
}
async function identity(c,b){
 await code(c,cfg.ledger.address,b,cfg.ledger.codeHash);assert(await r(c,cfg.ledger.address,'deploymentsSchema',[],b)===16n,'wrong ledger schema');
 for(const f of cfg.factories){await code(c,f.address,b,f.codeHash);
  if(f.supported){await code(c,f.implementation,b,f.implementationCodeHash);await code(c,f.library,b,f.libraryCodeHash);
   assert(lower(await r(c,f.address,'implementation',[],b))===f.implementation,'factory implementation mismatch');}}
}
function replayDelegates(logs){const m=new Map();for(const log of logs){const a=decode('DelegateSet',log),key=lower(a.owner)+':'+lower(a.delegate);m.set(key,{owner:lower(a.owner),delegate:lower(a.delegate),allowed:a.allowed,lastEvent:log});}
 assert(m.size<=cfg.bounds.delegates,'delegate bound');return [...m.values()].sort((a,b)=>(a.owner+a.delegate).localeCompare(b.owner+b.delegate));}
function slot(owner,delegate){const x=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[owner,23n]));return keccak256(encodeAbiParameters([{type:'address'},{type:'bytes32'}],[delegate,x]));}
async function verifyDelegates(c,b,rows){for(const x of rows){const word=await c.getStorageAt({address:cfg.ledger.address,slot:slot(x.owner,x.delegate),blockNumber:b});assert(word!==undefined&&word!==null,'delegate storage unavailable');const n=BigInt(word);assert(n===0n||n===1n,'nonboolean delegate word');assert((n===1n)===x.allowed,'event replay/current delegate mapping disagree');x.mappingAllowed=n===1n;}return rows;}
async function classify(c,b,address){
 const raw=await code(c,address,b);const result={address,codeHash:empty(raw)?null:keccak256(raw),codeBytes:empty(raw)?0:(raw.length-2)/2,classification:'unknown-delegate',supported:false};
 for(const f of cfg.factories){const known=await r(c,f.address,'isVault',[address],b,sessionVaultFactoryAbi);if(!known)continue;
  result.recognizedFactory=f.address;
  if(!f.supported){result.classification='recognized-history-factory-but-implementation-unqualified';return result;}
  const [owner,factory,book,derived]=await Promise.all([r(c,address,'owner',[],b),r(c,address,'factory',[],b),r(c,address,'book',[],b),r(c,f.address,'vaultFor',[cfg.wallet],b,sessionVaultFactoryAbi)]);
  const clone='0x363d3d373d3d3d363d73'+f.implementation.slice(2)+'5af43d82803e903d91602b57fd5bf3';
  assert(lower(raw)===clone&&lower(factory)===f.address&&lower(book)===cfg.book,'recognized clone identity mismatch');
  if(lower(owner)!==cfg.wallet||lower(derived)!==address){result.classification='recognized-vault-other-owner';result.controllingOwner=lower(owner);return result;}
  const resolved=await r(c,cfg.book,'addr',[toHex('deployments',{size:32})],b);assert(lower(resolved)===cfg.ledger.address,'book ledger mismatch');
  return {...result,supported:true,classification:'source-verified-wallet-vault',factory:f.address,owner:lower(owner),book:lower(book),implementation:f.implementation};
 }
 if(empty(raw))result.classification='non-vault-EOA-delegate-authority-unknown';
 return result;
}
async function vaultBirth(c,b,v){
 const f=cfg.factories.find(f=>f.address===v.factory),start=BigInt(f.creationBlock);
 assert(empty(await code(c,f.address,start-1n)),'factory precreation mismatch');await code(c,f.address,start,f.codeHash);
 let lo=start-1n,hi=b;assert(empty(await code(c,v.address,lo)),'vault pre-factory code exists');await code(c,v.address,hi,v.codeHash);
 for(let i=0;hi-lo>1n;i++){assert(i<cfg.bounds.birthSearchSteps,'vault birth search bound');const mid=(lo+hi)/2n,raw=await code(c,v.address,mid);if(empty(raw))lo=mid;else{assert(keccak256(raw)===v.codeHash,'vault historical code mismatch');hi=mid;}}
 const birth=hi;assert(empty(await code(c,v.address,birth-1n)),'vault precreation boundary mismatch');await code(c,v.address,birth,v.codeHash);
 const scanned=await scan(c,f.address,'VaultCreated',[addressWord(cfg.wallet)],birth,birth);
 const hits=scanned.logs.filter(x=>lower(decode('VaultCreated',x).vault)===v.address);assert(hits.length===1,'missing/duplicate exact birth event');
 const event=hits[0],rc=await c.getTransactionReceipt({hash:event.transactionHash});
 assert(rc.status==='success'&&lower(rc.blockHash)===event.blockHash&&rc.blockNumber===birth,'vault creation receipt mismatch');
 assert(rc.logs.some(x=>lower(x.address)===f.address&&Number(x.logIndex)===Number(event.logIndex)&&lower(x.data)===event.data&&JSON.stringify(x.topics.map(lower))===JSON.stringify(event.topics)),'vault event absent from receipt');
 return {block:birth,event,factoryCreationBlock:start,method:'two-provider runtime boundary + exact one-block VaultCreated event and successful receipt'};
}
async function checkBirthWitness(c,w){
 const block=await c.getBlock({blockNumber:w.block});const hash=w.blockHash||w.event.blockHash;
 assert(lower(block.hash)===lower(hash),'birth witness canonical block changed');
 const rc=await c.getTransactionReceipt({hash:w.txHash||w.event.transactionHash});
 assert(rc.status==='success'&&rc.blockNumber===w.block&&lower(rc.blockHash)===lower(hash)&&lower(rc.transactionHash)===lower(w.txHash||w.event.transactionHash),'birth witness receipt changed');assert(block.transactions.map(x=>typeof x==='string'?lower(x):lower(x.hash)).includes(lower(rc.transactionHash)),'creation transaction absent from birth block');
 if(w.event)assert(rc.logs.some(x=>lower(x.address)===w.event.address&&Number(x.logIndex)===Number(w.event.logIndex)&&lower(x.data)===w.event.data&&JSON.stringify(x.topics.map(lower))===JSON.stringify(w.event.topics)),'birth event changed');
 else assert(lower(rc.contractAddress)===cfg.ledger.address,'ledger birth contract changed');
}
async function grants(c,b,v,logs){
 const epoch=await r(c,v.address,'epoch',[],b),ids=new Map();
 for(const e of logs){const a=decode('SessionOpened',e);assert(!ids.has(lower(a.sid)),'duplicate SessionOpened sid');ids.set(lower(a.sid),{a,e});}
 assert(ids.size<=cfg.bounds.sessionsPerVault,'session count bound');const rows=[];
 const block=await c.getBlock({blockNumber:b});
 for(const [sid,{a,e}] of ids){const [s,live,apps]=await r(c,v.address,'sessionOf',[sid],b,sessionVaultAbi);
  assert(lower(s.keyHash)===lower(a.keyHash)&&s.actions===a.actions&&s.envs===a.envs,'session event/state identity mismatch');
  assert(apps.length<=8,'app scope bound');const expectedLive=Number(s.state)===1&&s.epoch===epoch&&block.timestamp<=s.expiresAt;
  assert(live===expectedLive,'live predicate mismatch');
  const actions=Object.entries(ACTIONS).filter(([,bit])=>(s.actions&(1n<<BigInt(bit)))!==0n).map(([name])=>name);
  let known=0n;for(const bit of Object.values(ACTIONS))known|=1n<<BigInt(bit);
  rows.push({sid,openedAt:{block:e.blockNumber,txHash:e.transactionHash},live,vaultEpoch:epoch,session:s,apps,actionNames:actions,unknownActionBits:s.actions&~known,
   enforcement:'Exact current source map in POLICY-EVIDENCE.md; apps array is NOT uniformly enforced for existing-record operations or host refusal.'});
 }
 return rows;
}
const out={readOnly:true,kind:'wallet-session-current-after-independent-history/1'};
try {
const h=JSON.parse(fs.readFileSync(dir+'../wallet-session-history-independent-r7/api-history.json'),(k,v)=>['block','blockNumber','transactionIndex','logIndex','factoryCreationBlock'].includes(k)&&typeof v==='string'&&/^[0-9]+$/.test(v)?BigInt(v):v);
const cross=JSON.parse(fs.readFileSync(dir+'../wallet-session-history-independent-r7/result.json'));assert(cross.complete===true,'independent full history not complete');assert(BigInt(cross.anchor)===h.block,'history anchor mismatch');
const q=new QuorumChain({rpcs:validateRpcOrigins(cfg.rpcs),quorum:2,timeoutMs:10000,maxBlockAgeMs:120000});
out.history={blockNumber:h.block,blockHash:cross.blockHash,value:h.value};
 out.current=await q.snapshot(async(client,b)=>{const c=bounded(client);await identity(c,b);
  assert(lower((await c.getBlock({blockNumber:out.history.blockNumber})).hash)===lower(out.history.blockHash),'history anchor reorged');
  const tail=await scan(c,cfg.ledger.address,'DelegateSet',[[addressWord(cfg.wallet),addressWord(cfg.sourceVault)]],out.history.blockNumber+1n,b);
  const delegateRows=await verifyDelegates(c,b,replayDelegates([...out.history.value.delegateHistory.logs,...tail.logs]));
  const targets=[...new Set([cfg.sourceVault,...delegateRows.filter(x=>x.owner===cfg.wallet&&x.allowed).map(x=>x.delegate)])].sort(),classifications=[];
  for(const a of targets)classifications.push(await classify(c,b,a));
  const vaults=[],incomplete=[];
  for(const cl of classifications){if(!cl.supported){incomplete.push({address:cl.address,reason:cl.classification});continue;}
   const old=out.history.value.vaults.find(v=>v.address===cl.address);if(!old){incomplete.push({address:cl.address,reason:'new supported delegate since history anchor; full SessionOpened scan required'});continue;}
   const tail=await scan(c,cl.address,'SessionOpened',[],out.history.blockNumber+1n,b);
   vaults.push({...cl,birth:old.birth,historyRanges:old.sessionHistory.ranges,tailRanges:tail.ranges,sessions:await grants(c,b,cl,[...old.sessionHistory.logs,...tail.logs])});
  }
  for(const d of delegateRows.filter(x=>x.owner===cfg.sourceVault&&x.allowed))incomplete.push({address:d.delegate,reason:'source-vault ledger delegate bypasses held custody; explicit authority review required'});
  const at=await c.getBlock({blockNumber:b});assert(Date.now()-Number(at.timestamp)*1000<=120000,'final state stale at completion');
  return {delegateRows,classifications,vaults,incomplete,historyCompleteForSupportedVaults:!incomplete.some(x=>x.reason.startsWith('new supported')),authorityCensusQualified:incomplete.length===0,
   missingNonChainEvidence:['installed host/API/relay consumers and in-flight requests','secret backend/content policy/fallback paths','outstanding owner signatures and direct-owner coordination']};
 });
out.completed=true;
} catch(e){out.completed=false;out.error={message:String(e.message).replace(/https?:\/\/[^\s)]+/g,'[RPC]')};}
out.finishedAt=new Date().toISOString();fs.writeFileSync(dir+'result.json',JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({completed:out.completed,block:out.current?.blockNumber?.toString(),error:out.error}));
