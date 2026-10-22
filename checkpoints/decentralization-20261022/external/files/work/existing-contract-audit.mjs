// Read-only audit: no account, key, signing, or write RPC method.
import fs from 'node:fs';
import {createPublicClient, http, parseAbi, keccak256, hexToString, encodeFunctionData} from './enclave/node_modules/viem/_esm/index.js';
import {agreedRead} from './enclave/network/service-index.mjs';
const profile = JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/network-profile-base.json'));
const manifest = JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/source-verification-base.json'));
const book = profile.contracts.legacySessionVaultImplementation.immutable.book;
const allowed = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call']);
const safeFetch = (url, init) => {
  for (const req of [JSON.parse(init.body)].flat()) {
    if (!allowed.has(req.method)) throw Error('Forbidden RPC: '+req.method);
  }
  return fetch(url, init);
};
const urls = ['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public'];
const peers = urls.map(url => ({label: url, client: createPublicClient({transport:http(url,{fetchFn:safeFetch, timeout:12000,retryCount:0})})}));
const abi = parseAbi([
  'function all() view returns (bytes32[],address[])',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function set(bytes32,address)',
]);
const result = await agreedRead({peers,chainId:8453,deadlineMs:60000,requestTimeoutMs:12000,
  read:async(c,blockNumber,call)=>{
    const [entries,owner] = await Promise.all(['all','owner'].map(functionName=>
      call(functionName,()=>c.readContract({address:book,abi,functionName,blockNumber}))));
    const bookEntries = Object.fromEntries(entries[0].map((k,i)=>[hexToString(k,{size:32}),entries[1][i].toLowerCase()]));
    const runtimes={};
    // Bounded concurrency per RPC.
    const list=Object.entries(manifest.contracts);
    for(let i=0;i<list.length;i+=3) await Promise.all(list.slice(i,i+3).map(async([name,expected])=>{
      const code=await call(name,()=>c.getCode({address:expected.address,blockNumber}));
      const hash=code&&keccak256(code);
      if(hash!==expected.codeHash)throw Error(name+': changed runtime');
      runtimes[name]={address:expected.address,codeHash:hash,matchesHistoricalSource:true};
    }));
    const key=entries[0][0], value=entries[1][0];
    const data=encodeFunctionData({abi,functionName:'set',args:[key,value]});
    await call('admin-book-set',()=>c.call({account:owner,to:book,data,blockNumber}));
    let rejected=false;
    try{await call('stranger-book-set',()=>c.call({account:'0x000000000000000000000000000000000000dead',to:book,data,blockNumber}));}
    catch(e){if(/revert/i.test(e.message))rejected=true;else throw e;}
    if(!rejected)throw Error('unauthorized address-book setter accepted');
    return {book:{address:book,owner,entries:bookEntries,adminSetSimulationAccepted:true,unauthorizedSetRejected:true,
      note:'pendingOwner() reverted on all three RPCs in the initial audit; current repository address-book ABI is not assumed to equal this deployed version.'},
      runtimes:Object.fromEntries(Object.entries(runtimes).sort(([a],[b])=>a.localeCompare(b)))};
  }});
const report={checkedAt:new Date().toISOString(),mode:'read-only; eth_call simulations only',block:String(result.blockNumber),
  agreeingRPCs:result.evidence.peers.filter(p=>p.status==='agreed').map(p=>p.label),...result.value};
fs.mkdirSync('outputs/contract-change-audit',{recursive:true});
fs.writeFileSync('outputs/contract-change-audit/live.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({block:report.block,matchedRuntimes:Object.keys(report.runtimes).length,
  book:report.book.address,owner:report.book.owner,entries:report.book.entries}));
