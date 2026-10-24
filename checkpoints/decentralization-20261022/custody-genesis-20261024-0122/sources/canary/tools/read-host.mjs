// Read-only production authority observation; no keys, signatures or mutation calls.
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {checkRepo} from '../driver/cli.mjs';
import {checkHost} from '../driver/genesis.mjs';
import {METAL0_REGISTRY_ID,ORIGINAL_VAULT_V2} from '../driver/plan.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pins=JSON.parse(fs.readFileSync(path.join(root,'pins.base.json'),'utf8'));
try {
 checkRepo(pins);
 const {createChainReaderV2}=await import(pathToFileURL(path.join(pins.repo.path,'custody/v2/chain.mjs')).href);
 const {custodyVaultKind,checkCustodyVaultIdentity}=await import(pathToFileURL(path.join(pins.repo.path,'network/custody-vaults.mjs')).href);
 const reader=createChainReaderV2({rpcs:pins.rpcs,vault:ORIGINAL_VAULT_V2,...custodyVaultKind(ORIGINAL_VAULT_V2),chainId:8453,minAgree:2,confirmations:2});
 checkCustodyVaultIdentity(ORIGINAL_VAULT_V2,await reader.readVaultIdentity());
 const facts=await reader.readAuthorization({registryIds:[METAL0_REGISTRY_ID]});
 const e=facts.entries[METAL0_REGISTRY_ID], verdict=checkHost(facts);
 console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,blockNumber:String(facts.blockNumber),blockHash:facts.blockHash,
  blockTimestamp:facts.blockTimestamp,entry:{active:e.active,endpoint:e.endpoint,operator:e.operator,acceptedOwner:e.owner,payout:e.payoutWallet,
   vaultEnclave:e.vaultEnclave,ownerConflict:e.ownerConflict},ready:verdict.ok,note:verdict.note},null,2));
} catch { console.error('Host authority observation failed; no permission or readiness inferred.');process.exitCode=1; }
