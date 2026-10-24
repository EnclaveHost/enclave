// Offline read-only adapter tests. Fixtures are not hardware evidence and never reach a public RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {BOOK,REVIEWED} from '../driver/clipins.mjs';
import {verifyGenesis,deriveGenesis,checkHost,EVENTS,ADMIN} from '../driver/genesis.mjs';
import {ORIGINAL_VAULT_V2,R2,METAL0_REGISTRY_ID,METAL0_OPERATOR,METAL0_ENDPOINT,OLD_CUSTODIAN_MEASUREMENT_SHA} from '../driver/plan.mjs';
const repo='/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2';
const viem=await import(pathToFileURL(repo+'/node_modules/viem/_esm/index.js').href);
const {VAULT_V2_ABI:abi}=await import(pathToFileURL(repo+'/custody/v2/chain.mjs').href);
const H=n=>'0x'+n.repeat(32), address=n=>'0x'+n.repeat(20), clone=structuredClone;
const endpoint='https://custody-canary.enclave.host', submitter=address('29'),txHash=H('45'),blockHash=H('67'),vaultCodeHash=REVIEWED.secretVaultV2.codeHash;
const Y='0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',salt=H('ab');
const expectedMachine={identity:address('12'),encKey:H('34'),endpoint,chipId:H('56'),registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256};
const committeeId=viem.keccak256(viem.encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'bytes32'},{type:'bytes32'}],[8453n,ORIGINAL_VAULT_V2,salt,viem.keccak256(Y)]));
const input=(machine=expectedMachine,codeSet=[R2.measurementSha256])=>viem.encodeFunctionData({abi,functionName:'createCommittee',args:[salt,machine,Y,codeSet,'0x'+'00'.repeat(65),'0x'+'00'.repeat(65)]});
function fixture() {
 const base={address:ORIGINAL_VAULT_V2,transactionHash:txHash,blockNumber:100n,blockHash,removed:false};
 const receipt={status:'success',transactionHash:txHash,from:submitter,to:ORIGINAL_VAULT_V2,blockNumber:100n,blockHash,
  logs:[{...base,logIndex:0,topics:viem.encodeEventTopics({abi:EVENTS,eventName:'CommitteeCreated',args:{committeeId,identity:expectedMachine.identity}}),data:viem.encodeAbiParameters([{type:'bytes'}],[Y])},
    {...base,logIndex:1,topics:viem.encodeEventTopics({abi:EVENTS,eventName:'EpochActivated',args:{committeeId}}),data:viem.encodeAbiParameters([{type:'uint32'}],[1])}]};
 const tx={hash:txHash,to:ORIGINAL_VAULT_V2,from:submitter,value:0n,chainId:8453,blockNumber:100n,blockHash,input:input()};
 const block={number:100n,hash:blockHash,timestamp:1000n,transactions:[txHash]};
 const facts={blockNumber:102n,blockHash:H('89'),blockTimestamp:1004,enclaveOwner:ADMIN,
  entries:{[METAL0_REGISTRY_ID]:{active:true,endpoint:METAL0_ENDPOINT,operator:METAL0_OPERATOR,owner:ADMIN,payoutWallet:ADMIN,vaultEnclave:true,ownerConflict:false}},
  committee:{committeeId,Y:viem.hexToBytes(Y),commitments:viem.hexToBytes(Y),epoch:1,t:1,W:1,activatedAt:1000,machines:[{...expectedMachine,enclave:true}]},
  codeActiveAt:{[R2.measurementSha256]:1000,[OLD_CUSTODIAN_MEASUREMENT_SHA]:0}};
 return {receipt,tx,block,facts};
}
function setup(change=()=>{},which=0) {
 const states=[fixture(),fixture()];if(which==='both')states.forEach(change);else change(states[which]);
 const clients=states.map(s=>({getChainId:async()=>8453,getTransactionReceipt:async()=>clone(s.receipt),getTransaction:async()=>clone(s.tx),getBlock:async()=>clone(s.block),getBlockNumber:async()=>102n}));
 const reader={readVaultIdentity:async()=>({codeHash:vaultCodeHash,enclaveOwner:ADMIN,book:BOOK}),readAuthorization:async()=>clone(states[0].facts)};
 return {clients,reader,viem,abi,txHash,expectedMachine,endpoint,submitter,vaultCodeHash,now:()=>1005_000};
}
test('learns committee only from confirmed matching calldata/events and current r2 machine/owner/code state',async()=>{
 const result=await verifyGenesis(setup());assert.equal(result.outcome,'pass');assert.equal(result.evidence.deploymentId,committeeId);
 assert.equal(result.evidence.seats,1);assert.equal(result.evidence.threshold,1);assert.equal(result.evidence.resolves['committee.verified'].ok,true);
 assert.match(result.evidence.scope,/not decentralized/);
 const text=JSON.stringify(result);assert.ok(!text.includes(expectedMachine.chipId));assert.ok(!text.includes(input()));assert.ok(!text.includes('00'.repeat(65)));
});
test('rejects wrong network, sender, destination, receipt status, transaction value and unconfirmed inclusion',async()=>{
 const a=setup();a.clients[0].getChainId=async()=>1;await assert.rejects(verifyGenesis(a),/wrong RPC network/);
 for (const change of [s=>s.receipt.status='reverted',s=>s.tx.from=address('99'),s=>s.receipt.to=address('99'),s=>s.tx.value=1n,s=>s.tx.chainId=1,
  s=>s.tx.blockHash=H('99'),s=>s.block.transactions=[],s=>s.block.hash=H('99')]) await assert.rejects(verifyGenesis(setup(change,'both')),/refused/);
 const b=setup();b.clients[1].getBlockNumber=async()=>101n;await assert.rejects(verifyGenesis(b),/not confirmed/);
});
test('rejects conflicting providers even when both return success',async()=>{
 await assert.rejects(verifyGenesis(setup(s=>s.tx.input=input({...expectedMachine,encKey:H('88')}),1)),/disagree/);
 await assert.rejects(verifyGenesis(setup(s=>s.receipt.logs[0].data=viem.encodeAbiParameters([{type:'bytes'}],['0x02'+'ff'.repeat(32)]),1)),/disagree/);
});
test('independent machine and exact code set checks refuse validly encoded wrong creations',()=>{
 for(const txInput of [input({...expectedMachine,chipId:H('77')}),input({...expectedMachine,registryId:H('77')}),input({...expectedMachine,identity:address('77')}),
  input(expectedMachine,[R2.measurementSha256,OLD_CUSTODIAN_MEASUREMENT_SHA]),input(expectedMachine,[OLD_CUSTODIAN_MEASUREMENT_SHA])]) {
  const f=fixture();f.tx.input=txInput;assert.throws(()=>deriveGenesis({...f,viem,abi,expectedMachine,endpoint,submitter,txHash}),/refused/);
 }
 const f=fixture();f.receipt.logs[0].topics[1]=H('fe');assert.throws(()=>deriveGenesis({...f,viem,abi,expectedMachine,endpoint,submitter,txHash}),/events/);
 f.receipt.logs=[];assert.throws(()=>deriveGenesis({...f,viem,abi,expectedMachine,endpoint,submitter,txHash}),/log inclusion/);
});
test('payout declaration never substitutes for accepted host ownership or active authority',async()=>{
 for(const patch of [{owner:address('00')},{owner:address('66')},{active:false},{operator:address('77')},{ownerConflict:true},{vaultEnclave:false},{endpoint:'https://other.example'}]) {
  const opts=setup(s=>Object.assign(s.facts.entries[METAL0_REGISTRY_ID],patch));
  assert.equal(checkHost(await opts.reader.readAuthorization()).ok,false);await assert.rejects(verifyGenesis(opts),/host authority/);
 }
});
test('rejects stale state, wrong current committee/key, activation time and old admitted code',async()=>{
 for(const change of [s=>s.facts.blockTimestamp=1,s=>s.facts.blockNumber=99n,s=>s.facts.committee.epoch=2,s=>s.facts.committee.W=2,
  s=>s.facts.committee.machines[0].enclave=false,s=>s.facts.committee.machines[0].encKey=H('77'),s=>s.facts.committee.Y=viem.hexToBytes('0x02'+'12'.repeat(32)),
  s=>s.facts.committee.commitments=viem.hexToBytes('0x02'+'12'.repeat(32)),s=>s.facts.committee.activatedAt=999,
  s=>s.facts.codeActiveAt[R2.measurementSha256]=999,s=>s.facts.codeActiveAt[OLD_CUSTODIAN_MEASUREMENT_SHA]=1]) await assert.rejects(verifyGenesis(setup(change,'both')),/refused/);
});
test('rechecks canonical block after authorization and sanitizes provider errors',async()=>{
 const a=setup();let n=0;a.clients[0].getBlock=async()=>({...fixture().block,hash:++n===1?blockHash:H('de')});await assert.rejects(verifyGenesis(a),/changed during/);
 const b=setup();const secret='genesis refused: private provider payload';b.clients[0].getTransaction=async()=>{throw Error(secret);};
 await assert.rejects(verifyGenesis(b),e=>e.message==='genesis refused: provider read or verification failed'&&!e.message.includes('private'));
});

