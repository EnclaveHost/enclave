import fs from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const E='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const T=await import(E+'/scripts/network/verify-deployed-sources.mjs');
const {rpcClients}=await import(E+'/network/authority-profile.mjs');
const {keccak256}=await import(E+'/node_modules/viem/_esm/index.js');
const G=process.cwd()+'/origin-history.git';
const git=(...a)=>execFileSync('git',['--git-dir='+G,...a],{maxBuffer:8<<20});
const src=(commit,unit,p)=>{const blob=git('rev-parse',commit+':'+p).toString().trim();const c=git('cat-file','blob',blob);return [unit,{path:p,gitBlob:blob,sha256:createHash('sha256').update(c).digest('hex')}];};
const b=(commit,units,runs,viaIR)=>({commit:git('rev-parse',commit).toString().trim(),sources:Object.fromEntries(units.map(([u,p])=>src(commit,u,p))),settings:{optimizer:{enabled:true,runs},...(viaIR?{viaIR:true}:{})}});
const one=n=>[[n+'.sol','contracts/'+n+'.sol']];
const builds={
 'registry-schema4':b('b17db9a33',one('EnclaveRegistry'),200,false),
 'ledger-rev16d':b('4b7419bb0',one('EnclaveDeployments'),1,true),
 'catalog':b('f2e9a71d0',one('EnclaveAppCatalog'),200,true),
 'proof-of-time':b('44d5b928b9',one('EnclaveProofOfTime'),200,true),
 'pay':b('cf6022cce3',one('EnclavePay'),200,false),
 'verification-fees':b('28dd23c2e2',one('EnclaveVerificationFees'),200,true),
 'connectivity':b('4b7419bb0',[['contracts/EnclaveConnectivity.sol','contracts/EnclaveConnectivity.sol'],['contracts/EnclaveDeployments.sol','contracts/EnclaveDeployments.sol']],200,true),
 'payment-router':b('09ccf9cdb7',one('PaymentRouter'),200,false),
 'key-attestations':b('ee28c686f8',one('EnclaveKeyAttestations'),200,false),
 'legacy-sessions-v2':b('4aea7d8986',one('SessionVault'),1,true),
};
const C=(address,kind,build,unit,contract,profileName)=>({address,kind,build,unit,contract,runtimeBytes:1,codeHash:'0x'+'0'.repeat(64),metadataIpfs:'1220'+'0'.repeat(64),immutables:{},links:{},profileName,basis:'-'});
const contracts={
 registry:C('0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac','contract','registry-schema4','EnclaveRegistry.sol','EnclaveRegistry','registry'),
 deployments:C('0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b','contract','ledger-rev16d','EnclaveDeployments.sol','EnclaveDeployments','deployments'),
 ledgerBandwidthLibrary:C('0x3dfee18b44b7ecd389eca78da10b6ad032802215','library','ledger-rev16d','EnclaveDeployments.sol','EnclaveLedgerBandwidth',null),
 appCatalog:C('0x18419ca2b502d423a8de6269aeee171a378626e3','contract','catalog','EnclaveAppCatalog.sol','EnclaveAppCatalog','appCatalog'),
 proofOfTime:C('0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2','contract','proof-of-time','EnclaveProofOfTime.sol','EnclaveProofOfTime','proofOfTime'),
 enclavePay:C('0x580270e88e5df35dad59e7fe3d907ebea96673a6','contract','pay','EnclavePay.sol','EnclavePay','enclavePay'),
 verificationFees:C('0x87c7266543ff5839b2c20226bd9b3cd511a23641','contract','verification-fees','EnclaveVerificationFees.sol','EnclaveVerificationFees','verificationFees'),
 connectivity:C('0x5f8b636e0768e84bd47b736652030b65db615111','contract','connectivity','contracts/EnclaveConnectivity.sol','EnclaveConnectivity','connectivity'),
 paymentRouter:C('0xf17157b42ebbd65e33dd592878a8f1769c69d56a','contract','payment-router','PaymentRouter.sol','PaymentRouter','paymentRouter'),
 keyAttestations:C('0xb49241efe5af6078be6aa84850ae45eed34df61b','contract','key-attestations','EnclaveKeyAttestations.sol','EnclaveKeyAttestations','keyAttestations'),
 legacySessionVaultFactory:C('0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c','contract','legacy-sessions-v2','SessionVault.sol','SessionVaultFactory','legacySessionVaultFactory'),
 legacySessionVaultImplementation:C('0x66c76a47209f44612343dbeab98b8ef77ad01f65','contract','legacy-sessions-v2','SessionVault.sol','SessionVault','legacySessionVaultImplementation'),
 legacySessionVaultLib:C('0x5510ae9fed97577d75c69545384af7d8bad05027','library','legacy-sessions-v2','SessionVault.sol','SessionVaultLib',null),
};
const external={usdc:{address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',kind:'upgradeable-proxy',codeHash:'0x'+'0'.repeat(64),runtimeBytes:1,metadataSolc:'0.6.12',
 slots:{implementation:'0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',admin:'0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b'},profileName:'usdc',basis:'-'}};
