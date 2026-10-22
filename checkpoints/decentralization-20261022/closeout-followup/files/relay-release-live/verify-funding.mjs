import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)), work=path.resolve(here,'../..');
const req=createRequire(path.join(work,'wallet-handoff-bridge/tree/cli/independent.mjs'));
const {createPublicClient,http,decodeEventLog,keccak256,parseAbi}=await import(req.resolve('viem'));
const {base}=await import(req.resolve('viem/chains'));
const {QuorumChain}=await import(path.join(work,'wallet-handoff-bridge/tree/cli/independent.mjs'));
const {boundedFetch}=await import(path.join(work,'wallet-handoff-bridge/tree/network/authority-profile.mjs'));
const {serialPeers}=await import('../queued-funding-small/serial-fetch.mjs');
const manifest=JSON.parse(fs.readFileSync(path.join(here,'../queued-funding-small/manifest.json')));
const hash='0x3748c0e42c3a37a1ce5d2ebfef9bc3fd8f5bd1246dc36a06a7a256bc2e2446e7';
const reserve='0x12a3f873041dec436daa0085b766a399a6fa3639';
const multi='0xca11bde05977b3631167028862be2a173976ca11';
const owner='0x0b2d009c0c9af05b12100d77f3c815fea822ee61';
const peers=serialPeers({rpcs:['https://mainnet.base.org','https://base-rpc.polkachu.com','https://base-rpc.publicnode.com'],createPublicClient,viemHttp:http,chain:base,boundedFetch});
const chain=new QuorumChain({clients:peers,quorum:2,confirmations:2,maxBlockAgeMs:120000,chainId:8453});
const s=await chain.snapshot(async c=>({receipt:await c.getTransactionReceipt({hash}),tx:await c.getTransaction({hash})}));
const {receipt:r,tx}=s.value;
function check(v,msg){if(!v)throw Error(msg);}
check(r.status==='success'&&r.blockNumber<=s.blockNumber,'unconfirmed receipt');
check(tx.from.toLowerCase()===owner&&tx.to.toLowerCase()===multi&&tx.value===1000000000000000n&&tx.nonce===1144,'transaction differs');
check(keccak256(tx.input)==='0xb51be0cc4af00548dd53762a47d4f6ae76231b91585e8b534ef415b1d6c32456','calldata differs');
const abi=parseAbi(['event Deposited(bytes32 indexed id,address indexed owner,address indexed from,uint256 amountWei)']);
const want=new Map(manifest.rows.map(x=>[x.id.toLowerCase(),x])),seen=new Set(),events=[];
for(const l of r.logs){
 if(l.address.toLowerCase()!==reserve)continue;
 const e=decodeEventLog({abi,data:l.data,topics:l.topics}),a=e.args,row=want.get(a.id.toLowerCase());
 check(row&&!seen.has(a.id),'unexpected or duplicate deposit');
 check(a.owner.toLowerCase()===row.currentOwner.toLowerCase()&&a.from.toLowerCase()===multi&&a.amountWei===100000000000000n,'deposit differs');
 seen.add(a.id);events.push({id:a.id,owner:a.owner,amountWei:String(a.amountWei)});
}
check(seen.size===10,'missing deposits');
const out={at:new Date().toISOString(),status:'CONFIRMED_TEN_DEPOSITS',hash,block:String(r.blockNumber),verifiedAtBlock:String(s.blockNumber),agreeing:s.agreeing,peers:s.peers,valueWei:String(tx.value),gasUsed:String(r.gasUsed),effectiveGasPrice:String(r.effectiveGasPrice),l2FeeWei:String(r.gasUsed*r.effectiveGasPrice),deposits:events};
fs.writeFileSync(path.join(here,'funding-confirmed.json'),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(out,null,2));
