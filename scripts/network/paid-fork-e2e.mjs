#!/usr/bin/env node
// Paid Enclave-network providers, end to end against the LIVE Base contracts on a local fork (anvil --fork-url <Base>
// --block-time 2). Nothing here touches Base itself.
//   node scripts/network/paid-fork-e2e.mjs --rpc http://127.0.0.1:18545 --artifact conn.json --abis <dir with the rev-16d ABIs>
// On the fork: deploy EnclaveConnectivity (bootstrap checkers = two fresh keys), bind it to the live ledger and address
// book (the one-time governance step, done here by impersonating the ledger and book owners), register a runner host
// and a paid provider host, create + fund + claim a deployment, the provider offers service on chain and submits both
// checkers' attestations, the owner authorizes that provider (path cap, budget). Then the real code paths settle:
// the host's PaidNetwork meters the circuit's bytes and debits through TunaUSDCSettlement, which gets the provider's
// co-signature over HTTP from the provider's control API (createReceiptCosigner + PeerMeter), and submits settleTuna.
// Checked on chain: bytes served, the owner's budget spent, the provider operator's earnings, the app's balance. Then:
// a receipt for more than the provider observed is refused, and an exhausted budget closes the circuit.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createPublicClient,createWalletClient,http,stringToHex,keccak256,encodeAbiParameters,parseAbi,parseEventLogs} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {base} from 'viem/chains';
import {LeaseReader} from '../../network/lease-reader.mjs';
import {TunaUSDCSettlement} from '../../network/tuna-usdc-settlement.mjs';
import {PaidNetwork} from '../../network/paid-network.mjs';
import {PeerMeter,createReceiptCosigner,receiptToJSON} from '../../network/wg-provider/paid.mjs';
import {createControl} from '../../network/wg-provider/control.mjs';
import {signOnchainQualification,submitAttestations,ensureHost,connectivityAddress} from '../../network/onchain-qualification.mjs';

const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d;};
const rpc=arg('rpc','http://127.0.0.1:18545'),abis=arg('abis');
const BOOK='0xab214342d5A490150A4A977063A2f88E21F80907',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
let failed=0;const ok=(cond,what)=>{console.log(`${cond?'PASS':'FAIL'} ${what}`);if(!cond)failed++;};
const pub=createPublicClient({chain:base,transport:http(rpc)}),pub2=createPublicClient({chain:base,transport:http(rpc)});
const anvil=(method,params)=>pub.request({method,params});
const wallet=a=>createWalletClient({account:a,chain:base,transport:http(rpc)});
const send=async(a,req)=>{const h=await wallet(a).writeContract(req);const r=await pub.waitForTransactionReceipt({hash:h});if(r.status!=='success')throw new Error(`${req.functionName} reverted`);return r;};
const read=(address,abi,functionName,args=[])=>pub.readContract({address,abi,functionName,args});
const json=async f=>JSON.parse(await fs.readFile(path.join(abis,f),'utf8'));
const [ledgerABI,registryABI]=[await json('EnclaveDeployments.abi.json'),await json('EnclaveRegistry.abi.json')];
const bookABI=parseAbi(['function addr(bytes32) view returns (address)','function owner() view returns (address)','function set(bytes32,address)']);
const usdcABI=parseAbi(['function balanceOf(address) view returns (uint256)','function approve(address,uint256) returns (bool)']);
const art=JSON.parse(await fs.readFile(arg('artifact'),'utf8')),k=Object.keys(art.contracts).find(x=>x.endsWith(':EnclaveConnectivity'));
const connABI=art.contracts[k].abi,connBin='0x'+art.contracts[k].bin;
const key=s=>stringToHex(s,{size:32});

const [owner,runnerOp,providerOp,checkerA,checkerB,hostProof,providerProof,gas]=Array.from({length:8},()=>privateKeyToAccount(generatePrivateKey()));
for(const a of [owner,runnerOp,providerOp,gas])await anvil('anvil_setBalance',[a.address,'0x56BC75E2D63100000']);
const LEDGER=await read(BOOK,bookABI,'addr',[key('deployments')]),REGISTRY=await read(BOOK,bookABI,'addr',[key('registry')]);
ok(LEDGER.toLowerCase()==='0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b','the fork reads the live rev-16d ledger from the live address book');

// 1. the contract and the one-time governance binding (impersonated owners)
const h=await wallet(gas).deployContract({abi:connABI,bytecode:connBin,args:[LEDGER,[checkerA.address,checkerB.address]]});
const CONN=(await pub.waitForTransactionReceipt({hash:h})).contractAddress;
for(const [target,who,fn,args] of [[LEDGER,await read(LEDGER,ledgerABI,'owner'),'setBandwidthRouter',[CONN]],[BOOK,await read(BOOK,bookABI,'owner'),'set',[key('connectivity'),CONN]]]){
 await anvil('anvil_impersonateAccount',[who]);await anvil('anvil_setBalance',[who,'0x56BC75E2D63100000']);
 const tx=await createWalletClient({account:who,chain:base,transport:http(rpc)}).writeContract({address:target,abi:target===LEDGER?ledgerABI:bookABI,functionName:fn,args});
 ok((await pub.waitForTransactionReceipt({hash:tx})).status==='success',`governance: ${fn} by ${who.slice(0,10)}`);await anvil('anvil_stopImpersonatingAccount',[who]);
}
ok((await connectivityAddress(pub,BOOK))?.toLowerCase()===CONN.toLowerCase(),'the address book publishes the connectivity contract');

