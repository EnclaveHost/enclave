#!/usr/bin/env node
// Defaults to a reviewable transaction plan. --execute uses an explicitly
// selected operator/owner key file; no key is inferred from another service.
import fs from 'node:fs/promises';
import {createPublicClient,createWalletClient,http,parseAbi,stringToHex,encodeFunctionData,parseUnits} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {base} from 'viem/chains';
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i<0?d:process.argv[i+1];};
const command=process.argv[2],id=arg('--id'),execute=process.argv.includes('--execute');
if(!['inspect','host','direct','tuna','revoke'].includes(command)||!/^0x[0-9a-f]{64}$/.test(id||''))throw Error('usage: connectivity.mjs inspect|host|direct|tuna|revoke --id 0x… [--mode compute|direct|tuna|both] [--providers 0xID,0xID] [--price USDC/GiB --budget USDC --days 1] [--execute --key-file PATH]');
const rpc=arg('--rpc','https://base-rpc.publicnode.com,https://base.drpc.org').split(',');
if(rpc.length<2||new Set(rpc.map(u=>new URL(u).hostname)).size!==rpc.length||rpc.some(u=>!u.startsWith('https://')))throw Error('independent HTTPS RPCs required');
const clients=rpc.map(u=>createPublicClient({chain:base,transport:http(u,{timeout:15000})}));
const book=arg('--book','0xab214342d5A490150A4A977063A2f88E21F80907');
const abi=parseAbi(['function addr(bytes32) view returns (address)','function ledger() view returns (address)',
 'function hosts(bytes32) view returns (bool,bool,uint64,uint64,bytes32,address,address)',
 'function policies(bytes32) view returns (address,uint64,uint64,uint64,uint128,uint128,uint16)',
 'function viaTuna(bytes32) view returns (bool)',
 'function tunaProviders(bytes32) view returns (bytes32[])',
 'function tunaPolicyDigest(bytes32,bytes32[],uint64,uint64,uint128) view returns (bytes32)',
 'function authorizeTuna(bytes32,bytes32[],uint64,uint64,uint128,bytes)',
 'function qualified(bytes32) view returns (bool)',
 'function setHost(bytes32,bool,bool,uint64)',
 'function policyDigest(bytes32,uint64,uint64,uint128) view returns (bytes32)',
 'function authorizeDirect(bytes32,uint64,uint64,uint128,bytes)', 'function revokeDirect(bytes32)']);
