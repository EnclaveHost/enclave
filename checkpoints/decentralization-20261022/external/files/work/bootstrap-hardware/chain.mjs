import fs from 'node:fs';
import {createPublicClient,createWalletClient,http,decodeEventLog,encodeFunctionData} from '../enclave/node_modules/viem/_esm/index.js';
import {base} from '../enclave/node_modules/viem/_esm/chains/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {FileStore,sessionFromRecord} from '../enclave/sdk/sessions/dist/node.mjs';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(fs.readFileSync(new URL(n,dir)));
const plan=read('preflight.json'),derived=read('derived.json');
const account=privateKeyToAccount(JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json')).registryKey);
if(account.address!==plan.operator)throw Error('operator changed');
const pc=createPublicClient({chain:base,transport:http('https://mainnet.base.org',{timeout:15000})});
const wc=createWalletClient({account,chain:base,transport:http('https://mainnet.base.org',{timeout:15000})});
const store=new FileStore(),rec=await store.load(store.activeId());
if(rec.handle.sid!==plan.session.sid||rec.handle.vault!==plan.session.vault)throw Error('session changed');
rec.handle={...rec.handle,rpc:'https://mainnet.base.org',relay:''};
const session=await sessionFromRecord(rec);
const ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const abi=JSON.parse(fs.readFileSync(new URL('../enclave/contracts/EnclaveDeployments.abi.json',dir)));
const stateURL=new URL('chain-state.json',dir);
const state=fs.existsSync(stateURL)?JSON.parse(fs.readFileSync(stateURL)):{transactions:{}};
const save=()=>fs.writeFileSync(stateURL,JSON.stringify(state,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n',{mode:0o600});
const appRef=`catalog://${plan.session.apps[0]}/${plan.app.index}`;
async function transact(label,tx){
 if(!state.transactions[label]){
  await pc.call({account:account.address,to:tx.to,data:tx.data,value:0n});
  const estimate=await pc.estimateGas({account:account.address,to:tx.to,data:tx.data,value:0n});
  const gas=estimate*12n/10n,fees=await pc.estimateFeesPerGas();
  if(gas*fees.maxFeePerGas>10000000000000n)throw Error('hardware test gas cap exceeded');
  console.log(JSON.stringify({stage:label,simulated:true,gas:String(gas),maxExecutionFeeWei:String(gas*fees.maxFeePerGas)}));
  if(process.argv.includes('--simulate'))return null;
  const hash=await wc.sendTransaction({to:tx.to,data:tx.data,value:0n,gas,...fees});
  state.transactions[label]={hash};save();
 }
 const receipt=await pc.waitForTransactionReceipt({hash:state.transactions[label].hash,timeout:60000});
 state.transactions[label]={...state.transactions[label],status:receipt.status,block:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed)};save();
 if(receipt.status!=='success')throw Error(label+' reverted');
 console.log(JSON.stringify({stage:label,receipt:state.transactions[label]}));return receipt;
}
const stage=process.argv[2];
const label=process.argv.find(v=>v.startsWith('--label='))?.slice(8)||stage;
if(!/^[a-z][a-z0-9-]{0,63}$/.test(label))throw Error('invalid transaction journal label');
if(stage==='create'){
 const configCid=JSON.stringify({guestBootstrap:{version:1,sha256:'f'.repeat(64)},isolation:{require:'snp-guest-per-app'},placement:{hostId:plan.enclave.id}});
 const receipt=await transact('create',await session.prepareCall('deploy.create',{appRef,gpuMilli:0,cpuMilli:10,appPort:8000,ports:'http:8000',isPublic:true,configCid,maxRate6:100n,env:'staging',fund6:0n}));
 if(receipt){for(const log of receipt.logs){try{const e=decodeEventLog({abi,data:log.data,topics:log.topics});if(log.address.toLowerCase()===ledger.toLowerCase()&&e.eventName==='Created'){state.id=e.args.id;save();}}catch{}}if(!state.id)throw Error('no deployment Created event');console.log(JSON.stringify({id:state.id}));}
}else{
 if(!state.id)throw Error('create a test record first');
 const d=await pc.readContract({address:ledger,abi,functionName:'get',args:[state.id]});
 if(d.owner.toLowerCase()!==plan.session.vault.toLowerCase()||d.appRef!==appRef)throw Error('test record scope changed');
 if(stage==='status')console.log(JSON.stringify(d,(_,v)=>typeof v==='bigint'?String(v):v));
 else if(stage==='commit'){
  const pkg=read('package-meta.json');
  const configCid=JSON.stringify({...JSON.parse(d.configCid),guestBootstrap:pkg.intent});
  await transact('commit',await session.prepareCall('deploy.setConfig',{id:state.id,configCid}));
 }else if(stage==='fund')await transact('fund',await session.prepareCall('deploy.fund',{id:state.id,amount6:10000n}));
 else if(stage==='resume')await transact('resume',await session.prepareCall('deploy.setActive',{id:state.id,active:true}));
 else if(stage==='stop')await transact(label,await session.prepareCall('deploy.setActive',{id:state.id,active:false}));
 else if(stage==='refund')await transact('refund',await session.prepareCall('deploy.refund',{id:state.id}));
 else if(stage==='claim'||stage==='release')await transact(stage,{to:ledger,data:encodeFunctionData({abi,functionName:stage,args:stage==='claim'?[state.id,plan.enclave.id]:[state.id]})});
 else throw Error('unknown stage');
}
