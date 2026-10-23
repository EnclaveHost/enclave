// Evaluate the actual whole wallet module; the test starts an isolated VM-enabled child when needed.
// only export its private initializer for testing. SDK/browser imports are inert capture seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source=fs.readFileSync(new URL('../site/js/core/wallet.js',import.meta.url),'utf8');
async function setup(state,rpcs,{failFirst=false}={}) {
 const captures=[]; let lockCalls=0;
 const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,
   location:{origin:'https://dashboard.example'},navigator:{locks:{request:async(_name,_opts,fn)=>{lockCalls++;return fn({});}}}});
 async function synthetic(exports) {
  const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  await m.link(()=>{throw Error('unexpected nested import');}); await m.evaluate(); return m;
 }
 const config={BASE_CHAIN:8453,BASE_CHAIN_HEX:'0x2105',USDC_BASE:'0x'+'11'.repeat(20),WALLETCONNECT_PROJECT_ID:'offline-test',INDEPENDENT:{state},APP_CATALOG_RPCS:rpcs};
 const modules={'./config.js':config,'./api.js':{Enclave:{},EnclaveError:class extends Error{}},'./chain.js':{baseRpc:()=>{throw Error('unexpected RPC');}},
 './util.js':Object.fromEntries(['$','$$','esc','short','lsGet','lsSet','copyText','showToast','emit'].map(k=>[k,()=>{}])),
 '../lib/qr.js':{qrSvg:()=>''},'./runlog.js':{runlog:()=>{}}};
 const m=new vm.SourceTextModule(source+'\nexport { wcProvider as __testProvider };\n',{context,
  importModuleDynamically:async(spec)=>{
   assert.equal(spec,'/vendor/walletconnect.js');
   return synthetic({EthereumProvider:{init:async options=>{captures.push(JSON.parse(JSON.stringify(options)));if(failFirst&&captures.length===1)throw Error('SDK refused');return {};}}});
  }});
 await m.link(spec=>{assert.ok(modules[spec],spec);return synthetic(modules[spec]);}); await m.evaluate();
 return {start:()=>m.namespace.__testProvider(),captures,locks:()=>lockCalls};
}
if (typeof vm.SourceTextModule !== 'function') {
 test('WalletConnect RPC routing in the actual browser module', () => {
  const child=spawnSync(process.execPath,['--experimental-vm-modules','--test',fileURLToPath(import.meta.url)],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
 });
} else {
test('WalletConnect uses the confirmed profile RPC and shares one initialization',async()=>{
 const s=await setup('on',['https://rpc.operator.example','https://replica.operator.example']);
 const [a,b]=await Promise.all([s.start(),s.start()]);assert.equal(a,b);
 assert.equal(s.captures.length,1);assert.deepEqual(s.captures[0].rpcMap,{'8453':'https://rpc.operator.example'});assert.equal(s.locks(),1);
});
for(const state of ['invalid','unconfirmed'])test(`WalletConnect refuses ${state} profile before SDK or lock`,async()=>{
 const s=await setup(state,['https://rpc.operator.example']);await assert.rejects(s.start(),/Confirm a valid independent profile/);
 assert.equal(s.captures.length,0);assert.equal(s.locks(),0);
});
test('empty independent RPC list refuses without a hidden default',async()=>{
 const s=await setup('on',[]);await assert.rejects(s.start(),/no Base RPC/);assert.equal(s.captures.length,0);assert.equal(s.locks(),0);
});
test('SDK retry stays on the selected independent RPC',async()=>{
 const s=await setup('on',['https://rpc.operator.example'],{failFirst:true});await assert.rejects(s.start(),/SDK refused/);await s.start();
 assert.deepEqual(s.captures.map(c=>c.rpcMap['8453']),['https://rpc.operator.example','https://rpc.operator.example']);
});
test('hosted mode retains its existing WalletConnect endpoint',async()=>{
 const s=await setup('off',[]);await s.start();assert.deepEqual(s.captures[0].rpcMap,{'8453':'https://mainnet.base.org'});
});

}
