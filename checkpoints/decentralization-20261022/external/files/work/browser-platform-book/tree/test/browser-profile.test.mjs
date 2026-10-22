// scripts/network/browser-profile.mjs: a browser profile is derived only from a REVIEWED authority profile whose digest
// and contract pins the operator obtained out of band, plus explicit operator choices; the dashboard's own validator
// accepts the result. And the dashboard's ETH funding quote (site/js/core/independent-chain.js ethFundingQuote) refuses
// every unsafe feed state the deployed ledger would also refuse, before a wallet is asked to send value.
//   run: node --test test/browser-profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, toBytes, stringToHex } from "viem";
import { convert, verifyBookBinding, bookLedgerHistory } from "../scripts/network/browser-profile.mjs";
import { encodeProfile } from "../network/authority-profile.mjs";
import { parseProfile as parseBrowserProfile } from "../site/js/core/independent.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authorityBytes = fs.readFileSync(path.join(REPO, "contracts/deployments/network-profile-base.json"));
const digest = "sha256:" + createHash("sha256").update(authorityBytes).digest("hex");
const pins = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/contract-pins-base.json"), "utf8"));
const rpcs = ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"];
const storage = { version: 1, minimumCopies: 2, replicas: [
  { upload: "https://s1.example/add-json", audience: "0x" + "01".repeat(32), gateway: "https://s1.example/ipfs" },
  { upload: "https://s2.example/add-json", audience: "0x" + "02".repeat(32), gateway: "https://s2.example/ipfs" }] };

