// The admin console (site/admin.html) hand-encodes every governance call and
// contract-creation transaction with the site's minimal ABI codec — no web3
// library loads in the browser. These tests pin each encoding the console
// produces against viem, and the artifact module against the checked-in ABIs,
// so a codec or artifact regression fails CI instead of an owner transaction.
//
//   run: node --test test/admin-console.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, encodeDeployData, encodeAbiParameters, stringToHex, toFunctionSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { encCall, encAddr, decodeStructArray, DEP_SCHEMA, DEP_SCHEMA_V1, APP_SCHEMA, VER_SCHEMA, DEP_SEL, CAT_SEL } = await import(path.join(REPO, "site/js/core/chain.js"));
const { CONTRACTS } = await import(path.join(REPO, "site/js/gen/contract-artifacts.js"));
const { encCallX } = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
const ABI = (name) => JSON.parse(fs.readFileSync(path.join(REPO, "contracts", name + ".abi.json"), "utf8"));

/* mirrors of the console's local helpers (admin-console.js is a custom
   element — not loadable outside a browser). Keep in sync. */
const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
function decodeBook(hex) {
  const b = (hex || "").replace(/^0x/, "");
  if (b.length < 128) return {};
  const word = (i) => b.slice(i * 64, i * 64 + 64);
  const num = (i) => parseInt(word(i).slice(48), 16);
  const kOff = num(0) / 32, vOff = num(1) / 32, n = num(kOff), out = {};
  for (let i = 0; i < n; i++) {
    const kw = word(kOff + 1 + i); let key = "";
    for (let j = 0; j < 64; j += 2) { const c = parseInt(kw.slice(j, j + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const a = "0x" + word(vOff + 1 + i).slice(24);
    if (key && !/^0x0{40}$/i.test(a)) out[key] = a;
  }
  return out;
}

const eq = (got, want) => assert.equal(got.toLowerCase(), want.toLowerCase());
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x22222222222222222222abcdef22222222222222";
const ZERO = "0x" + "0".repeat(40);
const S = (n) => CONTRACTS[n].sel;

test("artifact selectors match the checked-in ABIs", () => {
  for (const name of Object.keys(CONTRACTS)) {
    const abi = ABI(name);
    for (const f of abi.filter((x) => x.type === "function"))
      eq("0x" + CONTRACTS[name].sel[f.name], toFunctionSelector(f));
  }
});

test("book keys encode like viem stringToHex(size:32)", () => {
  for (const k of ["registry", "deployments", "appCatalog", "enclavePay", "custom-key_1"])
    eq(encKey(k), stringToHex(k, { size: 32 }));
});

test("owner calls encode like viem", () => {
  const cases = [
    ["EnclaveAddressBook", "set", [{ t: "bytes32", v: encKey("appCatalog") }, { t: "addr", v: A1 }], [stringToHex("appCatalog", { size: 32 }), A1]],
    ["EnclaveAddressBook", "setOwner", [{ t: "addr", v: A2 }], [A2]],
    ["EnclaveDeployments", "setMaxRate", [{ t: "bytes32", v: "0x" + "ab".repeat(32) }, { t: "uint", v: "1667" }], ["0x" + "ab".repeat(32), 1667n]],
    ["EnclaveDeployments", "setLeaseSec", [{ t: "uint", v: "300" }], [300n]],
    ["EnclaveDeployments", "setMaxGpuMilli", [{ t: "uint", v: "500" }], [500]],
    ["EnclaveDeployments", "setMaxFee", [{ t: "uint", v: "1389" }], [1389n]],
    ["EnclaveAppCatalog", "setMaxFee", [{ t: "uint", v: "1389" }], [1389n]],
    ["EnclaveDeployments", "setEthUsdFeed", [{ t: "addr", v: ZERO }], [ZERO]],
    ["EnclaveDeployments", "setPayout", [{ t: "addr", v: A1 }], [A1]],
    ["EnclaveDeployments", "setOwner", [{ t: "addr", v: A1 }], [A1]],
    ["EnclavePay", "setPayout", [{ t: "addr", v: A2 }], [A2]],
    ["EnclavePay", "setOwner", [{ t: "addr", v: A2 }], [A2]],
    ["EnclaveAppCatalog", "transferOwnership", [{ t: "addr", v: A2 }], [A2]],
  ];
  for (const [name, fn, mine, viems] of cases)
    eq(encCall(S(name)[fn], mine), encodeFunctionData({ abi: ABI(name), functionName: fn, args: viems }));
});

test("the dashboard's setConfig envelope call encodes like viem", () => {
  // the Protect editor's tx: setConfig(bytes32,string) with the options
  // envelope - empty (clear), waf-only, and waf+config (override preserved)
  const id = "0x" + "cc".repeat(32);
  const abi = [{ type: "function", name: "setConfig", stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [] }];
  for (const env of ["", '{"waf":{"rps":10,"burst":40}}',
                     '{"waf":{"rps":2.5,"burst":10,"maxBodyMb":1,"blockScanners":true},"config":{"api_key":"k"}}'])
    eq(encCall(DEP_SEL.setConfig, [{ t: "bytes32", v: id }, { t: "str", v: env }]),
       encodeFunctionData({ abi, functionName: "setConfig", args: [id, env] }));
  eq("0x" + DEP_SEL.setConfig, toFunctionSelector("function setConfig(bytes32 id, string configCid)"));
});

test("chain.js DEP_SEL hand-pins match the ABI (the cap getter every deploy path gates on)", () => {
  eq("0x" + DEP_SEL.maxGpuMilli, toFunctionSelector("function maxGpuMilli() view returns (uint16)"));
  eq("0x" + CONTRACTS.EnclaveDeployments.sel.maxGpuMilli, "0x" + DEP_SEL.maxGpuMilli);
  eq("0x" + CONTRACTS.EnclaveDeployments.sel.setMaxGpuMilli, toFunctionSelector("function setMaxGpuMilli(uint16)"));
});

test("publisher-fee surface pins + encodes like viem", () => {
  // the getters every fee-aware path gates on (site, CLI, supervisor)
  eq("0x" + DEP_SEL.feeOf, toFunctionSelector("function feeOf(bytes32) view returns (address, uint256)"));
  eq("0x" + DEP_SEL.maxFeePerSec6, toFunctionSelector("function maxFeePerSec6() view returns (uint256)"));
  eq("0x" + CAT_SEL.versionFee, toFunctionSelector("function versionFee(bytes32, uint256) view returns (uint256)"));
  eq("0x" + CAT_SEL.maxFeePerSec6, "0x" + DEP_SEL.maxFeePerSec6);   // same signature on both contracts
  // the rev-8 create the deploy console sends (fee snapshot, then the cap)
  const ref = "catalog://0x" + "cd".repeat(32) + "/3";
  eq(encCall(DEP_SEL.create, [
      { t: "str", v: ref }, { t: "uint", v: 0 }, { t: "uint", v: 50 },
      { t: "uint", v: 8080 }, { t: "str", v: "" }, { t: "bool", v: true },
      { t: "str", v: "" }, { t: "addr", v: A1 }, { t: "uint", v: 278n }, { t: "uint", v: 700n },
    ]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "create",
      args: [ref, 0, 50, 8080, "", true, "", A1, 278n, 700n] }));
  // the rev-5 publishVersion the Apps page sends: uint32[4] is a STATIC array
  // (4 inline words), so the hand encoder takes the axes as 4 uint args
  eq(encCall(CAT_SEL.publishVersion, [
      { t: "str", v: "hello" }, { t: "str", v: "Hello" }, { t: "str", v: "" }, { t: "str", v: "1" },
      { t: "str", v: "bafy123" }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "uint", v: 256 }, { t: "uint", v: 10 },
      { t: "str", v: "" }, { t: "str", v: "{}" }, { t: "uint", v: 278n },
    ]),
    encodeFunctionData({ abi: ABI("EnclaveAppCatalog"), functionName: "publishVersion",
      args: ["hello", "Hello", "", "1", "bafy123", [0, 0, 256, 10], "", "{}", 278n] }));
});

test("rate-cap surface (rev 8) pins + encodes like viem", () => {
  // the ceiling every claim is checked against: the console's editor sends
  // setMaxRate, every price display reads capOf, and a migration carries the
  // caps with importCaps. A hand-pin drifting from the ABI here would send a
  // tx to the wrong function on a money contract.
  eq("0x" + DEP_SEL.setMaxRate, toFunctionSelector("function setMaxRate(bytes32 id, uint256 maxRate6)"));
  eq("0x" + DEP_SEL.capOf, toFunctionSelector("function capOf(bytes32) view returns (uint256)"));
  eq("0x" + CONTRACTS.EnclaveDeployments.sel.setMaxRate, "0x" + DEP_SEL.setMaxRate);
  eq("0x" + CONTRACTS.EnclaveDeployments.sel.importCaps, toFunctionSelector("function importCaps(bytes32[], uint256[])"));
  const id = "0x" + "ab".repeat(32);
  eq(encCall(DEP_SEL.setMaxRate, [{ t: "bytes32", v: id }, { t: "uint", v: 694n }]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "setMaxRate", args: [id, 694n] }));
  // the registry side: an enclave states its price when it joins the network
  eq("0x" + CONTRACTS.EnclaveRegistry.sel.setPrices, toFunctionSelector("function setPrices(bytes32,uint64,uint64)"));
  eq("0x" + CONTRACTS.EnclaveRegistry.sel.register,
    toFunctionSelector("function register(string,string,bytes32,uint64,uint64,address) returns (bytes32)"));
});

