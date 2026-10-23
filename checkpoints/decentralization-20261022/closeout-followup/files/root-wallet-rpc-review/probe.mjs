import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(dir,'wallet.frozen.js'),'utf8');
const pin=JSON.parse(fs.readFileSync(path.join(dir,'PIN.json'),'utf8'));
if(createHash('sha256').update(source).digest('hex')!==pin.sha256) throw Error('frozen source changed');
const observations=[];
for(const [state,rpcs] of [['on',['https://rpc.operator.example']],['invalid',[]],['off',['https://mainnet.base.org']]]) {
 const captures=[];
 const ctx=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,location:{origin:'https://dashboard.example'}});
 async function sm(exports) {
  const keys=Object.keys(exports);
  const m=new vm.SyntheticModule(keys,function(){for(const k of keys)this.setExport(k,exports[k]);},{context:ctx});
  await m.link(()=>{throw Error('unexpected nested import')});await m.evaluate();return m;
 }
 const config={BASE_CHAIN:8453,BASE_CHAIN_HEX:'0x2105',USDC_BASE:'0x'+'11'.repeat(20),WALLETCONNECT_PROJECT_ID:'test-no-network',INDEPENDENT:{state},APP_CATALOG_RPCS:rpcs};
 const util=Object.fromEntries(['$','$$','esc','short','lsGet','lsSet','copyText','showToast','emit'].map(k=>[k,()=>{}]));
 const modules={'./config.js':config,'./api.js':{Enclave:{},EnclaveError:class extends Error{}},'./chain.js':{baseRpc:()=>{throw Error('no network in probe')}},'./util.js':util,'../lib/qr.js':{qrSvg:()=>''},'./runlog.js':{runlog:()=>{}}};
 const m=new vm.SourceTextModule(source+'\nexport { wcProvider as __probe };\n',{context:ctx,identifier:pin.path,importModuleDynamically:async(spec)=>{
   if(spec!=='/vendor/walletconnect.js')throw Error('unexpected dynamic import '+spec);
   return sm({EthereumProvider:{init:async options=>{captures.push(JSON.parse(JSON.stringify(options)));return {};}}});
 }});
 await m.link(spec=>{if(!modules[spec])throw Error('unexpected import '+spec);return sm(modules[spec]);});
 await m.evaluate();let error=null;
 try {await m.namespace.__probe();} catch(e){error=e.message;}
 observations.push({state,profileRpcs:rpcs,initCalls:captures.length,rpcMap:captures[0]?.rpcMap??null,error});
}
const valid=observations[0],invalid=observations[1];
if(valid.rpcMap?.['8453']!=='https://mainnet.base.org'||invalid.initCalls!==1)throw Error('reproduction changed; inspect actual observations '+JSON.stringify(observations));
const result={observedAt:new Date().toISOString(),source:pin,scope:'Actual frozen wallet module evaluated in VM; imports and WalletConnect SDK stubbed to capture initialization. Only a test export appended; production function unchanged. No browser, wallet, signing, network requests or production writes.',observations,findings:['An independent profile RPC is ignored by WalletConnect rpcMap.','An invalid independent profile still initializes WalletConnect with the public RPC.'],fixed:false};
fs.writeFileSync('/home/steven/Documents/Codex/2026-10-18/wo/outputs/decentralization-audit/browser-wallet-rpc-bypass-20261023.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
