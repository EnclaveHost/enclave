import fs from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {keccak256} from '../enclave/node_modules/viem/_esm/index.js';
import {parseProfile,rpcClients} from '../enclave/network/authority-profile.mjs';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
import {VAULT_V2_ABI} from '../enclave/custody/v2/chain.mjs';
import {MEASURED_RPCS,custodianMeasured} from '../enclave/custody/v2/build-config.mjs';
import {validateShieldOperator,defaultShieldLimits} from '../enclave/custody/v2/shield-operator.mjs';
const {profile}=parseProfile(fs.readFileSync('outputs/authority-profile/network-profile-base.json'),{expectedDigest:'sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8'});
const vault=profile.contracts.secretVaultV2,ownership=profile.contracts.hostOwnership;
const agreed=createQuorumReader({clients:rpcClients([...MEASURED_RPCS]),minAgree:3,chainId:8453,confirmations:2,timeoutMs:20000,maxAgeSec:120});
const observation=await agreed(async(client,{blockNumber})=>{
 const result={};
 for(const [name,pin] of [['vault',vault],['hostOwnership',ownership]]){
  const code=await client.getCode({address:pin.address,blockNumber});
  if(!code||keccak256(code)!==pin.codeHash)throw Error(name+' runtime does not match reviewed pin');
  result[name]={address:pin.address,codeHash:pin.codeHash};
 }
 result.bindings={};
 for(const [name,expected] of Object.entries(vault.immutable)){
  const value=String(await client.readContract({address:vault.address,abi:VAULT_V2_ABI,functionName:name,blockNumber})).toLowerCase();
  if(value!==expected)throw Error('vault binding mismatch '+name);
  result.bindings[name]=value;
 }
 return result;
});
const blocks=fs.readFileSync('work/enclave/relay/fixtures/tpm-roots.pem','utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
const pem=blocks.join('\n')+'\n';
const roots=blocks.map(x=>new X509Certificate(x)).filter(c=>c.checkIssued(c)&&c.verify(c.publicKey)).map(c=>createHash('sha256').update(c.raw).digest('hex'));
if(roots.length!==1||roots[0]!=='67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1')throw Error('unexpected TPM root');
const shield=validateShieldOperator({format:'enclave-custody-shield-operator/1',acceptTier:'windows-tpm-host/hv-node/T0-hv/hostExcluded:false',ekRoots:pem,ekRootPins:roots,limits:{...defaultShieldLimits(),maxAttestBytes:8*1024*1024}});
const measured=custodianMeasured({vault:vault.address,hostOwnership:ownership.address,transport:'direct',admission:'owner-permits',shieldRecipients:shield,trustedProxies:['10.0.2.2']});
fs.writeFileSync('work/custody-candidate-20261020/shield.json',JSON.stringify(shield,null,2)+'\n');
const report={at:new Date().toISOString(),profileDigest:'sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8',observation,rpcs:[...MEASURED_RPCS],minAgree:3,confirmations:2,measured:measured.measured,policy:measured.policy,needsDkg:measured.needsDkg,trustedProxyPeerObservedOnHardware:false,hardwareActivated:false,ownerRulesOrCommitteesChanged:false};
const encoded=JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
fs.writeFileSync('outputs/custodian-shield-build-preflight.json',encoded);
console.log(JSON.stringify({block:String(observation.blockNumber),hash:observation.blockHash,vault:vault.address,hostOwnership:ownership.address,policy:measured.policy,root:roots[0],activated:false}));