test("setAppRef (the dashboard's Version control) pins + encodes like viem", () => {
  eq("0x" + DEP_SEL.setAppRef, toFunctionSelector("function setAppRef(bytes32 id, string appRef)"));
  eq("0x" + CONTRACTS.EnclaveDeployments.sel.setAppRef, "0x" + DEP_SEL.setAppRef);
  const id = "0x" + "ab".repeat(32), ref = "catalog://0x" + "cd".repeat(32) + "/7";
  eq(encCall(DEP_SEL.setAppRef, [{ t: "bytes32", v: id }, { t: "str", v: ref }]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "setAppRef", args: [id, ref] }));
});

test("setShares + multicall (the dashboard's resize control) pin + encode like viem", () => {
  eq("0x" + DEP_SEL.setShares, toFunctionSelector("function setShares(bytes32 id, uint16 gpuMilli, uint16 cpuMilli)"));
  eq("0x" + DEP_SEL.multicall, toFunctionSelector("function multicall(bytes[] calls)"));
  const id = "0x" + "ab".repeat(32), ref = "catalog://0x" + "cd".repeat(32) + "/7";
  const shares = encCall(DEP_SEL.setShares, [{ t: "bytes32", v: id }, { t: "uint", v: 800 }, { t: "uint", v: 400 }]);
  eq(shares, encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "setShares", args: [id, 800, 400] }));
  // the combined upgrade+resize tx: two inner calls of different dynamic sizes
  const inner = [encCall(DEP_SEL.setAppRef, [{ t: "bytes32", v: id }, { t: "str", v: ref }]), shares];
  eq(encCall(DEP_SEL.multicall, [{ t: "bytes[]", v: inner }]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "multicall", args: [inner] }));
});

