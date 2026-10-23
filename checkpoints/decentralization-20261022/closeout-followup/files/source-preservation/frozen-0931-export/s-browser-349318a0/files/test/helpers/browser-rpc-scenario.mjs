// One browser RPC routing scenario, in its own process (config.js fixes the profile when it loads): the REAL site modules
// of <site root> (this tree's, or an older commit's extracted for a control) with browser globals, a fake Base chain
// behind the profile's RPC origins, an inert wallet provider (generated test address, no key), and a fetch that refuses
// every other origin the way a blocked public network does. Prints one JSON line: what each call returned and every
// origin and wallet method the page reached.
//   node test/helpers/browser-rpc-scenario.mjs <site root> '<scenario json>'
// Used by test/site-browser-rpc-closure.test.mjs.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, encodeFunctionResult, decodeFunctionData } from "viem";
import { VAULT_ABI } from "../../custody/chain.mjs";

const [siteRoot, raw] = process.argv.slice(2);
const sc = JSON.parse(raw);
const n = sc.rpcs || 3;
const RPCS = Array.from({ length: n }, (_, i) => `https://rpc${i}.operator.example`);
const down = new Set(sc.down || []);
const BOOK = "0x" + "b0".repeat(20), VAULT = "0x" + "5e".repeat(20), OWNER = "0x" + "9e".repeat(20);
const contracts = { registry: "0x" + "11".repeat(20), deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
  proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
  sessionVaultFactory: "0x" + "55".repeat(20), secretVaultV2: "0x" + "00".repeat(20) };
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: RPCS, quorum: sc.quorum || 2, confirmations: 0,
  contractPins: { version: 1, chainId: 8453, contracts }, usdc: "0x" + "66".repeat(20), ...(sc.book ? { addressBook: BOOK } : {}) };
const text = sc.badProfile ? JSON.stringify({ ...profile, rpcs: [RPCS[0]] }) : JSON.stringify(profile);

const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
const saved = sc.state === "off" || sc.state === "appeared" ? [] : [["enclave_independent_profile", text]];
globalThis.localStorage = mem(new Map(saved));
globalThis.sessionStorage = mem(new Map(sc.state === "on" || sc.state === "changed" ? [["enclave_independent_ack", text]] : []));
const doc = new EventTarget(); doc.querySelector = () => null; doc.querySelectorAll = () => []; doc.getElementById = () => null;
globalThis.document = doc;
globalThis.window = globalThis; globalThis.addEventListener ??= () => {};
globalThis.location = { hostname: "dashboard.example", origin: "https://dashboard.example", pathname: "/", hash: "", search: "" };

/* ---- the fake chain behind the profile's origins ---- */
const NOW = Math.floor(Date.now() / 1000), HEAD = 100;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const ADDR_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const key = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
const bookAll = () => encodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }],
  [["registry", "deployments", "appCatalog", "secretVault"].map(key), [contracts.registry, contracts.deployments, contracts.appCatalog, VAULT]]);
function call({ to, data }){
  to = String(to).toLowerCase();
  if (data.startsWith("0x70a08231")) return "0x" + word(42_000000);                 // balanceOf: 42 USDC on the chain
  if (to === BOOK && data === "0x10c4e8b0") return bookAll();
  if (to === BOOK && data === "0x8da5cb5b") return "0x" + word(0xad);               // owner(): the book administrator
  if (to === BOOK){ decodeFunctionData({ abi: ADDR_ABI, data }); return "0x" + word(0); }   // addr(key): unset
  if (to === VAULT){
    const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
    const out = { policyOf: [[OWNER, 0, 0, "0x" + "00".repeat(32), false, "0x"]], bundleOf: [[0, 0, "0x"]], book: [BOOK], beneficialOwnerOf: [OWNER] }[functionName];
    if (!out) throw new Error("unexpected vault read " + functionName);
    return encodeFunctionResult({ abi: VAULT_ABI, functionName, result: out.length === 1 ? out[0] : out });
  }
  try { decodeFunctionData({ abi: ADDR_ABI, data }); return "0x" + word(0); } catch {}
  return "0x" + word(0);
}
function chain(method, params){
  switch (method){
    case "eth_chainId": return "0x2105";
    case "eth_blockNumber": return "0x" + HEAD.toString(16);
    case "eth_getBlockByNumber": {
      const b = params[0] === "latest" ? HEAD : Number(params[0]);
      return { number: "0x" + b.toString(16), hash: "0x" + word(b + 0xb10c), parentHash: "0x" + word(b + 0xb10b), timestamp: "0x" + (NOW - (HEAD - b) * 2).toString(16),
        baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: "0x" + "00".repeat(20), difficulty: "0x0", extraData: "0x",
        logsBloom: "0x" + "00".repeat(256), nonce: "0x0000000000000000", sha3Uncles: "0x" + word(0), size: "0x1", stateRoot: "0x" + word(1), receiptsRoot: "0x" + word(2),
        transactionsRoot: "0x" + word(3), uncles: [], mixHash: "0x" + word(4) };
    }
    case "eth_call": return call(params[0]);
    case "eth_getBalance": return "0xde0b6b3a7640000";                                   // 1 ETH on the chain
    case "eth_estimateGas": return "0x5208";
    case "eth_getCode": return String(params[0]).toLowerCase() === OWNER ? "0x" : "0x6080";
    case "eth_getTransactionReceipt": return { status: "0x1", transactionHash: params[0], blockNumber: "0x64" };
    case "eth_getLogs": return [];
    default: throw new Error("fake chain: no " + method);
  }
}
const reached = [], refused = [], chainErrors = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input && input.url ? input.url : input);
  let origin; try { origin = new URL(url).origin; } catch { origin = url; }
  const body = init.body ? JSON.parse(init.body) : null;
  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls) reached.push({ origin, method: c && c.method });
  if (!RPCS.includes(origin) || down.has(RPCS.indexOf(origin))){
    if (!RPCS.includes(origin)) refused.push(origin);
    throw new TypeError("fetch failed (" + (RPCS.includes(origin) ? "endpoint down" : "public network refused") + ")");
  }
  const answer = (c) => { try { return { jsonrpc: "2.0", id: c.id, result: chain(c.method, c.params || []) }; }
    catch (e){ chainErrors.push(c.method + ": " + String(e.message || e).slice(0, 160)); return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: String(e.message || e) } }; } };
  const out = Array.isArray(body) ? calls.map(answer) : answer(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};

