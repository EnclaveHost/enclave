// Interactive regression fixture: the real Version panel, encoder and lifecycle
// against an in-memory ledger. No wallet connection, RPC or external writes.
// Run: node e2e/version-panel-fixture.mjs; open http://127.0.0.1:4198
import http from 'node:http';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const root = new URL('../', import.meta.url);
const source = await fs.readFile(new URL('site/components/deployments/deployments.js', root), 'utf8');
const method = source.slice(source.indexOf('  async _upgrade('), source.indexOf('  /* ---- per-row Protect:'));
const abi = JSON.parse(await fs.readFile(new URL('contracts/EnclaveDeployments.abi.json', root), 'utf8'));
const bundle = await build({ stdin: { resolveDir: root.pathname, contents: `
import * as chain from './site/js/core/chain.js';
import * as resize from './site/js/core/share-resize.js';
import * as allocation from './site/js/core/version-allocation.js';
import * as pricing from './site/js/core/pricing.js';
import { decodeFunctionData } from 'viem';
const method = ${JSON.stringify(method)}, abi = ${JSON.stringify(abi)};
const id = '0x'+'a'.repeat(64), zero = '0x'+'0'.repeat(64), runner = '0x'+'b'.repeat(64);
const scenario = new URLSearchParams(location.search).get('case') || 'grow';
let model = { owner: '0x123', appRef: 'catalog://app/0', active: true, runner,
 leaseUntil: Math.floor(Date.now()/1000)+300, gpuMilli: 100, cpuMilli: 140, balance6: 10000000, rate: 284 };
let calls = [], reads = 0;
const availability = { gpu: true, gpuShareFree: scenario === 'full' ? .02 : .10, cpuShareFree: 0,
 nodeRamGb: 96, nodeGflops: 546, nodeVcpus: 24, cardVramGb: 62, cardTflops: 214.7 };
const host = { name: 'metal0', row: { id: runner, availability }, spec: availability,
 price: { full: 6/3600, node: 3/3600 } };
const versions = [
 { version:'1.1.16', approval:1, vramMb:32768, gpuGflops:60000, ramMb:512, cpuGflops:30 },
 { version:'1.1.17', approval:1, vramMb:8192, gpuGflops:60000, ramMb:512, cpuGflops:30 },
 { version:'1.1.18', approval:1, vramMb:8192, gpuGflops:27000, ramMb:512, cpuGflops:30 },
 { version:'1.1.19', approval:1, vramMb:4096, gpuGflops:20000, ramMb:512, cpuGflops:30 }
];
// In the grow case only the actual reported versions exist.
if (scenario !== 'fits') versions.pop();
const deps = {
 ...chain, ...resize, ...allocation, ...pricing,
 esc: s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
 depGet: async () => ({...model}), depSnapshot: async () => ({...model, blockTimestamp: Math.floor(Date.now()/1000), blockNumber: calls.length+1 }),
 depSchemaRev: async () => scenario === 'legacy' ? 5 : 13,
 loadCatalog: async () => {}, adoptServerSpec: () => {},
 Enclave: { provider: {}, base:'/mock', getAvailability: async () => ({rateCap:true}), getEnclaves: async () => {
   reads++; return [{ ...host.row, availability: {...availability, ...(scenario === 'race' && reads > 1 ? {gpuShareFree:0} : {})} }];
 } },
 parseCatalogRef: () => ({appId:'app', index:0}), catalogRef: (_,i) => 'catalog://app/'+i,
 STORE:{byId:{app:{slug:'image-generator', versions}}}, APPROVAL:{approved:1},
 depFeeOf: async () => ({feePerSec6:0n}), catVersionFee: async (_,i) => scenario === 'fee' && i === 2 ? 1n : 0n,
 depPrices6: async () => ({gpu:1667n,cpu:834n}), depMaxGpuMilli: async () => 1000,
 depCapOf: async () => scenario === 'cap' ? 1n : 1000n,
 leaseHostOf: (_,fleet) => ({...host,row:fleet[0]}), hostChargeWaived: () => false,
 specOf: x => x, appLabel: () => 'aaaaaaaa', ctlOf: () => 'wallet', fmtDur: s => Math.floor(s)+' seconds',
 paintLine: (el, cls, value) => {const p=document.createElement('p');p.className=cls;p.textContent=value;el.append(p);},
 ensureBaseChain: async () => {}, connectWallet: async () => {}, refreshWallet: () => {},
 DEPLOYMENTS_ADDRESS:'0x'+'1'.repeat(40),
 sendTx: async (_,data) => {
  const tx=decodeFunctionData({abi,data});
  const inner=tx.functionName === 'multicall' ? tx.args[0].map(data=>decodeFunctionData({abi,data})) : [tx];
  calls.push(inner.map(c=>({name:c.functionName,args:c.args.map(x=>typeof x==='bigint'?Number(x):x)})));
  for(const c of inner) {
   if(c.functionName==='setAppRef') model.appRef=c.args[1];
   if(c.functionName==='setShares') Object.assign(model,{gpuMilli:Number(c.args[1]),cpuMilli:Number(c.args[2])});
   if(c.functionName==='setActive') {model.active=c.args[1]; if(!c.args[1]) Object.assign(model,{runner:zero,leaseUntil:0});}
  }
  document.querySelector('#transactions').textContent=JSON.stringify(calls,null,2);
  document.querySelector('#ledger').textContent=JSON.stringify(model,null,2);
  return '0xabc';
 },
 waitReceipt: async () => {}, showToast: () => {}, fetch: async () => ({}), setTimeout: () => 0
};
const fn = new Function('deps','with(deps) { return ({'+method+'})._upgrade; }')(deps);
fn.call({_list:[{id}],refresh(){}},id,document.querySelector('#version'),'version')
 .catch(e=>{document.querySelector('#errors').textContent=e.stack;});
window.addEventListener('error',e=>document.querySelector('#errors').textContent=e.message);
` }, bundle:true, write:false, format:'iife', platform:'browser', plugins:[{
 name:'offline-chain', setup(b) { b.onLoad({filter:/site\/js\/core\/chain\.js$/}, async ({path}) => ({
 contents: (await fs.readFile(path,'utf8')).replace(/^import .* from \"\.\/(api|util|pricing)\.js\";$/gm,'')
   + '\nclass EnclaveError extends Error {} const Enclave = {}, wait = async () => {}, fleetPrice = () => ({});',
 loader:'js', resolveDir:new URL('site/js/core/',root).pathname
 })); }
}] });
const html = `<!doctype html><title>Version change regression fixture</title><style>body{font:16px system-ui;max-width:1000px;margin:35px auto}button,select{font:inherit;padding:10px}pre{white-space:pre-wrap}.warn{color:#a00}</style>
<h1>Version change regression fixture</h1><p>In-memory ledger only. GPU reserved: 10%. GPU free: 10%. CPU reserved: 14%. CPU free: 0%.</p>
<nav>${['grow','fits','full','race','cap','fee','legacy'].map(x=>`<a href="/?case=${x}">${x}</a>`).join(' · ')}</nav>
<main><div class="enc-row"><div class="enc-tabs"><button id="version">Version</button></div><div class="enc-upg" hidden></div></div></main>
<h2>Transactions</h2><pre id="transactions">None</pre><h2>Ledger</h2><pre id="ledger">Unchanged</pre><pre id="errors"></pre><script src="/fixture.js"></script>`;
http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:html);}).listen(4198,'127.0.0.1',()=>console.log('Fixture: http://127.0.0.1:4198'));
