// Read-only verification of a new single-seat r2 committee in the ORIGINAL vault.
// expectedMachine must come from a separately verified fresh SNP quote. This module verifies the chain binding,
// not the quote. Raw calldata, authorization signatures and chip identifiers remain in memory, never in results.
import { ORIGINAL_VAULT_V2, OLD_COMMITTEE_4774, OLD_CUSTODIAN_MEASUREMENT_SHA, R2, METAL0_REGISTRY_ID, METAL0_OPERATOR, METAL0_ENDPOINT } from './plan.mjs';
import {BOOK,REVIEWED} from './clipins.mjs';
export const ADMIN = '0x0b2d009c0c9af05b12100d77f3c815fea822ee61';
const H = /^0x[0-9a-f]{64}$/, A = /^0x[0-9a-f]{40}$/;
const lc = x => String(x ?? '').toLowerCase();
const equal = (a,b) => JSON.stringify(a,(_,x)=>typeof x==='bigint'?x.toString():x) === JSON.stringify(b,(_,x)=>typeof x==='bigint'?x.toString():x);
const LOCAL = Symbol('genesis-local-error');
const failure = reason => Object.assign(new Error(`genesis refused: ${reason}`),{[LOCAL]:true});
const requireThat = (ok, reason) => { if (!ok) throw failure(reason); };
const hex = b => typeof b === 'string' ? lc(b) : b instanceof Uint8Array ? '0x'+Buffer.from(b).toString('hex') : null;
const FIELDS = ['identity','encKey','endpoint','chipId','registryId','measurement'];
const machineEqual = (a,b) => !!a && !!b && FIELDS.every(k=>k==='endpoint'?a[k]===b[k]:lc(a[k])===lc(b[k]));
export const EVENTS = [
 {type:'event',name:'CommitteeCreated',inputs:[{name:'committeeId',type:'bytes32',indexed:true},{name:'identity',type:'address',indexed:true},{name:'Y',type:'bytes',indexed:false}]},
 {type:'event',name:'EpochActivated',inputs:[{name:'committeeId',type:'bytes32',indexed:true},{name:'epoch',type:'uint32',indexed:false}]}
];
export function checkHost(facts) {
 const e = facts?.entries?.[METAL0_REGISTRY_ID];
 const ok = !!e && e.active === true && e.endpoint === METAL0_ENDPOINT && lc(e.operator) === METAL0_OPERATOR
  && lc(facts.enclaveOwner) === ADMIN && lc(e.owner) === ADMIN && lc(e.payoutWallet) === ADMIN
  && e.vaultEnclave === true && e.ownerConflict === false;
 return {ok, stepId:'G.host', note:ok?'Agreed accepted owner, operator, payout and active registry entry match the existing administrator.':'Accepted ownership/active registry/operator binding missing or conflicting; payout alone is not ownership.'};
}
export function deriveGenesis({viem,abi,tx,receipt,expectedMachine,endpoint,submitter,txHash}) {
 let origin=null;try{origin=new URL(endpoint);}catch{}
 requireThat(origin && origin.protocol==='https:' && origin.origin===endpoint && !origin.username && !origin.password, 'exact HTTPS custodian origin required');
 requireThat(H.test(lc(txHash)) && A.test(lc(submitter)), 'transaction hash and submitter pins required');
 requireThat(expectedMachine && A.test(lc(expectedMachine.identity)) && !/^0x0{40}$/.test(lc(expectedMachine.identity))
  && ['encKey','chipId','registryId','measurement'].every(k=>H.test(lc(expectedMachine[k])) && !/^0x0{64}$/.test(lc(expectedMachine[k]))), 'verified machine fields required');
 requireThat(expectedMachine.endpoint === endpoint && expectedMachine.registryId === METAL0_REGISTRY_ID
  && expectedMachine.measurement === R2.measurementSha256, 'machine does not name the new r2 endpoint and metal0');
 requireThat(tx && receipt && lc(tx.hash)===lc(txHash) && lc(receipt.transactionHash)===lc(txHash)
  && receipt.status==='success' && lc(tx.to)===ORIGINAL_VAULT_V2 && lc(receipt.to)===ORIGINAL_VAULT_V2
  && lc(tx.from)===lc(submitter) && lc(receipt.from)===lc(submitter) && tx.value===0n && tx.chainId===8453, 'receipt target, status, sender, value or chain differs');
 requireThat(typeof receipt.blockNumber==='bigint' && H.test(lc(receipt.blockHash))
  && tx.blockNumber===receipt.blockNumber && lc(tx.blockHash)===lc(receipt.blockHash), 'transaction inclusion differs from receipt');
 let call;
 try { call=viem.decodeFunctionData({abi,data:tx.input}); } catch { throw failure('cannot decode creation calldata'); }
 requireThat(call.functionName==='createCommittee', 'not createCommittee');
 const [salt,m,Y,codeSet] = call.args;
 requireThat(H.test(lc(salt)) && /^0x0[23][0-9a-f]{64}$/.test(lc(Y)) && machineEqual(m,expectedMachine), 'creation machine differs from the attested machine');
 requireThat(Array.isArray(codeSet) && codeSet.length===1 && lc(codeSet[0])===R2.measurementSha256, 'genesis code set is not exactly r2');
 const cid=viem.keccak256(viem.encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'bytes32'},{type:'bytes32'}],[8453n,ORIGINAL_VAULT_V2,salt,viem.keccak256(Y)]));
 requireThat(cid!==OLD_COMMITTEE_4774, 'old committee cannot be reused');
 const own=receipt.logs.filter(l=>lc(l.address)===ORIGINAL_VAULT_V2);
 requireThat(own.length===2 && own.every(l=>l.removed!==true && lc(l.transactionHash)===lc(txHash)
  && l.blockNumber===receipt.blockNumber && lc(l.blockHash)===lc(receipt.blockHash)), 'creation log inclusion or count differs');
 let events;
 try { events=own.map(l=>viem.decodeEventLog({abi:EVENTS,topics:l.topics,data:l.data,strict:true})); }
 catch { throw failure('creation events malformed'); }
 const created=events.filter(e=>e.eventName==='CommitteeCreated'), activated=events.filter(e=>e.eventName==='EpochActivated');
 requireThat(created.length===1 && activated.length===1 && lc(created[0].args.committeeId)===cid
  && lc(created[0].args.identity)===lc(expectedMachine.identity) && lc(created[0].args.Y)===lc(Y)
  && lc(activated[0].args.committeeId)===cid && Number(activated[0].args.epoch)===1, 'creation events do not bind the derived committee and key');
 return {committeeId:cid,Y:lc(Y)};
}
export function checkActivated({facts,derived,expectedMachine,genesisBlock,nowSec}) {
 requireThat(typeof facts?.blockNumber==='bigint' && facts.blockNumber>=genesisBlock.number && H.test(lc(facts.blockHash))
  && Number.isSafeInteger(facts.blockTimestamp) && facts.blockTimestamp>=nowSec-120 && facts.blockTimestamp<=nowSec+10, 'authorization snapshot is missing, stale or predates creation');
 const c=facts.committee;
 requireThat(c && c.committeeId===derived.committeeId && c.epoch===1 && c.t===1 && c.W===1 && c.machines?.length===1
  && c.machines[0].enclave===true && machineEqual(c.machines[0],expectedMachine)
  && hex(c.Y)===derived.Y && hex(c.commitments)===derived.Y && c.activatedAt===Number(genesisBlock.timestamp), 'current committee does not match single-seat genesis');
 requireThat(checkHost(facts).ok, 'current accepted host authority differs');
 requireThat(facts.codeActiveAt?.[R2.measurementSha256]===Number(genesisBlock.timestamp)
  && facts.codeActiveAt?.[OLD_CUSTODIAN_MEASUREMENT_SHA]===0, 'r2 was not active at genesis or old code is active');
}
export async function verifyGenesis({clients,reader,viem,abi,txHash,expectedMachine,endpoint,submitter,vaultCodeHash,now=()=>Date.now()}) {
 requireThat(vaultCodeHash===REVIEWED.secretVaultV2.codeHash, 'vault runtime pin is not the reviewed original');
 requireThat(Array.isArray(clients) && clients.length===2 && clients[0]!==clients[1], 'two distinct receipt clients required');
 try {
  const urls=clients.map(c=>c.transport?.url);
  if(urls.some(u=>u!==undefined)){
   const hosts=urls.map(u=>{let x=null;try{x=new URL(u);}catch{};requireThat(x && x.protocol==='https:' && !x.username && !x.password && !x.hash,'receipt RPC transport must be public HTTPS');return x.hostname.toLowerCase().replace(/\.$/,'');});
   requireThat(new Set(hosts).size===2,'receipt RPC transports alias the same hostname');
  }
  const reads=await Promise.all(clients.map(async c=>{
   requireThat(await c.getChainId()===8453, 'wrong RPC network');
   const receipt=await c.getTransactionReceipt({hash:txHash});
   const tx=await c.getTransaction({hash:txHash});
   const block=await c.getBlock({blockNumber:receipt.blockNumber});
   const head=await c.getBlockNumber({cacheTime:0});
   requireThat(head>=receipt.blockNumber+2n && block.number===receipt.blockNumber && lc(block.hash)===lc(receipt.blockHash)
    && typeof block.timestamp==='bigint' && block.timestamp>0n && block.timestamp<=BigInt(Math.floor(now()/1000)+10)
    && Array.isArray(block.transactions) && block.transactions.some(h=>lc(h)===lc(txHash)), 'receipt is not confirmed in the canonical block');
   return {receipt,tx,block};
  }));
  // Agreement includes exact calldata and event bytes, not merely status or block height. Values stay in memory.
  const pick = r => ({txHash:lc(r.tx.hash),from:lc(r.tx.from),to:lc(r.tx.to),input:r.tx.input,value:r.tx.value,chainId:r.tx.chainId,
   transactionBlock:r.tx.blockHash,transactionNumber:r.tx.blockNumber,receiptHash:r.receipt.transactionHash,receiptFrom:r.receipt.from,receiptTo:r.receipt.to,
   status:r.receipt.status,blockNumber:r.block.number,blockHash:r.block.hash,timestamp:r.block.timestamp,logs:r.receipt.logs});
  requireThat(equal(pick(reads[0]),pick(reads[1])), 'receipt providers disagree');
  const {receipt,tx,block}=reads[0];
  const derived=deriveGenesis({viem,abi,tx,receipt,expectedMachine,endpoint,submitter,txHash});
  const identity=await reader.readVaultIdentity();
  requireThat(identity.codeHash===vaultCodeHash && identity.enclaveOwner===ADMIN && identity.book===BOOK, 'original vault code or administrator differs');
  const facts=await reader.readAuthorization({committeeId:derived.committeeId,registryIds:[METAL0_REGISTRY_ID],measurements:[R2.measurementSha256,OLD_CUSTODIAN_MEASUREMENT_SHA]});
  checkActivated({facts,derived,expectedMachine,genesisBlock:block,nowSec:Math.floor(now()/1000)});
  // Recheck canonical inclusion after the state reads; never learn a committee from a receipt orphaned during verification.
  const finalBlocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:block.number})));
  requireThat(finalBlocks.every(b=>b.number===block.number && lc(b.hash)===lc(block.hash)), 'creation block changed during verification');
  checkActivated({facts,derived,expectedMachine,genesisBlock:block,nowSec:Math.floor(now()/1000)});
  return {outcome:'pass', evidence:{deploymentId:derived.committeeId,txHash,genesisBlockNumber:String(block.number),genesisBlockHash:block.hash,
   stateBlockNumber:String(facts.blockNumber),stateBlockHash:facts.blockHash,identity:lc(expectedMachine.identity),encKey:lc(expectedMachine.encKey),
   endpoint,measurement:R2.measurementSha256,seats:1,threshold:1,
   resolves:{'committee.verified':{ok:true,stepId:'G.verify',note:'Derived from confirmed creation, matching machine/key/code set and current accepted host owner.'}},
   scope:'Two-provider chain verification bound to the supplied machine. Fresh SNP quote verification is a separate mandatory prerequisite. Single-seat bootstrap, not decentralized custody.'}};
 } catch(e) {
  // Never echo an RPC/ABI error containing calldata, signatures, keys or chip fields.
  if (e?.[LOCAL]) throw e;
  throw new Error('genesis refused: provider read or verification failed');
 }
}
