import {createRequire} from 'node:module';import fs from 'node:fs';import {createHash} from 'node:crypto';
const require=createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const solc=require('solc');
const varint=n=>{const o=[];while(n>=0x80){o.push((n&0x7f)|0x80);n>>>=7;}o.push(n);return Buffer.from(o);};
const field=(tag,b)=>Buffer.concat([Buffer.from([tag]),varint(b.length),b]);
export function ipfsHash(content){const d=Buffer.from(content,'utf8');
  const unixfs=Buffer.concat([Buffer.from([0x08,0x02]),d.length?field(0x12,d):Buffer.alloc(0),Buffer.from([0x18]),varint(d.length)]);
  const node=field(0x0a,unixfs);return '1220'+createHash('sha256').update(node).digest('hex');}
const src=fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/PaymentRouter.sol','utf8');
for(const sel of [['metadata'],['metadata','evm.deployedBytecode.object']]){
  const t=Date.now();
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'PaymentRouter.sol':{content:src}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':sel}}}})));
  const c=out.contracts['PaymentRouter.sol'].PaymentRouter;
  console.log(sel.join('+'),Date.now()-t,'ms',ipfsHash(c.metadata));
  if(c.evm)console.log(' bytecode cbor',c.evm.deployedBytecode.object.slice(-106,-38));
}
