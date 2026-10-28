// READ ONLY on Base. Produces provisional unsigned deployment data; never signs or broadcasts.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {encodeDeployData,encodeFunctionData,decodeFunctionResult,getContractAddress,keccak256,parseAbi,toHex} from 'viem';
const root=new URL('../session-candidate/out/',import.meta.url);
const OWNER='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const LEGACY='0xB794C4DD0e1C5E6B72281799F282BfdE7654345D';
const OLD_FACTORY='0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',WETH='0x4200000000000000000000000000000000000006';
const DEX_ROUTER='0x2626664c2603336E57B271c5C0b26F421741e481',DEX_FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const LEDGER='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',RESERVE='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
const providers=['https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'];
const request=providers.map(url=>async(method,params)=>{if(!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_call','eth_getCode','eth_getTransactionCount','eth_getBalance'].includes(method))throw new Error('read-only RPC allowlist');const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result;});
const equal=(values,label)=>{if(values.some(v=>JSON.stringify(v)!==JSON.stringify(values[0])))throw new Error(label+' quorum mismatch');return values[0];};
const ids=await Promise.all(request.map(r=>r('eth_chainId',[])));if(equal(ids,'chain')!=='0x2105')throw new Error('not Base');
const heads=await Promise.all(request.map(r=>r('eth_blockNumber',[])));const block=heads.map(BigInt).reduce((a,b)=>a<b?a:b)-2n;
const headers=await Promise.all(request.map(r=>r('eth_getBlockByNumber',[toHex(block),false])));const hash=equal(headers.map(h=>h.hash),'blockhash');
const at={blockHash:hash,requireCanonical:true};
const abi=parseAbi(['function usdc() view returns(address)','function book() view returns(address)','function router() view returns(address)','function keyAttestations() view returns(address)','function maxVault6() view returns(uint256)','function implementation() view returns(address)','function owner() view returns(address)']);
async function read(to,functionName){const replies=await Promise.all(request.map(r=>r('eth_call',[{to,data:encodeFunctionData({abi,functionName})},at])));return decodeFunctionResult({abi,functionName,data:equal(replies,functionName)});}
if((await read(LEGACY,'owner')).toLowerCase()!==OWNER.toLowerCase())throw new Error('legacy owner changed');
if((await read(LEGACY,'usdc')).toLowerCase()!==USDC.toLowerCase())throw new Error('legacy token changed');
const book=await read(LEGACY,'book'),router=await read(LEGACY,'router'),keyAttestations=await read(LEGACY,'keyAttestations'),maxVault6=await read(LEGACY,'maxVault6');
const oldImplementation=await read(OLD_FACTORY,'implementation');
const nonce=BigInt(equal(await Promise.all(request.map(r=>r('eth_getTransactionCount',[OWNER,'pending']))),'pendingnonce'));
const latestNonce=BigInt(equal(await Promise.all(request.map(r=>r('eth_getTransactionCount',[OWNER,'latest']))),'latestnonce'));
if(nonce!==latestNonce)throw new Error('administrator has pending transactions; no proposal');
const bindings={};for(const address of [...new Set([USDC,WETH,DEX_ROUTER,DEX_FACTORY,LEDGER,RESERVE,LEGACY,OLD_FACTORY,oldImplementation,book,router,keyAttestations])]){if(BigInt(address)===0n)continue;const code=equal(await Promise.all(request.map(r=>r('eth_getCode',[address,at]))),'runtime '+address);if(code==='0x')throw new Error('missing binding');bindings[address]={codehash:keccak256(code),bytes:(code.length-2)/2};}
const names=['FundingSessionVaultLib','FundingGasLib','LeaseGasDexAdapter','FundingSessionVaultFactory'];
const locations=['FundingSessionVault.sol','FundingGasLib.sol','LeaseGasDexAdapter.sol','FundingSessionVault.sol'];
const addresses=Object.fromEntries(names.map((name,i)=>[name,getContractAddress({from:OWNER,nonce:nonce+BigInt(i)})]));
function link(a){let b=a.bytecode.object.slice(2);for(const libs of Object.values(a.bytecode.linkReferences??{}))for(const [name,refs] of Object.entries(libs)){const address=addresses[name];if(!address)throw new Error('unapproved library '+name);for(const {start,length} of refs){if(length!==20)throw new Error('unexpected link size');b=b.slice(0,start*2)+address.slice(2).toLowerCase()+b.slice((start+length)*2);}}if(!/^[0-9a-fA-F]+$/.test(b))throw new Error('unresolved link');return '0x'+b;}
const transactions=[];const artifacts={};
for(let i=0;i<names.length;i++){const name=names[i],file=new URL(`${locations[i]}/${name}.json`,root),raw=fs.readFileSync(file),a=JSON.parse(raw);const metadata=typeof a.metadata==='string'?JSON.parse(a.metadata):a.metadata;const s=metadata.settings;if(!metadata.compiler.version.startsWith('0.8.35+')||!s.viaIR||s.optimizer.runs!==1||s.metadata.bytecodeHash!=='none'||s.evmVersion!=='osaka')throw new Error('unexpected release build');
 const args=name==='LeaseGasDexAdapter'?[USDC,WETH,DEX_ROUTER,DEX_FACTORY,LEDGER,RESERVE,1000000000000000n]:name==='FundingSessionVaultFactory'?[USDC,book,router,keyAttestations,maxVault6,addresses.LeaseGasDexAdapter,OLD_FACTORY]:[];
 const data=encodeDeployData({abi:a.abi,bytecode:link(a),args});const runtimeBytes=(a.deployedBytecode.object.length-2)/2;if(runtimeBytes>24576||(data.length-2)/2>49152)throw new Error('deployment size limit');
 transactions.push({name,chainId:8453,from:OWNER,to:null,value:'0',nonce:(nonce+BigInt(i)).toString(),data,dataHash:keccak256(data),predictedAddress:addresses[name],constructorArgs:args,gas:null,maxFeePerGas:null,maxPriorityFeePerGas:null});
 artifacts[name]={path:`session-candidate/out/${locations[i]}/${name}.json`,sha256:crypto.createHash('sha256').update(raw).digest('hex'),runtimeTemplateBytes:runtimeBytes,initcodeBytes:(data.length-2)/2,compiler:metadata.compiler,settings:s};}
const implementation=getContractAddress({from:addresses.FundingSessionVaultFactory,nonce:1n});
const out={schema:'enclave-funding-deployment-proposal/v1',createdAt:new Date().toISOString(),productionApproved:false,signable:false,chainId:8453,providers,block:block.toString(),blockHash:hash,deployer:OWNER,observedNonce:nonce.toString(),nonceReserved:false,bindings,oldBindings:{book,router,keyAttestations,maxVault6,oldImplementation,oldFactory:OLD_FACTORY,oldVault:LEGACY},addresses:{...addresses,implementation},transactions,artifacts,limits:{adapterMaxEthOut:'1000000000000000',note:'Per-call immutable adapter cap. Each new grant uses a narrower explicit cap.'},required:['Exact sequential replay on owned Base fork and byte-for-byte runtime recording','Fresh dependency/nonces/state checks immediately before approval','Concrete bounded deployment gas/fees and total owner cost','Owner signatures: old immutable P256 session cannot deploy','New explicit owner grant and budget migration review','Composed successor host integration and canary before activation'],preserve:['No existing factory/address-book entries replaced','No old session ended','No assets moved','No production services restarted']};
fs.writeFileSync(new URL('./UNSIGNED-PROPOSAL-r1.json',import.meta.url),JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({prepared:true,signable:false,block:out.block,nonce:out.observedNonce,transactions:transactions.map(({name,predictedAddress})=>({name,predictedAddress}))}));
