// Reviewed session factory binding: the ORIGINAL production factory 0x1F5c… stays the production session authority
// (book-bound to the admin's EnclaveAddressBook); the fixture holds its public runtime bytes read at an agreed Base block
// (work/existing-custody-audit/probes/session-factory-identity.mjs), so identity is checked against real code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readSessionAuthority} from '../network/session-authority.mjs';
import {REVIEWED_SESSION_FACTORIES,PRODUCTION_SESSION_FACTORY,sessionFactoryKind,checkSessionFactoryIdentity} from '../network/session-factories.mjs';

const FIX=JSON.parse(fs.readFileSync(new URL('./fixtures/session-factory-runtimes.json',import.meta.url),'utf8')).codes;
const F='0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c',I='0x66c76a47209f44612343dbeab98b8ef77ad01f65',B='0xab214342d5a490150a4a977063a2f88e21f80907';
const PF='0xec9277a32f98ad3108747fe3da78c35e1bee097b',PI='0x87bc7bfc8ca8b857fb43ebc6f4e49c807351ff5c',PB='0xf76a138ceb162aa4bab47d4787793c569759cac8';
const L='0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b',CAT='0x18419ca2b502d423a8de6269aeee171a378626e3',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const book32=(s)=>'0x'+Buffer.from(s).toString('hex').padEnd(64,'0');
function client({factory=F,impl=I,book=B,code={},ledger=L}={}){
 return {
  async readContract({address,functionName,args,blockNumber}){
   assert.equal(blockNumber,7n,'every read names the one block');
   const a=address.toLowerCase();
   if(a===factory&&functionName==='implementation')return impl;
   if(a===impl&&functionName==='factory')return factory;
   if(a===impl&&functionName==='book')return book;
   if(a===impl&&functionName==='usdc')return USDC;
   if(functionName==='addr')return args[0]===book32('deployments')?ledger:args[0]===book32('appCatalog')?CAT:'0x'+'00'.repeat(20);
   throw Error('unexpected '+a+' '+functionName);
  },
  async getCode({address,blockNumber}){assert.equal(blockNumber,7n);const a=address.toLowerCase();return code[a]??FIX[a]??'0x';},
 };
}
const want={factory:F,deployments:L,appCatalog:CAT,usdc:USDC};
test('the ORIGINAL production factory is accepted as the book-bound kind with its real reviewed runtimes',async()=>{
 assert.equal(PRODUCTION_SESSION_FACTORY,F);assert.equal(sessionFactoryKind(F),'book');assert.equal(sessionFactoryKind(PF),'pinned');
 const r=await readSessionAuthority(client(),7n,{...want,reviewed:true});
 assert.equal(r.kind,'book');assert.equal(r.book.toLowerCase(),B);assert.equal(r.deployments.toLowerCase(),L);
 const p=await readSessionAuthority(client({factory:PF,impl:PI,book:PB}),7n,{...want,factory:PF,reviewed:true});
 assert.equal(p.kind,'pinned','the optional fixed-binding factory remains usable when explicitly selected');
});
test('wrong book, wrong factory or implementation code, and unreviewed factories are refused',async()=>{
 await assert.rejects(readSessionAuthority(client({book:PB}),7n,{...want,reviewed:true}),/book differs/);
 await assert.rejects(readSessionAuthority(client({code:{[F]:'0x6000'}}),7n,{...want,reviewed:true}),/runtime differs/);
 await assert.rejects(readSessionAuthority(client({code:{[I]:FIX[PI]}}),7n,{...want,reviewed:true}),/implementation runtime/);
 const U='0x'+'22'.repeat(20);
 await assert.rejects(readSessionAuthority(client({factory:U}),7n,{...want,factory:U,reviewed:true}),/not a reviewed/);
 assert.throws(()=>checkSessionFactoryIdentity(F,{...REVIEWED_SESSION_FACTORIES[F],implementation:PI}),/implementation differs/);
});
test('existing callers are unchanged, and an admin ledger change still stops signing until re-reviewed',async()=>{
 const r=await readSessionAuthority(client(),7n,want);
 assert.equal('kind' in r,false);
 await assert.rejects(readSessionAuthority(client({ledger:'0x'+'99'.repeat(20)}),7n,{...want,reviewed:true}),/deployments differs/);
});
