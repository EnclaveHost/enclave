import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const P=process.cwd(), C=path.join(P,'consumer-cutover-remaining-20261026/run/20261026T022847Z/cand');
const {build}=await import(pathToFileURL(path.join(C,'node_modules/esbuild/lib/main.js')));
const {readAuthorityPlugin}=await import(pathToFileURL(path.join(C,'scripts/site-read-authority.mjs')));
const src=fs.readFileSync(path.join(C,'scripts/build-site.mjs'),'utf8');
const start=src.indexOf('const creditResult = await build({');
const end=src.indexOf('\n});',start)+4;
assert(start>0 && end>start);
const statement=src.slice(start,end);
const text=JSON.stringify({version:1,mode:'own-rpc',rpcs:['https://rpc-a.own-node.example/','https://rpc-b.own-node.example/base'],trust:'self-hosted-transport'});
const SITE=path.join(C,'site');
for(const mode of ['legacy','own']){
 const DIST=path.join(P,'consumer-cutover-remaining-20261026/credit-bundle-root',mode);
 fs.mkdirSync(DIST,{recursive:true});
 await new (Object.getPrototypeOf(async function(){}).constructor)('build','path','SITE','DIST','READ_AUTH','readAuthorityPlugin',statement)(build,path,SITE,DIST,mode==='own'?{text}:null,readAuthorityPlugin);
 const body=fs.readFileSync(path.join(DIST,'credit/credit.js'),'utf8');
 assert.equal(body.includes('https://rpc-a.own-node.example/'),mode==='own');
 assert.equal(body.includes('https://rpc-b.own-node.example/base'),mode==='own');
 console.log(mode+': actual credit build statement succeeded, release authority embedding matches mode');
}
console.log('PASS: two actual credit bundles; not a full site build or live browser proof');
