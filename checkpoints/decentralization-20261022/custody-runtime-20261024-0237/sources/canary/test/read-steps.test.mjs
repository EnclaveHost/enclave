// Offline orchestration tests; dependency injection is explicit and does not represent an SNP quote or live chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readHostStep,readGenesisStep} from '../driver/read-steps.mjs';
import {loadR2Attestor} from '../driver/r2-attestor.mjs';
import {BOOK,REVIEWED} from '../driver/clipins.mjs';
import {ADMIN} from '../driver/genesis.mjs';
import {METAL0_REGISTRY_ID,METAL0_OPERATOR,METAL0_ENDPOINT} from '../driver/plan.mjs';
const H=x=>'0x'+x.repeat(32);
const pins=JSON.parse(fs.readFileSync(new URL('../pins.base.json',import.meta.url)));
const identity=()=>({codeHash:REVIEWED.secretVaultV2.codeHash,enclaveOwner:ADMIN,book:BOOK});
function host(){return {blockNumber:100n,blockHash:H('ab'),blockTimestamp:1000,enclaveOwner:ADMIN,
 entries:{[METAL0_REGISTRY_ID]:{active:true,endpoint:METAL0_ENDPOINT,operator:METAL0_OPERATOR,owner:ADMIN,payoutWallet:ADMIN,vaultEnclave:true,ownerConflict:false}}};}
test('host read resolves only fresh accepted administrator ownership in the original vault',async()=>{
 const reader={readVaultIdentity:async()=>identity(),readAuthorization:async q=>{assert.deepEqual(q,{registryIds:[METAL0_REGISTRY_ID]});return host();}};
 const r=await readHostStep({reader,now:()=>1005000});assert.equal(r.outcome,'pass');assert.equal(r.evidence.resolves['host.accepted'].ok,true);
 assert.equal(r.evidence.acceptedOwner,ADMIN);assert.equal(r.evidence.blockNumber,'100');
 for(const mutate of [s=>s.blockTimestamp=1,s=>s.blockTimestamp=2000,s=>s.entries[METAL0_REGISTRY_ID].owner='0x'+'00'.repeat(20),s=>s.entries[METAL0_REGISTRY_ID].active=false]){
  const q={...reader,readAuthorization:async()=>{const s=host();mutate(s);return s;}};
  await assert.rejects(readHostStep({reader:q,now:()=>1005000}),/snapshot|authority/);
 }
 await assert.rejects(readHostStep({reader:{...reader,readVaultIdentity:async()=>({...identity(),book:'0x'+'00'.repeat(20)})},now:()=>1005000}),/vault identity/);
 await assert.rejects(readHostStep({reader:{...reader,readAuthorization:async()=>{throw Error('private upstream');}},now:()=>1005000}),e=>!e.message.includes('private upstream'));
});
test('genesis read passes the freshly attested private machine to chain verification and emits only public quote evidence',async()=>{
 const machine={chipId:H('34'),identity:'0x'+'12'.repeat(20)},events=[];const p={...pins,custodian:{endpoint:'https://custody-canary.enclave.host'}};
 const quote={machine,requestedAt:1000000,verifiedAt:1001000,publicEvidence:{identity:machine.identity,vcekVerified:true}};
 const res=await readGenesisStep({pins:p,now:()=>1005000,txHash:H('ab'),attest:async()=>{events.push('attest');return quote;},
  verifyCommittee:async opts=>{events.push('chain');assert.equal(opts.expectedMachine,machine);assert.equal(opts.endpoint,p.custodian.endpoint);assert.equal(opts.submitter,p.owner.address);assert.equal(opts.txHash,H('ab'));return {outcome:'pass',evidence:{deploymentId:H('cd')}};}});
 assert.deepEqual(events,['attest','chain']);assert.equal(res.outcome,'pass');assert.equal(res.evidence.attestation,quote.publicEvidence);
 assert.ok(!JSON.stringify(res).includes(machine.chipId));assert.match(res.evidence.scope,/not decentralized/);
});
test('genesis read refuses missing, already stale and subsequently expired quotes',async()=>{
 let now=1005000,chainCalls=0;
 const quote={machine:{},requestedAt:1000000,verifiedAt:1001000,publicEvidence:{}};
 const opts={pins:{...pins,custodian:{endpoint:'https://custody-canary.enclave.host'}},now:()=>now,attest:async()=>quote,
  verifyCommittee:async()=>{chainCalls++;now=1120001;return {outcome:'pass',evidence:{}};}};
 await assert.rejects(readGenesisStep(opts),/expired/);assert.equal(chainCalls,1);
 await assert.rejects(readGenesisStep(opts),/fresh custodian/);assert.equal(chainCalls,1);
 now=1005000;quote.verifiedAt=undefined;await assert.rejects(readGenesisStep(opts),/fresh custodian/);
});
test('production attestor loader needs exact r2 source pins and a reviewed manifest before returning any network function',async()=>{
 assert.equal(typeof await loadR2Attestor(pins),'function');
 await assert.rejects(loadR2Attestor({...pins,repo:{...pins.repo,commit:'0'.repeat(40)}}),/reviewed r2/);
 for(const rel of ['relay/snp-verify.mjs','custody/v2/member.mjs','custody/v2/digests.mjs','custody/rules.mjs']){
  const p=structuredClone(pins);delete p.repo.files[rel];await assert.rejects(loadR2Attestor(p),/source/);
 }
 const p=structuredClone(pins);p.custodian.manifestFile='relative';await assert.rejects(loadR2Attestor(p),/absolute/);
});