test("refund-sweep batches (suspend + refund multicalls) encode like viem", () => {
  // the console's pre-migration sweep: refund every record the connected
  // wallet owns ON THE SOURCE so it migrates empty. Pin both inner-call
  // shapes exactly as refundSweepPlan packs them - a drifted encoding would
  // sign a batch the ledger reverts wholesale ("multicall failed").
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const ids = ["0x" + "ab".repeat(32), "0x" + "cd".repeat(32)];
  const stop = ids.map((id) => encCallX(sel.setActive, [{ t: "bytes32", v: id }, { t: "bool", v: false }]));
  eq(encCallX(sel.multicall, [{ t: "bytes[]", v: stop }]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "multicall",
      args: [ids.map((id) => encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "setActive", args: [id, false] }))] }));
  const refunds = ids.map((id) => encCallX(sel.refund, [{ t: "bytes32", v: id }]));
  eq(encCallX(sel.multicall, [{ t: "bytes[]", v: refunds }]),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "multicall",
      args: [ids.map((id) => encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "refund", args: [id] }))] }));
  // the sweep only ever signs for the connected wallet's records, and refuses
  // pre-refund ledgers - the constraint lives in the plan, pin it there
  const mig = fs.readFileSync(path.join(REPO, "site/components/admin-console/migrate.js"), "utf8");
  assert.match(mig, /refundSweepPlan[\s\S]{0,900}deploymentsSchema \$\{rev\} < 10/);
  assert.match(mig, /refundSweepPlan[\s\S]{0,2200}r\.owner\.toLowerCase\(\) === me/);
});

test("allowance funding pair (fund.js) encodes like viem", () => {
  // the code-bearing-payer path in site/js/core/fund.js: approve on the token,
  // then EnclaveDeployments.fund — pin both calldatas and the hand-pinned
  // approve selector it hardcodes (SEL_APPROVE)
  const id = "0x" + "1f".repeat(32), amt6 = 34000000n;
  const encUintLocal = (n) => BigInt(n).toString(16).padStart(64, "0");
  eq("0x" + DEP_SEL.fund + id.slice(2) + encUintLocal(amt6),
    encodeFunctionData({ abi: ABI("EnclaveDeployments"), functionName: "fund", args: [id, amt6] }));
  eq("0x095ea7b3" + encAddr(A1) + encUintLocal(amt6),
    encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve", args: [A1, amt6] }));
});

test("creation tx data (bytecode + ctor args) encodes like viem encodeDeployData", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const REG = "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2";
  const FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
  // mirrors the console: it reads each argument's TYPE off the artifact's ctor
  // and hands the shared codec a typed list, because the vault factory's pinned
  // signing origins are strings - address-only concatenation cannot place a
  // dynamic argument's head and body
  const dep = (name, args) => {
    const ctor = CONTRACTS[name].ctor || [];
    const typed = args.map((v, i) => ({ t: ctor[i] && ctor[i].type === "string" ? "str" : "addr", v }));
    eq(CONTRACTS[name].bytecode + encCall("", typed).slice(2),
       encodeDeployData({ abi: ABI(name), bytecode: CONTRACTS[name].bytecode, args }));
  };
  dep("EnclaveAddressBook", []);
  dep("EnclaveRegistry", []);
  dep("EnclaveAppCatalog", []);
  dep("EnclavePay", [USDC, A1]);
  dep("EnclaveDeployments", [USDC, A1, REG, FEED]);
  // mixed static + dynamic: three addresses then two strings
  dep("EnclaveCreditVaultFactory", [USDC, REG, A1, "https://enclave.host", ""]);
  dep("EnclaveCreditVaultFactory", [USDC, REG, A1, "https://enclave.host", "https://www.enclave.host"]);
});

