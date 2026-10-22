import fs from "node:fs";
import {createQuorumReader} from "./enclave/site/js/core/quorum.js";
import {readAddressBook} from "./enclave/site/js/core/addressbook-reader.js";
const reader=createQuorumReader({
  rpcs:["https://base-rpc.publicnode.com","https://mainnet.base.org","https://base.public.blockpi.network/v1/rpc/public"],
  quorum:2,chainId:8453,
});
const result=await readAddressBook(reader,"0xab214342d5a490150a4a977063a2f88e21f80907");
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v,2);
const report={at:new Date().toISOString(),mode:"read-only; original deployed address book",...result};
fs.mkdirSync("outputs/addressbook-compatibility",{recursive:true});
fs.writeFileSync("outputs/addressbook-compatibility/live.json",stringify(report)+"\n");
console.log(stringify({block:result.snapshot.number,owner:result.owner,entries:Object.keys(result.entries).length}));
