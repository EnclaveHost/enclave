import {createRequire} from 'node:module';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');const solc=require('solc');
const g='/home/steven/Projects/enclave/.git';const git=(...a)=>execFileSync('git',['--git-dir='+g,...a],{encoding:'utf8',maxBuffer:64<<20});
const [cc,lc,runs]=process.argv.slice(2);
const live=JSON.parse(fs.readFileSync('live-codes.json','utf8')).codes.connectivity.slice(2);
const t=Date.now();
const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'EnclaveConnectivity.sol':{content:git('show',cc+':contracts/EnclaveConnectivity.sol')},'EnclaveDeployments.sol':{content:git('show',lc+':contracts/EnclaveDeployments.sol')}},settings:{optimizer:{enabled:true,runs:+runs},viaIR:true,outputSelection:{'*':{EnclaveConnectivity:['evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}})));
const d=out.contracts['EnclaveConnectivity.sol'].EnclaveConnectivity.evm.deployedBytecode;
let a=d.object,b=live;
console.log('secs',(Date.now()-t)/1000,'compiled',a.length/2,'live',b.length/2);
const strip=x=>{const L=parseInt(x.slice(-4),16);return x.slice(0,x.length-4-2*L);};
for(const refs of Object.values(d.immutableReferences||{}))for(const {start,length} of refs){a=a.slice(0,start*2)+'00'.repeat(length)+a.slice((start+length)*2);b=b.slice(0,start*2)+'00'.repeat(length)+b.slice((start+length)*2);}
console.log('immutables',JSON.stringify(d.immutableReferences));
const sa=strip(a),sb=strip(b);console.log('exec equal',sa===sb,'lens',sa.length/2,sb.length/2);
if(sa!==sb){let i=0;while(sa[i]===sb[i])i++;console.log('first diff byte',i/2);}
