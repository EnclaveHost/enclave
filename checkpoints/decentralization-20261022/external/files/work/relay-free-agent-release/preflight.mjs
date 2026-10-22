import fs from 'node:fs/promises';
import os from 'node:os';
import {LeaseReader} from '../enclave/network/lease-reader.mjs';
import {createProviderBootstrap,providerRegistryReader} from '../enclave/network/provider-bootstrap.mjs';
import {createNetworkHost} from '../enclave/network/enclave-network-host.mjs';
const cfg=JSON.parse(await fs.readFile('/home/steven/enclave-prod/enclave-network/metal0/config.json','utf8'));
const networkConfig={...cfg.enclaveNetwork,bootstrap:{mode:'direct'}};delete networkConfig.relay;
const allowed=new Set([...cfg.chain.rpc,...networkConfig.directories].map(s=>new URL(s).origin));
const original=globalThis.fetch,requests=[];
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!allowed.has(url.origin))throw Error('preflight refused unconfigured origin '+url.origin);
 requests.push({origin:url.origin,path:url.pathname});return original(input,init);
};
const directory=await fs.mkdtemp(os.tmpdir()+'/relay-free-preflight-');
try{
 const reader=new LeaseReader(cfg.chain);
 const bootstrap=createProviderBootstrap({chain:cfg.chain,network:networkConfig});
 const providerReader=providerRegistryReader({bootstrap,liveReader:reader,control:()=>null,controlEnabled:true});
 const network=await createNetworkHost({config:networkConfig,directory,leaseReader:reader,providerReader,rpc:cfg.chain.rpc,addressBook:cfg.chain.addressBook,authorityPins:cfg.chain.authorityPins});
 const providers=await network.providers();if(providers.length<2)throw Error('insufficient qualified providers');
 const [registry]=await providerReader.registryEntries(cfg.chain.authorityPins.registry,[cfg.runner]);
 if(!registry?.active)throw Error('host registry not active');
 const leases=(await reader.refresh(cfg.apps.map(a=>a.deploymentId))).filter(a=>a.runner===cfg.runner&&a.active);
 if(!leases.length)throw Error('no local leases');
 const apps=[];
 for(const lease of leases){const policy=await network.policyFor({deploymentId:lease.id},lease);apps.push({id:lease.id,mode:policy.mode,nonce:policy.nonce});}
 if(apps.some(a=>a.mode==='byo-wireguard'))throw Error('local BYO files required before removing relay');
 const report={verifiedAt:new Date().toISOString(),relayConfigured:false,bootstrap:networkConfig.bootstrap,allowedOrigins:[...allowed],
  requests,registeredHost:cfg.runner,registeredOperator:registry.operator,confirmedBlock:reader.lastBlock.toString(),
  qualifiedProviders:providers.map(p=>({id:p.providerId,kind:p.kind,address:p.address})),apps,
  limitations:['Reads used configured production providers, all still Enclave-operated.','The transport allowlist is process-local, not an OS network isolation test.','This preflight opens no circuits and changes no live services.']};
 await fs.writeFile(new URL('../../outputs/relay-free-network/preflight.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({qualifiedProviders:providers.length,apps:apps.length,block:report.confirmedBlock,relayConfigured:false}));
}finally{await fs.rm(directory,{recursive:true,force:true});}
