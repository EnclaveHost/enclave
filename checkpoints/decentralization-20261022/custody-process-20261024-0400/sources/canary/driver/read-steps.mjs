// Read-only production steps. Machine/quote material remains in memory; journals get curated public evidence only.
import {checkHost,verifyGenesis,ADMIN} from './genesis.mjs';
import {METAL0_REGISTRY_ID} from './plan.mjs';
import {BOOK,REVIEWED} from './clipins.mjs';
import {MAX_QUOTE_AGE_MS} from './attestation.mjs';
export async function readHostStep({reader,now=()=>Date.now()}) {
 let identity,facts;
 try{identity=await reader.readVaultIdentity();facts=await reader.readAuthorization({registryIds:[METAL0_REGISTRY_ID]});}
 catch{throw Error('host authority read unavailable; nothing accepted');}
 if(identity.codeHash!==REVIEWED.secretVaultV2.codeHash||identity.enclaveOwner!==ADMIN||identity.book!==BOOK)throw Error('host authority vault identity differs');
 const t=Math.floor(now()/1000);
 if(typeof facts?.blockNumber!=='bigint'||!/^0x[0-9a-f]{64}$/.test(facts.blockHash??'')||!Number.isSafeInteger(facts.blockTimestamp)
  ||facts.blockTimestamp<t-120||facts.blockTimestamp>t+10)throw Error('host authority snapshot is stale or malformed');
 const verdict=checkHost(facts);if(!verdict.ok)throw Error('accepted host authority is missing or conflicting');
 const e=facts.entries[METAL0_REGISTRY_ID];
 return {outcome:'pass',evidence:{blockNumber:String(facts.blockNumber),blockHash:facts.blockHash,blockTimestamp:facts.blockTimestamp,
  registryId:METAL0_REGISTRY_ID,acceptedOwner:e.owner,payoutWallet:e.payoutWallet,operator:e.operator,endpoint:e.endpoint,active:e.active,
  resolves:{'host.accepted':verdict}}};
}
export async function readGenesisStep({attest,reader,clients,viem,abi,txHash,pins,now=()=>Date.now(),verifyCommittee=verifyGenesis}) {
 const quote=await attest();
 const fresh=()=>Number.isSafeInteger(quote?.requestedAt)&&Number.isSafeInteger(quote?.verifiedAt)&&quote.verifiedAt>=quote.requestedAt
  &&now()>=quote.verifiedAt&&now()-quote.requestedAt<=MAX_QUOTE_AGE_MS;
 if(!fresh())throw Error('committee verification requires a fresh custodian quote');
 const result=await verifyCommittee({clients,reader,viem,abi,txHash,expectedMachine:quote.machine,endpoint:pins.custodian.endpoint,
  submitter:pins.owner.address,vaultCodeHash:pins.vaultCodeHash,now});
 if(!fresh())throw Error('custodian quote expired during committee verification');
 return {...result,evidence:{...result.evidence,attestation:quote.publicEvidence,
  scope:'Fresh AMD-rooted SNP quote bound to canonical committee creation and current accepted host authority. Single-seat bootstrap; not decentralized custody.'}};
}
