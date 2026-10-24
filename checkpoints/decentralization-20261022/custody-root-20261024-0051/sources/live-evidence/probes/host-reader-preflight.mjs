// Actual host reader options against the original live vault. Read only; no key or signature.
import fs from 'node:fs';
import {hostBindingReaderOptions} from '../../custody-v2-durability-20261023/repo/custody/v2/host-binding.mjs';
import {createChainReaderV2} from '../../custody-v2-durability-20261023/repo/custody/v2/chain.mjs';
import {checkCustodyVaultIdentity} from '../../custody-v2-durability-20261023/repo/network/custody-vaults.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../../custody-v2-release-20261023/evidence/A-manifest.json',import.meta.url)));
const options=hostBindingReaderOptions(manifest,['https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public']);
const reader=createChainReaderV2(options);const identity=await reader.readVaultIdentity();checkCustodyVaultIdentity(manifest.vault,identity);
const entry=await reader.readRegistryEntry({registryId:'0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be'});
const out={at:new Date().toISOString(),readOnly:true,options,identity,entry};fs.writeFileSync(new URL('../evidence/host-reader-preflight.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({kind:options.vaultKind,book:options.book,entry:entry.entry}));