// 2. hosts, a funded deployment, the claim
const reg=async(a,proof)=>{const endpoint=`fork-${a.address.slice(2,10)}.example`;await send(a,{address:REGISTRY,abi:registryABI,functionName:'register',args:[endpoint,'fork',keccak256('0x01'),1n,0n,proof]});return keccak256(stringToHex(endpoint));};
const runnerId=await reg(runnerOp,hostProof.address),providerHostId=await reg(providerOp,providerProof.address);
await anvil('anvil_setStorageAt',[USDC,keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[owner.address,9n])),'0x'+(20_000_000n).toString(16).padStart(64,'0')]);
ok(await read(USDC,usdcABI,'balanceOf',[owner.address])===20_000_000n,'owner holds 20 USDC on the fork');
const created=await send(owner,{address:LEDGER,abi:ledgerABI,functionName:'create',args:['catalog://0x4306e588755347dbb30b5e2090cacbc7e20b00afedff750fe352fe99d6d77a7c/11',0,20,8000,'http:8000',true,'',
 '0x0000000000000000000000000000000000000000',0n,10n**12n]});
const id=parseEventLogs({abi:ledgerABI,logs:created.logs,eventName:'Created'})[0].args.id;
await send(owner,{address:USDC,abi:usdcABI,functionName:'approve',args:[LEDGER,10_000_000n]});
await send(owner,{address:LEDGER,abi:ledgerABI,functionName:'fund',args:[id,10_000_000n]});
await send(runnerOp,{address:LEDGER,abi:ledgerABI,functionName:'claim',args:[id,runnerId]});
ok(true,`deployment ${id.slice(0,10)} created, funded with 10 USDC, claimed by the runner`);

// 3. the provider offers service on chain; both checkers attest; the provider submits; the owner authorizes it
const PRICE=50_000n;   // 0.05 USDC per GiB
ok(await ensureHost({wallet:wallet(providerOp),client:pub,connectivity:CONN,hostId:providerHostId,pricePerGiB6:PRICE}),'provider: setHost (network provider at its price)');
const record={kind:'community',hostId:providerHostId,address:'198.51.100.7'};
const attestations=[];for(const c of [checkerA,checkerB])attestations.push(await signOnchainQualification({account:c,client:pub,connectivity:CONN,record}));
ok(await submitAttestations({wallet:wallet(providerOp),client:pub,connectivity:CONN,hostId:providerHostId,address:record.address,attestations})===2,'provider: both checker attestations submitted');
ok(await submitAttestations({wallet:wallet(providerOp),client:pub,connectivity:CONN,hostId:providerHostId,address:record.address,attestations})===0,'provider: nothing resubmitted while the chain holds them');
const expires=BigInt(Math.floor(Date.now()/1000)+86400),maxPrice=PRICE,budget=1_000_000n;   // 1 USDC
const digest=await read(CONN,connABI,'tunaPolicyDigest',[id,[providerHostId],expires,maxPrice,budget]);
await send(owner,{address:CONN,abi:connABI,functionName:'authorizeTuna',args:[id,[providerHostId],expires,maxPrice,budget,await owner.signMessage({message:{raw:digest}})]});
ok(true,'owner: authorizeTuna (this provider, cap 0.05/GiB, budget 1 USDC, 1 day)');
// rev 16 charges bandwidth only from fully escrowed USDC: the owner backs the app's balance first
const backing=await read(LEDGER,ledgerABI,'bandwidthBackingRequired6',[id]);
await send(owner,{address:USDC,abi:usdcABI,functionName:'approve',args:[LEDGER,backing+1000n]});
await send(owner,{address:LEDGER,abi:ledgerABI,functionName:'fundEscrow',args:[id,backing+1000n]});
ok(await read(LEDGER,ledgerABI,'bandwidthBackingRequired6',[id])===0n,`owner: fundEscrow ${backing+1000n} (the backing the ledger asked for)`);