const solcPkg=JSON.parse(fs.readFileSync(E+'/node_modules/solc/package.json'));
const manifest={kind:T.MANIFEST_KIND,version:1,chainId:8453,repository:'https://github.com/EnclaveHost/enclave.git',
 compiler:{version:'0.8.35+commit.47b9dedd.Emscripten.clang',package:'solc@'+solcPkg.version,soljsonSha256:createHash('sha256').update(fs.readFileSync(E+'/node_modules/solc/soljson.js')).digest('hex')},
 review:{blockNumber:'1',blockHash:'0x'+'0'.repeat(64),rpcHosts:['a','b']},builds,contracts,external};
T.validateManifest(manifest);
const solc=T.loadCompiler(manifest);
const rpcs=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.drpc.org'];
const live=await T.readLive(manifest,rpcClients(rpcs));
console.log('block',live.blockNumber,live.hash,'failures',live.failures.length);
manifest.review={blockNumber:live.blockNumber,blockHash:live.hash,rpcHosts:rpcs.map(u=>new URL(u).hostname)};
// fill code pins from live, slot values from comparison (reviewed below before writing)
const byBuild={};for(const [n,c] of Object.entries(contracts))(byBuild[c.build]||=[]).push([n,c]);
for(const [id,entries] of Object.entries(byBuild)){
  const sources=await T.readBuildSources(builds[id],[G]);const t=Date.now();
  const k=T.compileBuild(solc,builds[id],sources,entries.map(([,c])=>({unit:c.unit,contract:c.contract})));
  for(const [n,c] of entries){const code=live.codes[n];const kk=k[c.unit+':'+c.contract];
    const r=T.compareRuntime({compiled:kk,liveCode:code,address:c.address,kind:c.kind,expectedImmutables:{},expectedLinks:{}});
    c.runtimeBytes=(code.length-2)/2;c.codeHash=keccak256(code);c.metadataIpfs=T.ipfsMetadataHash(kk.metadata);c.immutables=r.immutables||{};c.links=r.links||{};
    console.log(n,id,((Date.now()-t)/1000).toFixed(1)+'s',r.status,r.reason||'',r.metadata?.live===c.metadataIpfs?'meta=':'meta!=',JSON.stringify(r.immutables),JSON.stringify(r.links));}
}
const u=live.codes.usdc;external.usdc.codeHash=keccak256(u);external.usdc.runtimeBytes=(u.length-2)/2;
console.log('usdc slots',live.slots.usdc);
console.log('peak MiB',Math.round(fs.readFileSync('/proc/self/status','utf8').match(/VmHWM:\s+(\d+)/)[1]/1024));
fs.writeFileSync('manifest-draft.json',JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync('live-author.json',JSON.stringify(live,null,1));
