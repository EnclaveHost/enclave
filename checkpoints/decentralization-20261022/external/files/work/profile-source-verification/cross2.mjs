import {createRequire} from 'node:module';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');const solc=require('solc');
const varint=n=>{const o=[];while(n>=0x80){o.push((n&0x7f)|0x80);n>>>=7;}o.push(n);return Buffer.from(o);};
const field=(t,b)=>Buffer.concat([Buffer.from([t]),varint(b.length),b]);
const ipfs=c=>{const d=Buffer.from(c,'utf8');return '1220'+createHash('sha256').update(field(0x0a,Buffer.concat([Buffer.from([8,2]),d.length?field(0x12,d):Buffer.alloc(0),Buffer.from([0x18]),varint(d.length)]))).digest('hex');};
const live=JSON.parse(fs.readFileSync('live-codes.json','utf8'));
const cb=c=>{const b=Buffer.from(c.slice(2),'hex');const L=b.readUInt16BE(b.length-2);const x=b.subarray(b.length-2-L,b.length-2).toString('hex');const i=x.indexOf('64697066735822');return x.slice(i+14,i+14+68);};
const want=cb(live.codes.connectivity);
const W='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git',P='/home/steven/Projects/enclave/.git';
const git=(g,...a)=>execFileSync('git',['--git-dir='+g,...a],{encoding:'utf8',maxBuffer:64<<20});
// every ledger blob reachable in either repo's object store, any path
const blobs=new Map();
for(const g of [P,W])for(const line of git(g,'rev-list','--all','--objects').split('\n')){const [h,p]=line.split(' ');if(p&&/EnclaveDeployments\.sol$/.test(p))blobs.set(h,g);}
console.log('ledger blobs',blobs.size);
const conn=git(W,'cat-file','-p','c0fb0bed725c7eba45eb4a6abc44ba9ee96f3b3e');
for(const [b,g] of blobs){const led=git(g,'cat-file','-p',b);for(const runs of [1,200]){
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'EnclaveConnectivity.sol':{content:conn},'EnclaveDeployments.sol':{content:led}},settings:{optimizer:{enabled:true,runs},viaIR:true,outputSelection:{'*':{EnclaveConnectivity:['metadata']}}}})));
  const m=out.contracts?.['EnclaveConnectivity.sol']?.EnclaveConnectivity?.metadata;if(m&&ipfs(m)===want){console.log('HIT ledger blob',b,'runs',runs);process.exit(0);}}}
console.log('no hit');