test("decodeBook round-trips a viem-encoded all() result (skipping retired keys)", () => {
  const REG = "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2";
  const keys = ["registry", "deployments", "custom-key_1"].map((k) => stringToHex(k, { size: 32 }));
  const vals = [REG, ZERO, A2];
  const got = decodeBook(encodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }], [keys, vals]));
  assert.deepEqual(Object.keys(got), ["registry", "custom-key_1"]);
  eq(got.registry, REG);
  eq(got["custom-key_1"], A2);
  assert.deepEqual(decodeBook("0x"), {});
});

/* ---- migration codec: the import functions take the EXACT structs the
   getters return; one schema drives decode AND encode. Pin both directions
   against viem. ---- */

const DEP_ROW = {
  id: "0x" + "ab".repeat(32), owner: A1, appRef: "ipfs://bafyExample", ports: "tcp:15565,udp:9053",
  configCid: "bafyConfig",
  gpuMilli: 250, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1751900000,
  rate: 417, balance6: 1500000, spent6: 250000,
  runner: "0x" + "0".repeat(64), runnerOperator: ZERO, leaseUntil: 0,
};
const APP_ROW = {
  appId: "0x" + "cd".repeat(32), publisher: A2, slug: "hello-world", name: "Hello World",
  description: "answers Hello World! — quotes \"and\" unicode ✓", versionCount: 2, createdAt: 1751000000, updatedAt: 1751900000, active: true,
};
const VER_ROW = {
  cid: "bafybeibvdyyo3dd6jkg6oklnlsxrxvotfihctbp4sqrqcoavecsnmktgg4", version: "1.0.0",
  vramMb: 0, gpuGflops: 0, memMb: 256, cpuGflops: 100, createdAt: 1751000001,
  verified: true, yanked: false, ports: "", approval: 1,
};
const asTuple = (schema, o) => schema.map((f) => o[f.k]);

test("import calls (tuple[] args) encode like viem", () => {
  const depAbi = ABI("EnclaveDeployments"), catAbi = ABI("EnclaveAppCatalog");
  eq(encCallX(S("EnclaveDeployments").importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: [DEP_ROW, { ...DEP_ROW, id: "0x" + "ef".repeat(32), appRef: "hello" }] }]),
    encodeFunctionData({ abi: depAbi, functionName: "importDeployments",
      args: [[asTuple(DEP_SCHEMA, DEP_ROW), asTuple(DEP_SCHEMA, { ...DEP_ROW, id: "0x" + "ef".repeat(32), appRef: "hello" })]] }));
  eq(encCallX(S("EnclaveAppCatalog").importApps, [{ t: "tuple[]", schema: APP_SCHEMA, v: [APP_ROW] }]),
    encodeFunctionData({ abi: catAbi, functionName: "importApps", args: [[asTuple(APP_SCHEMA, APP_ROW)]] }));
  eq(encCallX(S("EnclaveAppCatalog").importVersions, [{ t: "bytes32", v: APP_ROW.appId }, { t: "tuple[]", schema: VER_SCHEMA, v: [VER_ROW, { ...VER_ROW, version: "1.0.1", cid: "bafyOther" }] }]),
    encodeFunctionData({ abi: catAbi, functionName: "importVersions",
      args: [APP_ROW.appId, [asTuple(VER_SCHEMA, VER_ROW), asTuple(VER_SCHEMA, { ...VER_ROW, version: "1.0.1", cid: "bafyOther" })]] }));
});


test("importFees (parallel arrays) encodes like viem", () => {
  const depAbi = ABI("EnclaveDeployments");
  const ids = ["0x" + "ab".repeat(32), "0x" + "ef".repeat(32)];
  const recipients = [A2, "0x" + "33".repeat(20)];
  const rates6 = ["139", "1389"];   // migrate.js carries rate6 as decimal strings
  eq(encCallX(S("EnclaveDeployments").importFees, [
    { t: "bytes32[]", v: ids }, { t: "addr[]", v: recipients }, { t: "uint[]", v: rates6 }]),
    encodeFunctionData({ abi: depAbi, functionName: "importFees", args: [ids, recipients, rates6.map(BigInt)] }));
});

