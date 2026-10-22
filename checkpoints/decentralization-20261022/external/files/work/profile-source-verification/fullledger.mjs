import {createRequire} from 'node:module';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');const solc=require('solc');
const g='/home/steven/Projects/enclave/.git';const src=execFileSync('git',['--git-dir='+g,'cat-file','-p','3f3d2c3ac155be4c108531b247b3f95a5c9ccdd4'],{encoding:'utf8'});
const t=Date.now();
const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'EnclaveDeployments.sol':{content:src}},settings:{optimizer:{enabled:true,runs:1},viaIR:true,outputSelection:{'*':{'*':['evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences','evm.deployedBytecode.linkReferences']}}}})));
const st=fs.readFileSync('/proc/self/status','utf8').match(/VmHWM:\s+(\d+)/)[1];
console.log('secs',(Date.now()-t)/1000,'peakRSS MiB',(st/1024).toFixed(0));
for(const [n,c] of Object.entries(out.contracts['EnclaveDeployments.sol']))console.log(n,c.evm.deployedBytecode.object.length/2,JSON.stringify(c.evm.deployedBytecode.linkReferences),Object.keys(c.evm.deployedBytecode.immutableReferences||{}).length);
fs.writeFileSync('ledger-compiled.json',JSON.stringify(out.contracts['EnclaveDeployments.sol']));
