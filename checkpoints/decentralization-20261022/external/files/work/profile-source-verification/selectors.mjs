import {createRequire} from 'node:module';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');const solc=require('solc');
const g='/home/steven/Projects/enclave/.git';const git=(...a)=>execFileSync('git',['--git-dir='+g,...a],{encoding:'utf8',maxBuffer:64<<20});
const live=JSON.parse(fs.readFileSync('live-codes.json','utf8')).codes.connectivity.slice(2);
const sel=new Set();for(const m of live.matchAll(/63([0-9a-f]{8})(?=14|8114|81145)/g))sel.add(m[1]);
// walk opcodes properly
const b=Buffer.from(live,'hex');const pushed=new Set();for(let i=0;i<b.length;i++){const op=b[i];if(op===0x63&&b[i+5]===0x14)pushed.add(b.subarray(i+1,i+5).toString('hex'));if(op===0x63&&b[i+5]===0x81&&b[i+6]===0x14)pushed.add(b.subarray(i+1,i+5).toString('hex'));if(op>=0x60&&op<=0x7f)i+=op-0x5f;}
console.log('live dispatcher selectors',pushed.size);
const commits=git('log','--all','--format=%h','--','contracts/EnclaveConnectivity.sol').trim().split('\n');
for(const c of [...commits,'WORK']){
  const src=c==='WORK'?fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/EnclaveConnectivity.sol','utf8'):git('show',c+':contracts/EnclaveConnectivity.sol');
  const led=c==='WORK'?fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/EnclaveDeployments.sol','utf8'):git('show',c+':contracts/EnclaveDeployments.sol');
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'EnclaveConnectivity.sol':{content:src},'EnclaveDeployments.sol':{content:led}},settings:{outputSelection:{'*':{EnclaveConnectivity:['evm.methodIdentifiers']}}}})));
  const ids=out.contracts['EnclaveConnectivity.sol'].EnclaveConnectivity.evm.methodIdentifiers;const s=new Map(Object.entries(ids).map(([k,v])=>[v,k]));
  const missing=[...pushed].filter(x=>!s.has(x)),extra=[...s.keys()].filter(x=>!pushed.has(x));
  console.log(c,'abi',s.size,'liveNotInSrc',missing.length,'srcNotInLive',extra.map(x=>s.get(x)).join(' '));
}
