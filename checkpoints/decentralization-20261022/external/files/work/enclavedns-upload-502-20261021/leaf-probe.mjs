import fs from 'node:fs';
import {DNS} from '../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import {frozenWasm} from '../site-host-live-publish/handoff/site-upload.mjs';
import {cidString,cidParse} from '../enclave/scripts/site-release/unixfs.mjs';
import {spawnSync} from 'node:child_process';
const {dag}=frozenWasm(DNS);const raw=dag.blocks.map(([c])=>c).find(c=>c[1]===0x55);if(!raw)throw Error('no raw leaf');
const c=cidString(raw);const here=new URL('.',import.meta.url).pathname;
const r=spawnSync('curl',['-sS','--max-time','40','--max-filesize','400000','--resolve','7ae476a3.app.enclave.host:443:134.209.248.172','-D',here+'leaf.headers','-o',here+'leaf.body','-w','%{http_code}','https://7ae476a3.app.enclave.host/ipfs/'+c+'?format=raw'],{encoding:'utf8',timeout:45000});
let out={cid:c,curlExit:r.status,status:r.stdout};if(r.stdout!=='200'&&fs.existsSync(here+'leaf.body')){try{let b=JSON.parse(fs.readFileSync(here+'leaf.body'));out.error=String(b.error||'').slice(0,500)}catch{out.error='non-JSON'}}
console.log(JSON.stringify(out));