test("conversion: reviewed pins, token, ledger feed and provenance; the dashboard accepts the exact output", () => {
  const r = convert({ authorityBytes, expectDigest: digest, expectPins: pins, rpcs, storage, directories: ["https://dir.example"] });
  const p = parseBrowserProfile(r.text);
  assert.deepEqual(p.contracts, pins.contracts);
  assert.equal(p.usdc, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(p.ethUsdFeed, "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70");
  assert.equal(p.source.authorityProfileDigest, digest);
  assert.equal(r.fingerprint, createHash("sha256").update(r.text).digest("hex"));
  assert.equal(convert({ authorityBytes, expectDigest: digest, expectPins: pins, rpcs }).text,
    convert({ authorityBytes, expectDigest: digest, expectPins: pins, rpcs }).text, "deterministic output");
});

test("conversion refuses anything not anchored out of band, and unsafe operator inputs", () => {
  const ok = { authorityBytes, expectDigest: digest, expectPins: pins, rpcs };
  assert.throws(() => convert({ ...ok, expectDigest: undefined }), /expected profile digest/);
  assert.throws(() => convert({ ...ok, expectDigest: "sha256:" + "0".repeat(64) }), /digest mismatch/);
  assert.throws(() => convert({ ...ok, authorityBytes: Buffer.concat([authorityBytes, Buffer.from(" ")]),
    expectDigest: "sha256:" + createHash("sha256").update(Buffer.concat([authorityBytes, Buffer.from(" ")])).digest("hex") }), /canonical/);
  const swapped = { ...pins, contracts: { ...pins.contracts, deployments: "0xf9e71385c5cb49844f2457ba6567de0742f8b89a" } };
  assert.throws(() => convert({ ...ok, expectPins: swapped }), /contract pin deployments/);
  assert.throws(() => convert({ ...ok, rpcs: ["https://base-rpc.publicnode.com"] }), /2–8 RPC/);
  assert.throws(() => convert({ ...ok, rpcs: ["http://localhost:8545", "https://mainnet.base.org"] }), /HTTPS/);
  assert.throws(() => convert({ ...ok, directories: ["http://203.0.113.7:8188"] }), /HTTPS origins/);
  assert.throws(() => convert({ ...ok, storage: { ...storage, minimumCopies: 3 } }), /minimum/);
});

test("conversion follows an address book only when explicitly selected", () => {
  const args={authorityBytes,expectDigest:digest,expectPins:pins,rpcs};
  assert.equal(parseBrowserProfile(convert(args).text).addressBook,null);
  const addressBook="0xab214342d5a490150a4a977063a2f88e21f80907";
  assert.equal(parseBrowserProfile(convert({...args,addressBook}).text).addressBook,addressBook);
  assert.throws(()=>convert({...args,addressBook:"0x"+"0".repeat(40)}),/addressBook/);
});

test("address-book mode selects the ORIGINAL session factory from the reviewed profile; fixed mode keeps the pinned one", () => {
  const args={authorityBytes,expectDigest:digest,expectPins:pins,rpcs},addressBook="0xab214342d5a490150a4a977063a2f88e21f80907";
  const original=JSON.parse(authorityBytes).contracts.legacySessionVaultFactory.address.toLowerCase();
  assert.equal(original,"0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c");
  const book=parseBrowserProfile(convert({...args,addressBook}).text),fixed=parseBrowserProfile(convert(args).text);
  assert.equal(book.contracts.sessionVaultFactory,original);
  assert.equal(fixed.contracts.sessionVaultFactory,pins.contracts.sessionVaultFactory);
  assert.notEqual(original,pins.contracts.sessionVaultFactory);
  for (const k of Object.keys(pins.contracts)) if (k!=="sessionVaultFactory") assert.equal(book.contracts[k],pins.contracts[k],k);
  const without=JSON.parse(authorityBytes);delete without.contracts.legacySessionVaultFactory;
  // the reviewed layout itself requires the original factory's record: a profile without it is never converted
  assert.throws(()=>{const bytes=encodeProfile(without);
    convert({...args,addressBook,authorityBytes:bytes,expectDigest:"sha256:"+createHash("sha256").update(bytes).digest("hex")});},/legacySessionVaultFactory/);
});

test("--ledger-history-from: every ledger the book named, from its own AddressSet events with all RPCs agreeing, in the profile", async () => {
  const book="0xab214342d5a490150a4a977063a2f88e21f80907",args={authorityBytes,expectDigest:digest,expectPins:pins,rpcs,addressBook:book};
  const current=pins.contracts.deployments.toLowerCase(),L0="0x"+"c0".repeat(20),L1="0x"+"c1".repeat(20);
  const TOPIC=keccak256(toBytes("AddressSet(bytes32,address)")),KEY=stringToHex("deployments",{size:32});
  const log=(n,v,over={})=>({address:book,blockNumber:"0x"+n.toString(16),logIndex:"0x0",transactionHash:"0x"+"ee".repeat(32),topics:[TOPIC,KEY],data:"0x"+v.slice(2).padStart(64,"0"),...over});
  const history=[log(1005,L0),log(2500,L1),log(2501,"0x"+"0".repeat(40)),log(3999,current),log(4000,L0)];
  const client=({logs=history,code="0x6080"}={})=>{const asked=[];return {asked,
    request:async({method,params})=>{assert.equal(method,"eth_getLogs");const q=params[0];asked.push([Number(q.fromBlock),Number(q.toBlock)]);
      assert.equal(q.address,book);assert.deepEqual(q.topics,[TOPIC,KEY]);
      return logs.filter(l=>Number(l.blockNumber)>=Number(q.fromBlock)&&Number(l.blockNumber)<=Number(q.toBlock));},
    getCode:async({blockNumber})=>{assert.equal(blockNumber,4200n);return code;}};};
  const a=client(),b=client();
  const h=await bookLedgerHistory({clients:[a,b],book,fromBlock:1000n,toBlock:4200n,current,span:1000n});
  assert.deepEqual(h.ledgerHistory,{through:"4200",ledgers:[L0,L1]},"in order, distinct, without zero or the current pin");
  assert.deepEqual(a.asked,[[1000,1999],[2000,2999],[3000,3999],[4000,4200]]);
  assert.equal(h.events.length,5);
  const p=parseBrowserProfile(convert({...args,ledgerHistory:h.ledgerHistory}).text);
  assert.deepEqual(p.ledgerHistory,{through:4200,ledgers:[L0,L1]});
  assert.throws(()=>convert({...args,addressBook:null,ledgerHistory:h.ledgerHistory}),/ledgerHistory needs an addressBook/);
  for (const [clients,re] of [[[client(),client({logs:[...history,log(3000,"0x"+"66".repeat(20))]})],/disagree/],
    [[client({logs:[log(1005,L0,{topics:[TOPIC,stringToHex("appCatalog",{size:32})]})]}),client()],/outside the request/],
    [[client({code:"0x"}),client({code:"0x"})],/has no code/]])
    await assert.rejects(bookLedgerHistory({clients,book,fromBlock:1000n,toBlock:4200n,current,span:1000n}),re);
});

test("--verify-chain in address-book mode: every RPC must bind the original factory to this book, USDC and the pinned entries", async () => {
  const addressBook="0xab214342d5a490150a4a977063a2f88e21f80907";
  const browser=convert({authorityBytes,expectDigest:digest,expectPins:pins,rpcs,addressBook}).browser,c=browser.contractPins.contracts;
  const IMPL="0x"+"66".repeat(20),hex=(k)=>"0x"+Buffer.from(k).toString("hex").padEnd(64,"0");
  const chain=(over={})=>({readContract:async({address,functionName,args,blockNumber})=>{
    assert.equal(blockNumber,7n,"every read at the verified block");
    const v={implementation:IMPL,factory:c.sessionVaultFactory,book:addressBook,usdc:browser.usdc,owner:"0x0b2d009c"+"00".repeat(16),
      [hex("registry")]:c.registry,[hex("deployments")]:c.deployments,[hex("appCatalog")]:c.appCatalog,...over};
    if(functionName==="implementation")assert.equal(address,c.sessionVaultFactory);
    return functionName==="addr"?v[args[0]]:v[functionName];
  }});
  const ok=await verifyBookBinding({clients:[chain(),chain()],browser,blockNumber:7n});
  assert.equal(ok.book,addressBook);
  for (const [over,re] of [[{book:"0x"+"99".repeat(20)},/follows book/],[{factory:"0x"+"98".repeat(20)},/another factory/],
    [{usdc:"0x"+"97".repeat(20)},/USDC/],[{owner:"0x"+"0".repeat(40)},/administrator/],[{[hex("deployments")]:"0x"+"96".repeat(20)},/review the pins/]])
    await assert.rejects(verifyBookBinding({clients:[chain(over),chain(over)],browser,blockNumber:7n}),re);
  await assert.rejects(verifyBookBinding({clients:[chain(),chain({book:"0x"+"99".repeat(20)})],browser,blockNumber:7n}),/disagree/);
});

test("the command refuses to overwrite and prints the fingerprint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-")), out = path.join(dir, "p.json");
  try {
    const args = ["scripts/network/browser-profile.mjs", "--authority", "contracts/deployments/network-profile-base.json", "--expect-digest", digest,
      "--expect-pins", "contracts/deployments/contract-pins-base.json", ...rpcs.flatMap((u) => ["--rpc", u]), "--out", out];
    const line = JSON.parse(execFileSync("node", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    assert.equal(line.fingerprint, "sha256:" + createHash("sha256").update(fs.readFileSync(out)).digest("hex"));
    assert.throws(() => execFileSync("node", args, { cwd: REPO, stdio: "ignore" }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- ETH funding quote, against a scripted agreeing reader ----
const sel = (s) => keccak256(toBytes(s)).slice(2, 10);
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const LEDGER = pins.contracts.deployments, FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
function scripted({ feed = FEED, decimals = 8, answer = 2400n * 10n ** 8n, age = 60, roundId = 5, answeredIn = 5, feedCode = null } = {}){
  const snap = { number: 100, hash: "0x" + "ab".repeat(32), timestamp: 1_800_000_000, rpcs: ["a", "b"] };
  const push4 = (s) => "63" + sel(s);
  return {
    snapshot: async () => snap,
    code: async (_s, a) => a === LEDGER ? "0x" + push4("ethUsdFeed()") + push4("fundEth(bytes32)") + "00"
      : "0x" + (feedCode ?? (push4("latestRoundData()") + push4("decimals()"))) + "00",
    call: async (_s, to, data) => {
      if (to === LEDGER && data === "0x" + sel("ethUsdFeed()")) return "0x" + w(BigInt(feed));
      if (data === "0x" + sel("decimals()")) return "0x" + w(decimals);
      if (data === "0x" + sel("latestRoundData()")) return "0x" + w(roundId) + w(answer) + w(snap.timestamp - age) + w(snap.timestamp - age) + w(answeredIn);
      throw new Error("unexpected call " + data);
    },
  };
}
let IC;
test.before(async () => {
  const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
    contractPins: pins, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", ethUsdFeed: FEED };
  const text = JSON.stringify(profile), mem = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost" };
  IC = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-chain.js")).href + "?eth");
});

test("ETH quote: the ledger's reviewed 8-decimal feed with a fresh finalized round", async () => {
  IC._setReaderForTests(scripted());
  const q = await IC.ethFundingQuote();
  assert.equal(q.ethUsd, 2400); assert.equal(q.feed, FEED); assert.equal(q.ageSeconds, 60);
});

test("ETH quote refuses: disabled, swapped feed, wrong decimals, stale, unfinished, non-positive, missing methods", async () => {
  const cases = [
    [{ feed: "0x" + "00".repeat(20) }, /disabled/],
    [{ feed: "0x" + "77".repeat(20) }, /not the profile's reviewed feed/],
    [{ decimals: 18 }, /assumes 8/],
    [{ age: 7200 - 599 }, /old/],
    [{ answeredIn: 4 }, /unfinished/],
    [{ answer: 0n }, /not positive/],
    [{ answer: -1n }, /not positive/],
    [{ feedCode: "63" + sel("latestRoundData()") }, /does not implement decimals\(\)/],
  ];
  for (const [over, re] of cases){
    IC._setReaderForTests(scripted(over));
    await assert.rejects(IC.ethFundingQuote(), re, JSON.stringify(over, (k, v) => typeof v === "bigint" ? String(v) : v));
  }
});

test("selector presence check handles PUSHn for selectors with leading zero bytes", async () => {
  IC._setReaderForTests({ snapshot: async () => ({ number: 1 }), code: async () => "0x62bd4dee00" });
  // 0x00bd4dee = payEth(bytes32) in EnclavePay: compilers push it as PUSH3 bd4dee
  assert.equal(sel("payEth(bytes32)"), "00bd4dee");
  await IC.assertImplements({ number: 1 }, "0x" + "12".repeat(20), "pay", ["payEth(bytes32)"]);
  await assert.rejects(IC.assertImplements({ number: 1 }, "0x" + "34".repeat(20), "pay", ["fundEth(bytes32)"]), /does not implement fundEth/);
});