const heads=await Promise.all(clients.map(async c=>{if(await c.getChainId()!==8453)throw Error('wrong chain');return c.getBlockNumber({cacheTime:0});}));
const blockNumber=heads.reduce((a,b)=>a<b?a:b)-2n;
const blocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber})));
if(blocks.some(b=>b.hash!==blocks[0].hash)||Date.now()/1000-Number(blocks[0].timestamp)>90)throw Error('no fresh agreeing chain');
const json=v=>JSON.stringify(v,(_k,n)=>typeof n==='bigint'?String(n):n);
async function read(address,functionName,args=[]){const values=await Promise.all(clients.map(c=>c.readContract({address,abi,functionName,args,blockNumber})));if(values.some(v=>json(v)!==json(values[0])))throw Error('chain read disagreement');return values[0];}
const connectivity=await read(book,'addr',[stringToHex('connectivity',{size:32})]),ledger=await read(book,'addr',[stringToHex('deployments',{size:32})]);
if(/^0x0{40}$/i.test(connectivity))throw Error('connectivity contract is not active in the address book');
if((await read(connectivity,'ledger')).toLowerCase()!==ledger.toLowerCase())throw Error('connectivity ledger mismatch');
if(command==='inspect'){console.log(json({blockNumber,connectivity,ledger,host:await read(connectivity,'hosts',[id]),policy:await read(connectivity,'policies',[id]),viaTuna:await read(connectivity,'viaTuna',[id]),providers:await read(connectivity,'tunaProviders',[id]),qualified:await read(connectivity,'qualified',[id])}));process.exit(0);}
const money=(s,bits)=>{if(!/^(0|[1-9]\d{0,20})(\.\d{1,6})?$/.test(s||''))throw Error('explicit nonnegative USDC amount with at most 6 decimals required');const n=parseUnits(s,6);if(n>=1n<<BigInt(bits))throw Error('amount out of range');return n;};
let functionName,args,digest;
if(command==='host'){
 const mode=arg('--mode');if(!['compute','direct','tuna','both'].includes(mode))throw Error('host mode required');
 if(mode!=='compute'&&!await read(connectivity,'qualified',[id]))throw Error('host has not passed current independent provider qualification');
 functionName='setHost';args=[id,['direct','both'].includes(mode),['tuna','both'].includes(mode),money(arg('--price','0'),64)];
}else if(command==='revoke'){functionName='revokeDirect';args=[id];}
else {
 const days=Number(arg('--days','1'));if(!Number.isFinite(days)||days<=0||days>30)throw Error('authorization lasts at most 30 days');
 args=[id,BigInt(Math.floor(Date.now()/1000+days*86400)),money(arg('--price'),64),money(arg('--budget'),128)];
 if(command==='tuna'){
  const providers=arg('--providers','').split(',');
  if(providers.length<1||providers.length>6||providers.some(p=>!/^0x[0-9a-f]{64}$/.test(p)||/^0x0{64}$/.test(p))||new Set(providers).size!==providers.length)throw Error('TUNA requires 1 to 6 distinct authorized provider IDs');
  args.splice(1,0,providers);digest=await read(connectivity,'tunaPolicyDigest',args);functionName='authorizeTuna';
 }else{digest=await read(connectivity,'policyDigest',args);functionName='authorizeDirect';}
}
let wallet;
if(execute){const keyFile=arg('--key-file');if(!keyFile)throw Error('--execute requires the chosen owner/operator --key-file');const account=privateKeyToAccount((await fs.readFile(keyFile,'utf8')).trim());wallet=createWalletClient({account,chain:base,transport:http(rpc[0])});}
if(digest){const file=arg('--signature-file');const signature=file?(await fs.readFile(file,'utf8')).trim():wallet?await wallet.account.signMessage({message:{raw:digest}}):null;
 if(!signature){console.log(json({chainId:8453,to:connectivity,functionName,args,personalSignDigest:digest,ledger,blockNumber,execute:false}));process.exit(0);}args.push(signature);}
const data=encodeFunctionData({abi,functionName,args});
if(!execute){console.log(json({chainId:8453,to:connectivity,data,value:'0x0',ledger,blockNumber,execute:false}));process.exit(0);}
const gas=await clients[0].estimateContractGas({account:wallet.account,address:connectivity,abi,functionName,args});
const hash=await wallet.sendTransaction({to:connectivity,data,gas:gas*125n/100n+10000n});
console.log(json({submitted:hash}));const receipt=await clients[0].waitForTransactionReceipt({hash,confirmations:2});
if(receipt.status!=='success')throw Error('connectivity transaction reverted');console.log(json({confirmed:hash,block:receipt.blockNumber}));

if(command==='host'&&arg('--config')){
 const file=arg('--config'),cfg=JSON.parse(await fs.readFile(file,'utf8'));
 if(cfg.runner?.toLowerCase()!==id)throw Error('local runtime belongs to another host');
 cfg.connectivity={version:1,direct:args[1],tunaProvider:args[2],pricePerGiB6:String(args[3])};
 if(cfg.connectivity.direct&&!cfg.direct)throw Error('host enabled on-chain; configure its direct listeners and independent probe before starting service');
 await fs.copyFile(file,file+'.before-connectivity');await fs.writeFile(file+'.tmp',JSON.stringify(cfg,null,2),{mode:0o600});await fs.rename(file+'.tmp',file);
 console.log(JSON.stringify({runtimeConfigUpdated:true,restartRequired:true}));
}