/* ---- an inert wallet: answers differently from the chain, so a read it served is visible ---- */
const walletCalls = [];
const wallet = { request: async ({ method, params }) => {
  walletCalls.push(method);
  switch (method){
    case "eth_chainId": return "0x2105";
    case "eth_accounts": case "eth_requestAccounts": return [OWNER];
    case "eth_call": return "0x" + word(7_000000);                                       // the wallet's RPC says 7 USDC
    case "eth_getBalance": return "0x1bc16d674ec80000";                                  // and 2 ETH
    case "eth_estimateGas": return "0x1";
    case "eth_getCode": return "0x60";
    case "eth_sendTransaction": wallet.lastTx = params[0]; return "0x" + "ab".repeat(32);
    case "eth_getTransactionByHash": return null;
    default: throw Object.assign(new Error("inert wallet: " + method), { code: 4200 });
  } }, on() {}, removeListener() {} };

const core = (m) => import(pathToFileURL(path.join(siteRoot, "js/core", m)).href);
const out = {};
const attempt = async (name, fn) => {
  const from = reached.length, w = walletCalls.length;
  try { out[name] = { ok: await fn() }; } catch (e){ out[name] = { error: String((e && e.message) || e) }; }
  out[name].origins = [...new Set(reached.slice(from).map((r) => r.origin))];
  out[name].wallet = walletCalls.slice(w);
};
const settle = () => new Promise((r) => setTimeout(r, 50));

const { Enclave } = await core("api.js");
const W = await core("wallet.js");
const C = await core("chain.js");
const F = await core("fund.js");
const CU = await core("custody.js");
if (sc.book) await core("addressbook.js");            // boot.js loads it: the platform book resolves once at load
Enclave.provider = wallet; Enclave.address = OWNER; Enclave.chainId = 8453;
if (sc.book) for (let i = 0; i < 40 && !CU.custodyAvailable(); i++) await settle();   // addressbook.js resolves the book at load

if (sc.debug) out.debugChanged = await (await core("platform-addresses.js")).resolvePlatformAddresses().then((r) => r && r.changed, (e) => "error " + e.message);
for (const i of sc.downAfterLoad || []) down.add(i);
if (sc.state === "changed") globalThis.localStorage.setItem("enclave_independent_profile", JSON.stringify({ ...profile, name: "replaced elsewhere" }));
if (sc.state === "appeared") globalThis.localStorage.setItem("enclave_independent_profile", text);

await attempt("usdcBalance", () => W.usdcBalanceOf(OWNER));
await attempt("ethBalance", () => W.ethBalanceOf(OWNER));
await attempt("payerHasCode", () => F.payerHasCode());
let sent = null;
await attempt("sendTx", async () => { sent = await W.sendTx(contracts.deployments, "0x6485d678" + word(1) + word(0), "0x0"); return sent; });
out.sendTx.gas = (wallet.lastTx || {}).gas;
await attempt("receipt", () => C.waitReceipt("0x" + "ab".repeat(32), 1).then((r) => r.status));
await attempt("baseRpc", () => C.baseRpc("eth_blockNumber", []));
if (sc.state !== "off") await attempt("quorumSnapshot", async () => (await (await core("independent-chain.js")).reader().snapshot()).number);
if (sc.book) await attempt("custody", () => CU.custodyStatus("0x" + "cd".repeat(32)));
out.custodyAvailable = CU.custodyAvailable();
if (sc.sessions){
  // the session store holds a record opened under an independent profile (no relay) with an RPC stored beside it
  const S = await core("sessions.js");
  const opened = [];
  S._useSdkForTests({ IndexedDbStore: class { async load(id){ return id === "sid1" ? { id, relay: "", handle: { chainId: 8453, vault: VAULT, sid: "0x" + "51".repeat(32), owner: OWNER, relay: "", rpc: "https://old-profile.example" } } : null; } async remove(){} },
    sessionFromRecord: async (rec, opts) => { opened.push(opts && opts.publicClient ? "profile client" : "stored rpc " + rec.handle.rpc); return { handle: rec.handle, status: async () => ({ live: true }) }; } });
  globalThis.localStorage.setItem("enclave_wallet_session", "sid1");
  await attempt("currentSession", async () => { const c = await S.currentSession(); return c ? opened.join() : null; });
  await attempt("endSession", async () => { await S.endSession({ quiet: true }); return globalThis.localStorage.getItem("enclave_wallet_session"); });
}
out.refused = [...new Set(refused)];
out.chainErrors = [...new Set(chainErrors)].slice(0, 6);
out.rpcs = RPCS;
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