// 4. the real code paths
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paid-fork-'));
const reader=()=>new LeaseReader({clients:[pub,pub2],chainId:8453,addressBook:BOOK,includeHostPayout:true,includeConnectivity:'auto',maxBlockAgeMs:120000});
const hostLR=reader(),providerLR=reader();
// lease snapshots trail the head by two confirmations
let lease;for(let i=0;i<15;i++){await hostLR.refresh([id]).catch(e=>console.log('lease read: '+e.message));lease=hostLR.get(id);if(lease?.connectivity?.viaTuna&&String(lease.bandwidthBackingRequired6)==='0')break;await new Promise(r=>setTimeout(r,2000));}
if(!lease?.connectivity?.viaTuna)console.log('lease:',JSON.stringify(lease,(k,v)=>typeof v==='bigint'?String(v):v)?.slice(0,1500));
ok(lease?.connectivity?.viaTuna&&lease.connectivity.providers[0]?.qualified===true&&lease.runnerProofKey?.toLowerCase()===hostProof.address.toLowerCase(),'host lease snapshot: on-chain authorization, provider qualified, runner proof key');
ok(String(lease?.bandwidthBackingRequired6)==='0','no extra backing required for bandwidth');
ok((await hostLR.bookAddress('registry'))===REGISTRY.toLowerCase(),'host: the registry for community-provider checks comes from the address book');
let stats={};const kernel={stats:async()=>stats};
const meter=await new PeerMeter({file:path.join(dir,'meter.json'),kernel}).load();
const peers=[{key:'peer1',deploymentId:id,runner:runnerId,paidNonce:String(lease.connectivity.nonce)}];
const receipt=createReceiptCosigner({hostId:providerHostId,proofAccount:providerProof,leaseReader:providerLR,meter,sample:()=>meter.sample(peers)});
const control=await createControl({provider:{handle:async()=>{throw new Error('no peers here');},status:()=>({})},info:()=>({}),receipt,port:0,host:'127.0.0.1'});
let cosigned=0;
const settlement=await new TunaUSDCSettlement({providerId:providerHostId,directory:path.join(dir,'host'),leaseReader:hostLR,proofAccount:hostProof,wallet:wallet(gas),client:pub,maxPending6:'0',
 cosign:async({receipt:r,runnerSignature,anchorHash})=>{const res=await fetch(`http://127.0.0.1:${control.port}/v1/receipt`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receipt:receiptToJSON(r),runnerSignature,anchorHash})});
  const b=await res.json();if(!res.ok)throw new Error(b.error);cosigned++;return b.signature;}}).start();
const paid=new PaidNetwork({directory:path.join(dir,'paid'),leaseReader:hostLR,settlementFor:async()=>settlement});
const GiB=1n<<30n;
const circuit={id:'c1',kind:'network',closed:false,providers:{guard:{pricePerGiB6:0},exit:{pricePerGiB6:Number(PRICE),kind:'community',hostId:providerHostId}},stats:{app:{up:0,down:0}}};
const app={id,circuits:[circuit]};
// the provider observes the tunnel (payload + WireGuard overhead); the host meters the payload: 1.5 GiB
stats={peer1:{rx:Number(GiB),tx:Number(GiB/2n)+4_000_000}};circuit.stats={app:{up:Number(GiB/2n),down:Number(GiB)}};
let refused=await paid.meter([app]);
ok(refused.length===0&&cosigned===1,`host debit settled with the provider's co-signature (${refused[0]?.reason||'ok'})`);
const nonce=lease.connectivity.nonce,bkey=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint64'}],[id,providerHostId,BigInt(nonce)]));
const served=await read(CONN,connABI,'bytesServed',[bkey]),policy=await read(CONN,connABI,'policies',[id]);
ok(served===GiB+GiB/2n,`on chain: bytesServed = ${served} (1.5 GiB)`);
ok(policy[5]===75_000n,`on chain: owner budget spent = ${policy[5]} (1.5 GiB x 0.05 = 0.075 USDC)`);
const earned=await read(LEDGER,ledgerABI,'earned6',[providerOp.address]).catch(()=>null);
ok(earned!==null&&earned>0n,`on chain: provider operator earned ${earned} (its share of 0.075 USDC)`);
// a receipt the provider did not observe is refused (host claims 1 GiB more, provider saw nothing new)
circuit.stats={app:{up:Number(GiB/2n),down:Number(2n*GiB)}};await hostLR.refresh([id]);
refused=await paid.meter([app]);
ok(refused.length===1&&/observed|co-signature/.test(refused[0].reason),`over-claim refused by the provider: ${refused[0]?.reason?.slice(0,90)}`);
ok(await read(CONN,connABI,'bytesServed',[bkey])===GiB+GiB/2n,'on chain: nothing more charged');
// the owner's budget: 1 USDC covers 20 GiB in total; the provider sees and the host claims 30 GiB -> refused, circuit closes
const big=30n*GiB;stats={peer1:{rx:Number(big),tx:0}};const c2={...circuit,id:'c2',stats:{app:{up:0,down:Number(big)}}};
const settlement2=settlement;   // same provider meter
refused=await paid.meter([{id,circuits:[c2]}]);
ok(refused.length===1&&/budget|exhausted/.test(refused[0].reason),`budget exhausted: circuit refused (${refused[0]?.reason?.slice(0,90)})`);
control.close();await settlement2.close().catch(()=>{});
console.log(failed?`${failed} FAILED`:'ALL PASSED');process.exit(failed?1:0);