test('pins original vault code/book and rejects aliased receipt providers',async()=>{
 await assert.rejects(verifyGenesis({...setup(),vaultCodeHash:H('aa')}),/reviewed original/);
 const a=setup();a.reader.readVaultIdentity=async()=>({codeHash:vaultCodeHash,enclaveOwner:ADMIN,book:address('00')});await assert.rejects(verifyGenesis(a),/vault code or administrator/);
 const b=setup();b.clients[0].transport={url:'https://same.example/path1'};b.clients[1].transport={url:'https://SAME.example./path2'};
 await assert.rejects(verifyGenesis(b),/alias/);
 const c=setup();let tick=1005000;c.now=()=>tick;let n=0;c.clients[1].getBlock=async()=>{if(++n===2)tick=1200000;return fixture().block;};
 await assert.rejects(verifyGenesis(c),/stale/);
});

test('agreement on success with forged receipt events still fails derivation',async()=>{
 const changes=[s=>s.receipt.logs[0].topics[1]=H('fe'),s=>s.receipt.logs[0].removed=true,
  s=>s.receipt.logs[1].data=viem.encodeAbiParameters([{type:'uint32'}],[2]),s=>s.receipt.logs.push({...s.receipt.logs[0]})];
 for(const change of changes) await assert.rejects(verifyGenesis(setup(change,'both')),/refused/);
});
