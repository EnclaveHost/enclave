import * as D from './digests.mjs';
import { custodyVaultKind, REVIEWED_CUSTODY_VAULTS } from '../../network/custody-vaults.mjs';
const lc=value=>String(value).toLowerCase();
export function hostBindingReaderOptions(manifest, rpcs) {
  const pin = REVIEWED_CUSTODY_VAULTS[lc(manifest.vault)];
  if (!pin) throw Error('host binding requires a reviewed vault');
  const authority = pin.hostOwnership || pin.immutable.hostOwnership;
  if (lc(manifest.hostOwnership) !== lc(authority)) throw Error('host binding ownership differs from reviewed authority');
  return { rpcs, vault:manifest.vault, ...custodyVaultKind(manifest.vault), hostOwnership:manifest.hostOwnership,
    chainId:pin.chainId, minAgree:Math.floor(rpcs.length/2)+1, confirmations:2 };
}
// The private operator key is used only after the guest's requested machine
// record matches this host's configured registry and endpoint. The reader uses
// the reviewed vault's authority mode, including the original vault's admin book.
export async function prepareHostBinding({chain,operator,chainId,vault,registryId,registryEndpoint,endpoint,info}) {
  const m=info?.machine;
  if(info?.v!==2||!m||lc(m.registryId)!==lc(registryId)||m.endpoint!==endpoint||
     lc(m.identity)!==lc(info.identity)||lc(m.encKey)!==lc(info.encKey))throw Error('guest machine differs from configured host binding');
  const {entry}=await chain.readRegistryEntry({registryId});
  if(!entry?.active||entry.endpoint!==registryEndpoint||lc(entry.operator)!==lc(operator.address)||
     !/^0x[0-9a-f]{40}$/.test(lc(entry.owner))||/^0x0{40}$/i.test(entry.owner))
    throw Error('host operator or accepted owner is not authorized');
  const digest=D.hostDigest({chainId,vault:lc(vault),machine:m});
  if(info.hostSig&&await D.recoverDigest(digest,info.hostSig)===lc(operator.address))return {signature:info.hostSig,alreadyBound:true};
  return {signature:await D.signDigest(operator,digest),alreadyBound:false};
}
