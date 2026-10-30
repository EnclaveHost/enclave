// Goal-alignment regression: publisher metadata is not deployment-owner or host-owner authority.
// Same referenced content commitment; no production chain or content availability claim.
import {AUTHORITY_URL} from './helpers/baseline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {independentAdmissionRefusal}=await import(AUTHORITY_URL);
const hostId='0x'+'99'.repeat(32), deploymentId='0x'+'aa'.repeat(32), appId='0x'+'cd'.repeat(32);
const policy={version:1,chainId:8453,ownershipContract:'0x'+'0e'.repeat(20),hostId,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]};
for(const [label,appChange,versionChange] of [['publisher delisting',{active:false},{}],['publisher yanking',{}, {yanked:true}]]){
 test(`${label} alone cannot veto an independently owned deployment of the same committed artifact`,()=>{
  const row={hostId,deploymentId,appRef:`catalog://${appId}/1`,app:{appId,versionCount:2,active:true},version:{cid:'bafy-test-same-content-commitment',createdAt:'1',yanked:false,approval:0}};
  assert.equal(independentAdmissionRefusal(policy,row),null,'positive control');
  assert.equal(independentAdmissionRefusal(policy,{...row,app:{...row.app,...appChange},version:{...row.version,...versionChange}}),null,'mutable publisher listing preferences are not this host or deployment owner policy');
 });
}