test("runner-payout surface (rev 7) pins + importEarn encodes like viem", () => {
  const sel = S("EnclaveDeployments");
  // the getters/setters every payout-aware path gates on (supervisor withdraw
  // loop, migration engine, future console surfaces)
  eq("0x" + sel.earnOf, toFunctionSelector("function earnOf(bytes32) view returns (uint256, uint256, uint64)"));
  eq("0x" + sel.earned6, toFunctionSelector("function earned6(address) view returns (uint256)"));
  eq("0x" + sel.withdrawEarnings, toFunctionSelector("function withdrawEarnings(address)"));
  eq("0x" + sel.settle, toFunctionSelector("function settle(bytes32)"));
  eq("0x" + sel.fundEscrow, toFunctionSelector("function fundEscrow(bytes32, uint256)"));
  eq("0x" + sel.setRunnerBps, toFunctionSelector("function setRunnerBps(uint16)"));
  eq("0x" + sel.setClaimBond, toFunctionSelector("function setClaimBond(uint256, uint64)"));
  eq("0x" + sel.slashBond, toFunctionSelector("function slashBond(address, uint256, string)"));
  // the migration carry (parallel arrays, like importFees)
  const depAbi = ABI("EnclaveDeployments");
  const ids = ["0x" + "ab".repeat(32), "0x" + "ef".repeat(32)];
  const rates6 = ["67", "1333"];   // migrate.js carries rate6 as decimal strings
  eq(encCallX(S("EnclaveDeployments").importEarn, [
    { t: "bytes32[]", v: ids }, { t: "uint[]", v: rates6 }]),
    encodeFunctionData({ abi: depAbi, functionName: "importEarn", args: [ids, rates6.map(BigInt)] }));
});

test("publisher recovery (transferApp) pins + the bulk multicall encodes like viem", () => {
  // the compromised-publisher remedy: the console's Transfer-all button sends
  // one multicall of transferApp(appId, to) per app the from-wallet published
  const catAbi = ABI("EnclaveAppCatalog");
  eq("0x" + S("EnclaveAppCatalog").transferApp, toFunctionSelector("function transferApp(bytes32 appId, address to)"));
  // appIdOf turned view in rev 6 (resolves the transfer redirect) - the
  // selector every client already calls must not have moved
  eq("0x" + S("EnclaveAppCatalog").appIdOf, toFunctionSelector("function appIdOf(address publisher, string slug) view returns (bytes32)"));
  const ids = ["0x" + "ab".repeat(32), "0x" + "cd".repeat(32), "0x" + "ef".repeat(32)];
  const inner = ids.map((id) => encCall(S("EnclaveAppCatalog").transferApp, [{ t: "bytes32", v: id }, { t: "addr", v: A2 }]));
  for (const [i, id] of ids.entries())
    eq(inner[i], encodeFunctionData({ abi: catAbi, functionName: "transferApp", args: [id, A2] }));
  eq(encCallX(S("EnclaveAppCatalog").multicall, [{ t: "bytes[]", v: inner }]),
    encodeFunctionData({ abi: catAbi, functionName: "multicall", args: [inner] }));
});

test("importVersionFees (the catalog fee carry) encodes like viem", () => {
  // migrate.js rides per-version fees along the catalog migration - aligned
  // by version index, planned after the app's importVersions chunks
  const catAbi = ABI("EnclaveAppCatalog");
  const indices = ["0", "3", "17"], fees = ["139", "1389", "278"];   // decimal strings, like the ledger carry
  eq(encCallX(S("EnclaveAppCatalog").importVersionFees, [
    { t: "bytes32", v: APP_ROW.appId }, { t: "uint[]", v: indices }, { t: "uint[]", v: fees }]),
    encodeFunctionData({ abi: catAbi, functionName: "importVersionFees",
      args: [APP_ROW.appId, indices.map(BigInt), fees.map(BigInt)] }));
});

test("multicall wrapping encodes like viem", () => {
  const catAbi = ABI("EnclaveAppCatalog");
  const inner1 = encCallX(S("EnclaveAppCatalog").importApps, [{ t: "tuple[]", schema: APP_SCHEMA, v: [APP_ROW] }]);
  const inner2 = encCallX(S("EnclaveAppCatalog").importVersions, [{ t: "bytes32", v: APP_ROW.appId }, { t: "tuple[]", schema: VER_SCHEMA, v: [VER_ROW] }]);
  eq(encCallX(S("EnclaveAppCatalog").multicall, [{ t: "bytes[]", v: [inner1, inner2] }]),
    encodeFunctionData({ abi: catAbi, functionName: "multicall", args: [[inner1, inner2]] }));
});

