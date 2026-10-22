import fs from "node:fs";
import {QuorumChain} from "./enclave/cli/independent.mjs";
import {LEDGER_ABI, REGISTRY_V4_ABI} from "./enclave/custody/v2/chain.mjs";

const book = "0xab214342d5a490150a4a977063a2f88e21f80907";
const zero = "0x" + "00".repeat(20);
const zeroId = "0x" + "00".repeat(32);
const bookAbi = [{type:"function",name:"addr",stateMutability:"view",
  inputs:[{type:"bytes32"}],outputs:[{type:"address"}]}];
const scalar = (name, type, inputs=[]) => ({
  type:"function",name,stateMutability:"view",inputs,outputs:[{type}],
});
const abi = [...LEDGER_ABI, scalar("count","uint256"), scalar("leaseSec","uint64"),
  scalar("ownerEscrow6","uint256",[{type:"bytes32"}]),
  {type:"function",name:"getPage",stateMutability:"view",
    inputs:[{type:"uint256"},{type:"uint256"}],
    outputs:[{type:"tuple[]",components:LEDGER_ABI[0].outputs[0].components}]}];
const key = name => "0x" + Buffer.from(name).toString("hex").padEnd(64,"0");
const chain = new QuorumChain({
  rpcs:["https://base-rpc.publicnode.com","https://mainnet.base.org",
    "https://base.public.blockpi.network/v1/rpc/public"],
  quorum:2, confirmations:2, timeoutMs:15000,
});
const snap = await chain.snapshot(async (client, blockNumber) => {
  const read=(address,abi,functionName,args=[]) =>
    client.readContract({address,abi,functionName,args,blockNumber});
  const [ledger,registry]=await Promise.all(["deployments","registry"].map(
    name=>read(book,bookAbi,"addr",[key(name)])));
  if ([ledger,registry].some(a=>a.toLowerCase()===zero)) throw Error("Missing platform binding");
  const [count,leaseSec,block]=await Promise.all([
    read(ledger,abi,"count"),read(ledger,abi,"leaseSec"),client.getBlock({blockNumber}),
  ]);
  if(count>5000n)throw Error("Inventory exceeds bounded scan");
  const records=[];
  for(let start=0n;start<count;start+=100n){
    const page=await read(ledger,abi,"getPage",[start,100n]);
    if(BigInt(page.length)!==(count-start<100n?count-start:100n))throw Error("Incomplete page");
    records.push(...page.filter(d=>d.active));
  }
  const hosts=new Map();
  for(const id of new Set(records.map(d=>d.runner).filter(id=>id!==zeroId))){
    hosts.set(id,await read(registry,REGISTRY_V4_ABI,"get",[id]));
  }
  const rows=[];
  for(const d of records){
    const host=hosts.get(d.runner);
    const selfHosted=!!host && host.payoutWallet.toLowerCase()===d.owner.toLowerCase();
    if(!selfHosted)continue;
    rows.push({
      id:d.id,appRef:d.appRef,owner:d.owner,runner:d.runner,
      operator:host.operator,registryActive:host.active,
      ownerMatchesHostPayout:true,active:d.active,
      liveLease:d.leaseUntil>=block.timestamp,leaseUntil:d.leaseUntil,
      rate6:d.rate,balance6:d.balance6,
      ownerEscrow6:await read(ledger,abi,"ownerEscrow6",[d.id]),
    });
  }
  return {ledger,registry,totalDeployments:count,activeDeployments:records.length,
    leaseSec,selfHostedDeployments:rows};
});
const report={
  checkedAt:new Date().toISOString(),readOnly:true,book,
  block:snap.blockNumber,blockHash:snap.blockHash,agreeing:snap.agreeing,
  ...snap.value,
  limitations:[
    "Live lease means a chain lease has not expired; it does not prove the app is responding.",
    "Self-hosting is classified using the deployed ledger's owner == host payoutWallet rule.",
    "No app gas reserve has been enrolled or funded by this inventory.",
    "Ledger balance6 and ownerEscrow6 are not authorization for a new paymaster to withdraw.",
  ],
};
const text=JSON.stringify(report,(_,v)=>typeof v==="bigint"?v.toString():v,2);
fs.writeFileSync("outputs/storage-adapter-incident/self-hosted-inventory.json",text+"\n");
console.log(text);
