// Read-only production readiness. This does NOT grant budget approval or unlock the wallet server.
import fs from 'node:fs';
import {ENROLLMENT} from '../lease-enrollment-urgent/trust.mjs';
import {validatePlan,sha256} from '../lease-enrollment-urgent/plan.mjs';
import {startCheck,prepareOperation} from '../lease-enrollment-urgent/chain.mjs';
import {verifiedArtifacts} from './artifacts.mjs';
import {PRODUCTION} from './trust.mjs';
import {clientsFor} from './rpc-clients.mjs';
const proposal=fs.readFileSync('outputs/app-lease-gas-review/complete-bootstrap-funding-proposal.json');
const artifacts=verifiedArtifacts({trust:PRODUCTION});
const abi=artifacts.EnclaveLeaseGasReserve.abi;
const plan=validatePlan({trust:ENROLLMENT,reserveAbi:abi,approvedSha256:sha256(proposal),proposal,enrollment:fs.readFileSync('outputs/app-lease-gas-review/enrollment-bootstrap-proposal.json'),identities:fs.readFileSync('outputs/app-lease-gas-review/lease-relay-identities.json')});
const clients=clientsFor(ENROLLMENT.rpcs);
const start=await startCheck({trust:ENROLLMENT,abi,ops:plan.operations,clients});
const request=await prepareOperation({trust:ENROLLMENT,abi,op:plan.operations[0],planSha256:plan.planSha256,laterValueWei:plan.totalWei-BigInt(plan.operations[0].value),clients});
const out={status:'READ-ONLY preflight; owner budget approval still pending; nothing signed or sent',checkedAt:new Date().toISOString(),start,firstOperation:request};
fs.writeFileSync('outputs/app-lease-gas-review/enrollment-readiness.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({status:out.status,operations:start.operationsChecked,block:start.anchor.blockNumber,firstOperation:request.title,feeLimitWei:request.estimatedFeeLimitWei}));