test("migration round-trip: decode a getPage result, re-encode it for import, byte-equal to viem", () => {
  // what the SOURCE contract returns from getPage(...)
  const depAbi = ABI("EnclaveDeployments");
  const rows = [DEP_ROW, { ...DEP_ROW, id: "0x" + "ef".repeat(32), ports: "", isPublic: false, balance6: 0 }];
  const encodedReturn = encodeAbiParameters(
    depAbi.find((f) => f.name === "getPage").outputs, [rows.map((r) => asTuple(DEP_SCHEMA, r))]);
  // the console decodes it with the schema...
  const decoded = decodeStructArray(encodedReturn, DEP_SCHEMA);
  assert.equal(decoded.length, 2);
  // ...and replays it verbatim into importDeployments
  eq(encCallX(S("EnclaveDeployments").importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: decoded }]),
    encodeFunctionData({ abi: depAbi, functionName: "importDeployments", args: [rows.map((r) => asTuple(DEP_SCHEMA, r))] }));
});

test("rev-1 source rows (extra sshPubKey string) decode with DEP_SCHEMA_V1 and strip clean", () => {
  // a rev-1 ledger's getPage return: the 18-field Deployment with the removed
  // sshPubKey string after ports - the migration reads it with DEP_SCHEMA_V1
  // and drops the field before encoding the rev-2 import
  const V1_COMPONENTS = [
    { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
    { name: "appRef", type: "string" }, { name: "ports", type: "string" },
    { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" },
    { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
    { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
    { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
    { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
    { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
  ];
  const v1row = { ...DEP_ROW, sshPubKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 legacy" };
  const encoded = encodeAbiParameters([{ type: "tuple[]", components: V1_COMPONENTS }],
    [[asTuple(DEP_SCHEMA_V1, v1row)]]);
  const [dec] = decodeStructArray(encoded, DEP_SCHEMA_V1);
  assert.equal(dec.sshPubKey, v1row.sshPubKey);
  const { sshPubKey, ...clean } = dec;
  for (const f of DEP_SCHEMA)
    assert.equal(String(clean[f.k]).toLowerCase(), String(DEP_ROW[f.k]).toLowerCase(), f.k);
});

test("every constructor argument the console can answer is prefilled", () => {
  // The deploy form's `pre` map is keyed by CONSTRUCTOR ARGUMENT NAME - a
  // contract missing from it (or an arg name that drifted) silently renders an
  // empty box, and the operator hand-pastes an address the console already
  // knew. That's a paste-the-wrong-one bug with no error message, so pin it:
  // any contract WITH constructor args must have a prefill covering all of
  // them. (EnclaveFeatured shipped without one and went unnoticed.)
  const src = fs.readFileSync(path.join(REPO, "site/components/admin-console/admin-console.js"), "utf8");
  const block = /const pre = \{\n([\s\S]*?)\n\s*\};/.exec(src);
  assert.ok(block, "the deploy form's `pre` map is still an object literal");
  const entries = Object.fromEntries([...block[1].matchAll(/^\s*([A-Z]\w+): \{(.*)\},$/gm)].map((m) => [m[1], m[2]]));
  for (const [name, c] of Object.entries(CONTRACTS)) {
    if (!c.ctor.length) continue;
    assert.ok(entries[name], `${name} has constructor args but no prefill in the deploy form`);
    for (const a of c.ctor)
      assert.match(entries[name], new RegExp(`\\b${a.name}:`), `${name}'s prefill is missing ${a.name}`);
  }
});

test("artifacts stay in sync with contracts/*.sol (regenerate check)", () => {
  // cheap staleness guard: every contract source is older-or-equal than the
  // generated module, or the build regenerates it anyway (build-site.mjs runs
  // the artifact builder first). Here we just assert the module carries every
  // contract with bytecode + one book key each.
  assert.deepEqual(Object.keys(CONTRACTS).sort(), [
    "EnclaveAddressBook", "EnclaveAppCatalog", "EnclaveCreditVaultFactory",
    "EnclaveDeployments", "EnclaveFeatured", "EnclaveHostReviews", "EnclavePay",
    "EnclaveProofOfTime", "EnclaveRegistry", "EnclaveReviews", "PaymentRouter"]);
  for (const [name, c] of Object.entries(CONTRACTS)) {
    assert.match(c.bytecode, /^0x[0-9a-f]{100,}$/i, name + " bytecode");
    // the console's deploy encoder handles exactly these; anything else needs
    // a codec branch AND a validation branch before it can be deployed there
    for (const a of c.ctor)
      assert.ok(["address", "string"].includes(a.type),
        `${name} ctor arg ${a.name} is ${a.type}; the console's deploy encoder handles address|string only`);
  }
  assert.deepEqual(
    Object.values(CONTRACTS).map((c) => c.bookKey).filter(Boolean).sort(),
    ["appCatalog", "deployments", "enclavePay", "featured", "hostReviews", "paymentRouter", "proofOfTime", "registry", "reviews", "vaultFactory"]);
});

/* ---- migration escrow backing + the proof-of-time bindings (rev 9/10) ----
   These are the console actions with no undo: fundEscrow attribution closes
   with sealImports, and setProver cannot be changed at all. An encoding bug in
   either is unrecoverable, so both are pinned against viem here. */

test("fundEscrow + the approve that funds it encode like viem", async () => {
  const { approveTx, APPROVE_SEL } = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
  const depAbi = ABI("EnclaveDeployments");
  const id = "0x" + "ab".repeat(32);
  eq(encCallX(S("EnclaveDeployments").fundEscrow, [{ t: "bytes32", v: id }, { t: "uint", v: "1234500" }]),
    encodeFunctionData({ abi: depAbi, functionName: "fundEscrow", args: [id, 1234500n] }));

  // ERC-20 approve is the console's only non-project-contract call, so its
  // selector has no artifact to drift against - derive it from the signature
  assert.equal("0x" + APPROVE_SEL, toFunctionSelector("approve(address,uint256)"));
  const ERC20 = [{ type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
  eq(approveTx(A2, "19780000"), encodeFunctionData({ abi: ERC20, functionName: "approve", args: [A2, 19780000n] }));
});

test("batched fundEscrow rides the ledger's multicall, encoded like viem", () => {
  const depAbi = ABI("EnclaveDeployments");
  const ids = ["0x" + "ab".repeat(32), "0x" + "ef".repeat(32)];
  const amounts = ["1000000", "2500000"];
  const inner = ids.map((id, i) => encodeFunctionData({ abi: depAbi, functionName: "fundEscrow", args: [id, BigInt(amounts[i])] }));
  eq(encCallX(S("EnclaveDeployments").multicall, [{ t: "bytes[]", v: ids.map((id, i) =>
      encCallX(S("EnclaveDeployments").fundEscrow, [{ t: "bytes32", v: id }, { t: "uint", v: amounts[i] }])) }]),
    encodeFunctionData({ abi: depAbi, functionName: "multicall", args: [inner] }));
});

test("setProver / setProofRequiredFrom encode like viem", () => {
  const depAbi = ABI("EnclaveDeployments");
  eq(encCall(S("EnclaveDeployments").setProver, [{ t: "addr", v: A2 }]),
    encodeFunctionData({ abi: depAbi, functionName: "setProver", args: [A2] }));
  eq(encCall(S("EnclaveDeployments").setProofRequiredFrom, [{ t: "uint", v: "1786458509" }]),
    encodeFunctionData({ abi: depAbi, functionName: "setProofRequiredFrom", args: [1786458509n] }));
  eq(encCall(S("EnclaveDeployments").setProofRequiredFrom, [{ t: "uint", v: "0" }]),
    encodeFunctionData({ abi: depAbi, functionName: "setProofRequiredFrom", args: [0n] }));
});

test("the escrow step's required-backing formula matches _splitFunding's ceil", () => {
  // ceil(balance6 * rate6 / rate) - the same rounding the contract uses, so a
  // backed record covers every second its balance can buy (never one short)
  const want = (bal, rate6, rate) => (BigInt(bal) * BigInt(rate6) + (BigInt(rate) - 1n)) / BigInt(rate);
  assert.equal(want(100_000_000, 667, 834), 79_976_020n);      // pinned in the Solidity suite too
  assert.equal(want(1, 1, 3), 1n, "a sub-unit remainder still rounds UP");
  assert.equal(want(0, 667, 834), 0n);
});

test("a granted runner rate matches the contract's _snapRunnerRate", () => {
  const sol = fs.readFileSync(path.join(REPO, "contracts/EnclaveDeployments.sol"), "utf8");
  assert.match(sol, /uint256 r6 = \(\(d\.rate - _fees\[d\.id\]\.rate6\) \* runnerBps\) \/ 10000;/,
    "the console grants runnerBps*(rate-fee)/10000; if the contract's formula moves, migrate.js must follow");
  const grant = (rate, fee6, bps) => ((BigInt(rate) - BigInt(fee6)) * BigInt(bps)) / 10000n;
  assert.equal(grant(834, 0, 8000), 667n);
  assert.equal(grant(1042, 200, 8000), 673n);
});

/* An empty eth_call must never become a zero.
   migrate.js reads feed IMPORTS, so `0x` from a lagging pool member is the most
   dangerous possible answer: word()/wNum() turn it into 0, and 0 is valid data.
   Observed live during a real migration - count read empty, the target looked
   EMPTY, verify reported 0/4 and the delta re-planned importDeployments (which
   reverts "exists"). The silent half is worse: an empty feeOf on the SOURCE
   migrates a fee-bearing record with fee 0 and cuts its publisher off, and an
   empty schema sniff decodes every record with the wrong struct layout. */
test("migrate reads retry on empty and then fail loudly, never coerce to zero", async () => {
  const src = fs.readFileSync(path.join(REPO, "site/components/admin-console/migrate.js"), "utf8");
  const callFn = /const call = async \(to, data\) => \{[\s\S]*?\n\};/.exec(src);
  assert.ok(callFn, "migrate.js must define its eth_call wrapper as a guarded async function");
  assert.match(callFn[0], /emptyRetry: true/, "reads must retry across the RPC pool before giving up");
  assert.match(callFn[0], /throw new Error/, "an empty result must throw, not return a zero-ish value");

  // the revision sniffs may swallow ONLY a revert - swallowing an empty read
  // picks a struct schema at random and shifts every field of every record
  for (const fn of ["depRevOf", "catalogRevOf"]) {
    const body = new RegExp(`async function ${fn}\\(addr\\) \\{[\\s\\S]*?\\n\\}`).exec(src);
    assert.ok(body, `${fn} not found`);
    assert.match(body[0], /isRevert\(e\)/, `${fn} must distinguish a revert from a failed read`);
  }
  const impState = /export async function importState\([\s\S]*?\n\}/.exec(src);
  assert.match(impState[0], /isRevert\(e\)/, "importState must not report an RPC failure as 'no import surface'");
});

/* A granted runner rate is a deliberate difference from the source, so verify
   has to EXPECT it. It didn't: every granted record was reported as a "runner
   rate" mismatch, verify could never come back clean, and Seal (which only
   unlocks on a clean verify) was unreachable for any migration that used the
   grant. Plan and verify must agree on the exact granted value. */
test("verify accepts a granted runner rate, and only the exact granted value", async () => {
  const { MIG_KINDS } = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
  const src = fs.readFileSync(path.join(REPO, "site/components/admin-console/migrate.js"), "utf8");

  // one shared helper, used by both - separate copies could drift apart and
  // silently make a correct migration unverifiable
  assert.match(src, /function grantedRate6\(d, runnerBps\)/);
  const planBody = /plan\(data, after, opts = \{\}\) \{[\s\S]*?\n    \},/.exec(src);
  const verBody = /async verify\(data, target, opts = \{\}\) \{[\s\S]*?\n    \},/.exec(src);
  assert.match(planBody[0], /grantedRate6\(/, "plan must grant via the shared helper");
  assert.match(verBody[0], /grantedRate6\(/, "verify must expect the grant via the same helper");
  // the verBody regex above already pins the (data, target, opts = {}) signature;
  // Function.length can't check it, since it stops counting at the first default
  assert.equal(typeof MIG_KINDS.deployments.verify, "function");

  // the exact value: runnerBps of rate minus the publisher fee (_snapRunnerRate)
  const grant = (rate, fee6, bps) => ((BigInt(rate) - BigInt(fee6)) * BigInt(bps)) / 10000n;
  assert.equal(grant(559, 0, 8000), 447n);      // the live records this shipped for
  assert.equal(grant(409, 0, 8000), 327n);
  // and verify must not accept just any non-zero rate in place of the grant
  assert.doesNotMatch(verBody[0], /tgt !== "0"/, "a granted rate is an exact value, not 'anything non-zero'");
});

/* A migration spans minutes and several confirmations. _paint() runs on every
   repaint - and a repaint follows any owner tx - so the flow has to survive one.
   It didn't: _migPrefill reset unconditionally, throwing away the cached source
   read, re-disabling every button and wiping the log mid-migration. */
test("the migration flow survives a repaint, and Seal is never unreachable", () => {
  const src = fs.readFileSync(path.join(REPO, "site/components/admin-console/admin-console.js"), "utf8");
  const prefill = /_migPrefill\(\) \{[\s\S]*?\n  \}/.exec(src);
  assert.ok(prefill, "_migPrefill not found");
  assert.match(prefill[0], /M\.kind === kindSel\.value/, "must only reset when the KIND changed");
  assert.match(prefill[0], /st\.log/, "the log must be replayed from a buffer, not lost with the DOM");

  // Seal must unlock once verify has RUN. Gating the button on a CLEAN verify
  // makes "click again to override" unreachable - a disabled button cannot be
  // clicked - so any verify disagreement deadlocks the migration.
  const ver = /if \(act === "mig-verify"\) \{[\s\S]*?\n        \}/.exec(src);
  assert.ok(ver, "mig-verify handler not found");
  const enableIdx = ver[0].indexOf('enable("mig-seal", true)');
  assert.ok(enableIdx > 0, "verify must unlock seal");
  assert.ok(enableIdx < ver[0].indexOf("if (r.bad.length)"),
    "seal must unlock regardless of the verify result - the warning belongs at the seal, not the gate");

  // and the escrow pre-check must block only on MISSING backing: a skipped
  // record (inactive / no runner rate) never becomes backable, so counting it
  // as a blocker refuses the click forever
  const seal = /if \(act === "mig-seal"\) \{[\s\S]*?\n        \}/.exec(src);
  assert.match(seal[0], /if \(items\.length\) \{/, "only missing backing may block the seal");
  assert.doesNotMatch(seal[0], /items\.length \|\| skipped\.length/, "a permanently-skipped record must not block sealing");
});
