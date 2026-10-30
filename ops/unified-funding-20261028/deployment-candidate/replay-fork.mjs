// ONLY an owned local Anvil fork can receive the unsigned proposal. No production signing client or key.
import fs from 'node:fs';import net from 'node:net';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {keccak256,toHex,encodeFunctionData,decodeFunctionResult,parseAbi} from 'viem';
const dir=new URL('./',import.meta.url);const d=JSON.parse(fs.readFileSync(new URL('UNSIGNED-PROPOSAL-r1.json',dir)));
if(d.signable!==false||d.productionApproved!==false||d.chainId!==8453||d.nonceReserved!==false)throw new Error('unexpected proposal');
const pins=JSON.parse(fs.readFileSync(new URL('../relay-owner-candidate/generated/PREPARE-MANIFEST.json',dir))).artifacts;
for(const [name,a] of Object.entries(d.artifacts)){const raw=fs.readFileSync(new URL('../'+a.path,dir));if(crypto.createHash('sha256').update(raw).digest('hex')!==a.sha256||pins['../'+a.path]!==a.sha256)throw new Error('artifact changed '+name);}
const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const port=server.address().port;await new Promise(r=>server.close(r));
const log=fs.openSync(new URL('anvil-r1.log',dir),'wx');
const proc=spawn('/home/steven/.foundry/bin/anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','8453','--hardfork','osaka','--fork-url',d.providers[1],'--fork-block-number',d.block,'--silent'],{stdio:['ignore',log,log],env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});
const url=`http://127.0.0.1:${port}`;
const rpc=async(method,params=[])=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});const j=await r.json();if(j.error)throw new Error(method+': '+JSON.stringify(j.error));return j.result;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));const result={at:new Date().toISOString(),forkOnly:true,productionSigning:false,syntheticEth:true,sourceBlock:d.block,sourceHash:d.blockHash,transactions:[],runtimes:{},verified:false};
try {
 let ready=false;for(let n=0;n<60;n++){if(proc.exitCode!==null)throw new Error('anvil exited');try{const v=await rpc('web3_clientVersion');if(!/anvil/i.test(v))throw new Error('not owned Anvil');ready=true;break;}catch(e){if(n===59)throw e;await pause(250);}}
 if(!ready)throw new Error('Anvil unavailable');
 if(BigInt(await rpc('eth_chainId'))!==8453n)throw new Error('wrong forkchain');
 const b=await rpc('eth_getBlockByNumber',[toHex(BigInt(d.block)),false]);if(b.hash!==d.blockHash)throw new Error('fork sourcehash mismatch');
 if(BigInt(await rpc('eth_getTransactionCount',[d.deployer,'latest']))!==BigInt(d.observedNonce))throw new Error('fork nonce differs from proposal');
 for(const [a,p] of Object.entries(d.bindings)){const code=await rpc('eth_getCode',[a,'latest']);if(keccak256(code)!==p.codehash)throw new Error('fork binding differs '+a);}
 await rpc('anvil_impersonateAccount',[d.deployer]);await rpc('anvil_setBalance',[d.deployer,toHex(10n**19n)]);
 for(const t of d.transactions){if(t.from!==d.deployer||t.to!==null||t.value!=='0'||keccak256(t.data)!==t.dataHash)throw new Error('bad proposaltransaction');
 const params={from:d.deployer,data:t.data,value:'0x0',nonce:toHex(BigInt(t.nonce))};
 const estimate=BigInt(await rpc('eth_estimateGas',[params]));const gas=estimate*125n/100n+20000n;
 const hash=await rpc('eth_sendTransaction',[{...params,gas:toHex(gas)}]);let rc;
 for(let n=0;n<40;n++){rc=await rpc('eth_getTransactionReceipt',[hash]);if(rc)break;await pause(100);}
 if(!rc||rc.status!=='0x1'||rc.contractAddress?.toLowerCase()!==t.predictedAddress.toLowerCase()||!rc.blockHash||BigInt(rc.blockHash)===0n)throw new Error('failed forkdeploy '+t.name);
 const h=await rpc('eth_getBlockByNumber',[rc.blockNumber,false]);if(h.hash!==rc.blockHash||!h.transactions.includes(hash))throw new Error('fork canonicalreceipt mismatch');
 const code=await rpc('eth_getCode',[t.predictedAddress,rc.blockNumber]);if(code==='0x'||(code.length-2)/2>24576)throw new Error('runtime missing/oversize');
 result.transactions.push({name:t.name,address:t.predictedAddress,nonce:t.nonce,estimate:estimate.toString(),gasLimit:gas.toString(),gasUsed:BigInt(rc.gasUsed).toString(),hash,block:rc.blockNumber});result.runtimes[t.name]={address:t.predictedAddress,codehash:keccak256(code),bytes:(code.length-2)/2,code};}
 const abi=parseAbi(['function implementation() view returns(address)','function usdc() view returns(address)','function book() view returns(address)','function router() view returns(address)','function factory() view returns(address)','function keyAttestations() view returns(address)','function maxVault6() view returns(uint256)','function gasAdapter() view returns(address)','function legacyFactory() view returns(address)','function maxEthOut() view returns(uint256)','function reserve() view returns(address)','function ledger() view returns(address)']);
 async function call(to,functionName){return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to,data:encodeFunctionData({abi,functionName})},'latest'])});}
 const imp=await call(d.addresses.FundingSessionVaultFactory,'implementation');if(imp.toLowerCase()!==d.addresses.implementation.toLowerCase())throw new Error('implementation CREATE address differs');
 const code=await rpc('eth_getCode',[imp,'latest']);if((code.length-2)/2!==24543)throw new Error('implementation runtime size differs');result.runtimes.FundingSessionVault={address:imp,codehash:keccak256(code),bytes:(code.length-2)/2,code};
 const expected={book:d.oldBindings.book,router:d.oldBindings.router,keyAttestations:d.oldBindings.keyAttestations,maxVault6:d.oldBindings.maxVault6,gasAdapter:d.addresses.LeaseGasDexAdapter,legacyFactory:d.oldBindings.oldFactory,factory:d.addresses.FundingSessionVaultFactory};
 for(const [f,want]of Object.entries(expected))if(String(await call(imp,f)).toLowerCase()!==String(want).toLowerCase())throw new Error('implementation '+f+' differs');
 if(String(await call(d.addresses.LeaseGasDexAdapter,'maxEthOut'))!==d.limits.adapterMaxEthOut)throw new Error('adapter cap differs');
 for(const [a,p] of Object.entries(d.bindings))if(keccak256(await rpc('eth_getCode',[a,'latest']))!==p.codehash)throw new Error('old runtime changed');
 result.verified=true;result.note='Exact provisional deployment bytecode replay on an owned local Base fork only. Libraries linked, new constructor bindings checked, old runtimes unchanged. No production deployment or signatures. Proposal nonce and dependency states must be refreshed before owner review. Runtime hashes are tied to these exact predicted addresses.';
}catch(e){result.error=e.stack;process.exitCode=1;}
finally {proc.kill('SIGTERM');await Promise.race([new Promise(r=>proc.once('exit',r)),pause(3000)]);if(proc.exitCode===null)proc.kill('SIGKILL');fs.closeSync(log);result.ownedAnvilExitCode=proc.exitCode;fs.writeFileSync(new URL('FORK-REPLAY-r1.json',dir),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({verified:result.verified,error:result.error?.split('\n')[0],transactions:result.transactions.length}));}
