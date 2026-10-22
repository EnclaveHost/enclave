// Read-only on-chain checks and an unsigned proposal. No nonce, signer, wallet request or broadcast.
import fs from 'node:fs';
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
import {collectEvidence} from './batch-topup-review/collect-evidence.mjs';
import {buildProposal,verifyProposal} from './batch-topup-review/batch-topup.mjs';
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url)));
const manifest=read('./batch-topup-review/proposed-manifest.json');
const code=read('./multicall-code-review.json');
if(!code.match||new Set(code.reads.map(r=>r.hash)).size!==1)throw Error('Multicall3 cross-chain code comparison failed');
const clients=['https://mainnet.base.org','https://base-rpc.polkachu.com','https://base-rpc.publicnode.com'].map(url=>({url,client:createPublicClient({transport:http(url,{timeout:15000,retryCount:0})})}));
const evidence=await collectEvidence({manifest,clients});
fs.writeFileSync(new URL('./batch-evidence-fresh.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
const proposal=buildProposal({manifest,evidence,expectedMulticall3CodeHash:code.reads[0].hash,expectTotalWei:'10000000000000000'});
fs.writeFileSync(new URL('./batch-proposal.json',import.meta.url),JSON.stringify(proposal,null,2)+'\n');
console.log(JSON.stringify({status:proposal.status,verified:verifyProposal(proposal),evidence:proposal.evidence,rows:proposal.rows}));
