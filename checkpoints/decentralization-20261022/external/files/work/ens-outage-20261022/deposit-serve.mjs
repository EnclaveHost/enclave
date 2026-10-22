import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {QuorumChain} from '../wallet-handoff-bridge/tree/cli/independent.mjs';
import {intentJournal} from '../wallet-handoff-bridge/tree/cli/independent-signer.mjs';
import {createBridge} from './deposit-ui/bridge.mjs';
import {depositPlan} from './deposit-plan.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));const amount=process.argv[2];const mode=process.argv[3];
if(!amount||!['--check','--serve'].includes(mode))throw Error('Usage: deposit-serve.mjs WEI --check|--serve');
const journalDir=path.join(dir,'deposit-journal');const j=intentJournal(journalDir);
const plan=depositPlan(amount,{confirmed:id=>j.list().some(r=>r.bridge?.plan===id&&r.state==='confirmed')});
const chain=new QuorumChain({rpcs:['https://mainnet.base.org','https://base-rpc.polkachu.com','https://base-rpc.publicnode.com'],chainId:8453,quorum:2,confirmations:2,maxBlockAgeMs:120000});
const bridge=createBridge({chain,plan,journalDir,maxFeeGwei:0.1,gasCap:200000n,waitOpts:{timeoutMs:180000,pollMs:3000}});
if(mode==='--check'){
 const state=await bridge.state({fresh:true});fs.writeFileSync(path.join(dir,'deposit-preflight.json'),JSON.stringify(state,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');console.log(JSON.stringify({state:state.steps[0].verdict,canPrepare:state.steps[0].canPrepare},(_,v)=>typeof v==='bigint'?String(v):v));
 if(state.steps[0].verdict.state==='ready'){
  const r=await bridge.prepare('deposit');fs.writeFileSync(path.join(dir,'deposit-request.json'),JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({prepared:true,params:r.params,intent:r.id,maxNetworkFeeWei:r.maxNetworkFeeWei}));
 } else process.exitCode=2;
}else{const x=await bridge.listen({port:39691});fs.writeFileSync(path.join(dir,'deposit-local-url.txt'),x.url+'\n');console.log('Wallet handoff listening on127.0.0.1:39691; local capability URL saved. No wallet request sent.');process.on('SIGTERM',()=>x.close());}
