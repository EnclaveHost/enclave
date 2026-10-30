#!/usr/bin/env node
// Build-only candidate. Never deploys, changes production artifacts or fetches sources.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dependencies,linkTemplate} from '../network/lifecycle-linked-artifacts.mjs';
const stage=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [compiler,output]=process.argv.slice(2);
if(process.argv.length!==4||!path.isAbsolute(compiler)||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Absolute pinned compiler and NEW output directory required');
function run(args,input){
 const r=spawnSync(compiler,args,{input,encoding:'utf8',timeout:270000,maxBuffer:16*1024*1024});
 if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||'compiler failed');
 return r.stdout;
}
const version=run(['--version']).match(/Version: ([^\s]+)/)?.[1];
if(version!=='0.8.35+commit.47b9dedd.Linux.g++')throw Error('unqualified compiler');
const inputs={
 'candidate/deploy/EnclaveDeployments.sol':path.join(stage,'candidate/deploy/EnclaveDeployments.sol'),
 'candidate/deploy/EnclaveProofOfTime.sol':path.join(stage,'candidate/deploy/EnclaveProofOfTime.sol'),
 'contracts/EnclaveDeploymentLifecycleEmergency.sol':path.resolve(stage,'../emergency-offline/candidate/contracts/EnclaveDeploymentLifecycleEmergency.sol'),
 'contracts/EnclaveSelfHostingIdentity.sol':path.resolve(stage,'../../../contracts/EnclaveSelfHostingIdentity.sol'),
};
const sources=Object.fromEntries(Object.entries(inputs).map(([key,file])=>[key,{content:fs.readFileSync(file,'utf8')}]));
const settings={optimizer:{enabled:true,runs:1},viaIR:true,evmVersion:'prague',outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode','storageLayout','metadata']}}};
fs.mkdirSync(output,{recursive:false});
const input={language:'Solidity',sources,settings};
fs.writeFileSync(path.join(output,'compiler-input.json'),JSON.stringify(input)+'\n');
const raw=run(['--standard-json'],JSON.stringify(input));
fs.writeFileSync(path.join(output,'compiler-output.json'),raw);
const result=JSON.parse(raw);
const errors=(result.errors||[]).filter(x=>x.severity==='error');if(errors.length)throw Error(errors.map(x=>x.formattedMessage).join('\n'));
const definitions={
 'EnclaveDeployments':'candidate/deploy/EnclaveDeployments.sol',
 'EnclaveLifecycleAccounting':'candidate/deploy/EnclaveDeployments.sol',
 'EnclaveProofOfTime':'candidate/deploy/EnclaveProofOfTime.sol',
 'EnclaveDeploymentLifecycleEmergency':'contracts/EnclaveDeploymentLifecycleEmergency.sol',
 'EnclaveSelfHostingIdentity':'contracts/EnclaveSelfHostingIdentity.sol',
};
const bundle={schema:1,qualification:'unlinked source templates; NOT deployed pins; NOT production qualified',compiler:version,settings,
 sourceSha256:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,createHash('sha256').update(v.content).digest('hex')])),contracts:{}};
for(const [name,source] of Object.entries(definitions)){
 const c=result.contracts?.[source]?.[name];if(!c)throw Error('missing compiled '+name);
 const kind=name==='EnclaveLifecycleAccounting'?'library':'contract';
 const a={kind,abi:c.abi,creationTemplate:'0x'+c.evm.bytecode.object,runtimeTemplate:'0x'+c.evm.deployedBytecode.object,
  creationLinks:c.evm.bytecode.linkReferences||{},runtimeLinks:c.evm.deployedBytecode.linkReferences||{},
  immutableReferences:c.evm.deployedBytecode.immutableReferences||{},storageLayout:c.storageLayout,metadata:JSON.parse(c.metadata)};
 const runtimeBytes=(a.runtimeTemplate.length-2)/2;
 if(runtimeBytes===0||runtimeBytes>24576)throw Error(name+': empty or oversized runtime ('+runtimeBytes+')');
 if(kind==='library'){
  if(dependencies(a).length)throw Error('nested libraries require separate review');
  const slots=a.immutableReferences.library_deploy_address;
  if(!Array.isArray(slots)||!slots.length||slots.some(x=>x.length!==32||!Number.isSafeInteger(x.start)||x.start<0||a.runtimeTemplate.slice(2+x.start*2,2+(x.start+32)*2)!=='00'.repeat(32)))throw Error('unsupported Solidity library self immutable');
  a.librarySelfAddress={format:'solc-viair-library-immutable32',immutableId:'library_deploy_address'};
 }
 // Validate all compiler link ranges, without treating these dummy-filled bytes
 // as deployment artifacts, linked success or an actual code hash.
 for(const [template,refs] of [[a.creationTemplate,a.creationLinks],[a.runtimeTemplate,a.runtimeLinks]]){
  const names={};for(const [file,libs] of Object.entries(refs))for(const lib of Object.keys(libs))names[file+':'+lib]='0x'+'11'.repeat(20);
  linkTemplate(template,refs,names);
 }
 bundle.contracts[source+':'+name]={...a,runtimeBytes};
}
for(const a of Object.values(bundle.contracts))for(const dep of dependencies(a))if(bundle.contracts[dep]?.kind!=='library')throw Error('missing library artifact');
fs.writeFileSync(path.join(output,'bundle.json'),JSON.stringify(bundle,null,2)+'\n');
fs.writeFileSync(path.join(output,'compiler-diagnostics.json'),JSON.stringify(result.errors||[],null,2)+'\n');
console.log(JSON.stringify({qualification:bundle.qualification,sizes:Object.fromEntries(Object.entries(bundle.contracts).map(([k,a])=>[k,a.runtimeBytes]))}));
