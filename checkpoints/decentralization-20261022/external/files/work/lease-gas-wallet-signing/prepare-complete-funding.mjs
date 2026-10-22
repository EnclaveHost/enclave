import fs from 'node:fs';
import assert from 'node:assert/strict';
import {toHex} from '../enclave/node_modules/viem/_esm/index.js';
import {clientsFor} from './rpc-clients.mjs';
import {PRODUCTION} from './trust.mjs';
const p=JSON.parse(fs.readFileSync('outputs/app-lease-gas-review/enrollment-bootstrap-proposal.json'));
const ids=JSON.parse(fs.readFileSync('outputs/app-lease-gas-review/lease-relay-identities.json')).identities;
assert.equal(ids.length,2);assert.notEqual(ids[0].address.toLowerCase(),ids[1].address.toLowerCase());
const transfers=ids.map(x=>({action:'Initial lease relay working balance',host:x.host,from:PRODUCTION.admin,to:x.address,value:toHex(100000000000000n),data:'0x',gas:'0x10000'}));
const clients=clientsFor(PRODUCTION.rpcs);const heads=await Promise.all(clients.map(c=>c.getBlockNumber()));const block=heads.reduce((a,b)=>a<b?a:b)-2n;
const results=await Promise.all(clients.map(async c=>{
 assert.equal(await c.getChainId(),8453);const anchor=await c.getBlock({blockNumber:block});
 for(const x of ids){assert.equal((await c.getCode({address:x.address,blockNumber:block}))||'0x','0x');assert.equal(await c.getBalance({address:x.address,blockNumber:block}),0n);}
 const balance=await c.getBalance({address:PRODUCTION.admin,blockNumber:block});assert.ok(balance>=1400000000000000n);
 const calls=[...p.operations.map(({app,action,...x})=>x),...transfers.map(({action,host,...x})=>x)];
 const sim=await c.request({method:'eth_simulateV1',params:[{blockStateCalls:[{calls}],validation:false,traceTransfers:false},toHex(block)]});
 assert.equal(sim[0].calls.length,25);sim[0].calls.forEach((x,i)=>assert.equal(x.status,'0x1','operation '+i+' failed '+JSON.stringify(x.error)));
 assert.equal((await c.getBlock({blockNumber:block})).hash,anchor.hash);
 return {blockHash:anchor.hash,balanceWei:String(balance),gas:sim[0].calls.map(x=>String(BigInt(x.gasUsed)))};
}));assert.deepEqual(results[0],results[1]);
const out={status:'PROPOSAL; user budget approval required; nothing sent',chainId:8453,from:PRODUCTION.admin,checkedAt:new Date().toISOString(),block:String(block),...results[0],appDepositsEth:'0.0011',relayWorkingBalancesEth:'0.0002',totalEth:'0.0013',transactionFees:'additional',operations:[...p.operations,...transfers],relayNote:'Each new relay receives0.0001ETH working capital and is reimbursed by app reserves for successful lease operations. Failed/reverted relay transactions still consume that working capital. These are business service wallets, not host operator top-ups.'};
fs.writeFileSync('outputs/app-lease-gas-review/complete-bootstrap-funding-proposal.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:out.status,operations:25,totalEth:out.totalEth,block:out.block}));
