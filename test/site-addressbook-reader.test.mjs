import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { createQuorumReader } from "../site/js/core/quorum.js";
import { decodeAddressBook, readAddressBook } from "../site/js/core/addressbook-reader.js";

const addr = n => "0x" + n.toString(16).padStart(40, "0");
const key = s => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
const word = n => BigInt(n).toString(16).padStart(64, "0");
const encode = entries => encodeAbiParameters([{type:"bytes32[]"}, {type:"address[]"}],
  [entries.map(([k]) => key(k)), entries.map(([,v]) => v)]);
const entries = [["registry",addr(1)],["deployments",addr(2)],["appCatalog",addr(3)]];
const NOW = 1800000000, HASH = "0x" + "ab".repeat(32), ROOT = addr(99);
function rig(){
  const state = { a:{}, b:{}, c:{} }, calls = [];
  const rpc = async (url, method, params) => {
    const s = state[url]; calls.push({url,method,params});
    if (s.down) throw Error("offline");
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getBlockByNumber") return {number:params[0],hash:HASH,timestamp:"0x"+NOW.toString(16)};
    if (method === "eth_getCode") return s.noCode === params[0] ? "0x" : "0x6080";
    if (method === "eth_call"){
      if (params[0].data === "0x8da5cb5b") return s.owner || "0x" + word(77);
      assert.equal(params[0].data,"0x10c4e8b0");
      return s.raw || encode(s.entries || entries);
    }
    throw Error("unexpected method: " + method);
  };
  return {state,calls,reader:createQuorumReader({rpcs:["a","b","c"],quorum:2,confirmations:2,
    chainId:8453,maxBlockAgeSeconds:600,now:()=>NOW,rpc})};
}

test("original all() ABI retains optional retirements and cannot pollute object prototypes",()=>{
  const map=decodeAddressBook(encode([...entries,["reviews",addr(0)],["__proto__",addr(8)]]));
  assert.equal(map.deployments,addr(2));
  assert.equal(map.reviews,addr(0));
  assert.equal(map.__proto__,addr(8));
  assert.equal(Object.getPrototypeOf(map),null);
  assert.ok(Object.isFrozen(map));
});

test("malformed, overlapping, truncated and duplicate maps are rejected",()=>{
  const raw=encode(entries);
  const change=(i,value)=>raw.slice(0,2+i*64)+value+raw.slice(2+(i+1)*64);
  for (const bad of ["0x",raw.slice(0,-2),raw+"00".repeat(32),
    change(0,word(32)),change(1,word(64)),change(2,"f".repeat(64)),
    change(6,word(2)),change(7,"1".repeat(64)),
    change(3,"72650076"+"0".repeat(56)),encode([...entries,entries[0]])])
    assert.throws(()=>decodeAddressBook(bad),/Address book/);
});

test("admin updates resolve through the original book with the first RPC offline",async()=>{
  const {reader,state,calls}=rig();
  const before=await readAddressBook(reader,ROOT);
  assert.equal(before.owner,addr(77));
  state.a.down=true;
  state.b.entries=state.c.entries=[...entries.slice(0,2),["appCatalog",addr(30)]];
  const after=await readAddressBook(reader,ROOT);
  assert.equal(before.entries.appCatalog,addr(3),"the prior snapshot is immutable");
  assert.equal(after.entries.appCatalog,addr(30),"admin-selected replacement is followed");
  for (const call of calls.filter(c=>["eth_call","eth_getCode"].includes(c.method)))
    assert.deepEqual(call.params[1],{blockHash:HASH},"every binding and code read uses the same block hash");
});

test("one dishonest endpoint cannot select a replacement; loss of quorum has no cached fallback",async()=>{
  const {reader,state}=rig();
  state.a.entries=[...entries.slice(0,2),["appCatalog",addr(66)]];
  assert.equal((await readAddressBook(reader,ROOT)).entries.appCatalog,addr(3));
  state.b.down=true;
  await assert.rejects(readAddressBook(reader,ROOT),/disagree/);
  state.c.down=true;
  await assert.rejects(readAddressBook(reader,ROOT),/only 1/);
});

test("missing, retired or codeless core bindings fail as a whole",async()=>{
  for (const changes of [
    {entries:entries.slice(0,2)},
    {entries:[...entries.slice(0,2),["appCatalog",addr(0)]]},
    {noCode:addr(2)}, {noCode:ROOT}, {owner:"0x"+word(0)}, {raw:"0x1234"},
  ]){
    const {reader,state}=rig();Object.assign(state.b,changes);Object.assign(state.c,changes);
    await assert.rejects(readAddressBook(reader,ROOT),/Address book/);
  }
});
