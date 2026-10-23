// Local-chain tests of the read-only publish preparer. anvil (chain id 8453) carries, AT THEIR PRODUCTION ADDRESSES:
// the deployed catalog's exact runtime (rebuilt from f2e9a71d0, codeHash 0x3f3c4cc0…) with the state its constructor
// leaves, the deployed book's exact runtime (6c1135b0f, 0xe4f570e9…) with appCatalog/deployments set, a placeholder at
// the ledger (its hash via the ledger-only test seam), and a MOCK GasPriceOracle. No network beyond 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, encodePacked, keccak256, stringToHex, decodeFunctionData } from "viem";
import { PRODUCTION, COMPONENT, CATALOG_ABI, SELECTOR, PACING, request, checkRequest, createPreparer, httpRpc, Refusal } from "../lib/publish.mjs";
import { toFunctionSelector } from "viem";
const isIsthmusSel = toFunctionSelector("isIsthmus()"), operatorFeeSel = toFunctionSelector("getOperatorFee(uint256)");

const fx = (f) => JSON.parse(fs.readFileSync(new URL("../fixtures/" + f, import.meta.url), "utf8"));
const CAT = fx("catalog-build.json"), BOOK = fx("book-build.json"), ORACLE = fx("oracle-mock.json");
const WASM = new URL("../../out/custody_canary_proof.wasm", import.meta.url);
const P = PRODUCTION, pad32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
let anvil, URL0, OWNER_SLOT;

const raw = async (method, params = []) => {
  const r = await fetch(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const mine = () => raw("evm_mine");
async function sendAs(from, tx) {
  await raw("anvil_impersonateAccount", [from]);
  const h = await raw("eth_sendTransaction", [{ from, ...tx }]);
  await mine();
  const rc = await raw("eth_getTransactionReceipt", [h]);
  await raw("anvil_stopImpersonatingAccount", [from]);
  return rc;
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

before(async () => {
  const port = await freePort();
  URL0 = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--chain-id", "8453", "--port", String(port), "--block-base-fee-per-gas", "5000000", "--no-mining", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await raw("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  await raw("anvil_setBalance", [P.publisher, "0x" + (10n ** 17n).toString(16)]);
  // the catalog: deploy from the publisher (constructor: owner = msg.sender), then move runtime + constructor state to
  // the production address
  const rc = await sendAs(P.publisher, { data: CAT.creation, gas: "0x1c9c380" });
  const tmp = rc.contractAddress;
  const code = await raw("eth_getCode", [tmp, "latest"]);
  assert.equal(keccak256(code), P.catalogCodeHash, "the local catalog runtime is the deployed one");
  await raw("anvil_setCode", [P.catalog, code]);
  for (let s = 0; s < 64; s++) {
    const v = await raw("eth_getStorageAt", [tmp, pad32(s), "latest"]);
    if (BigInt(v) !== 0n) await raw("anvil_setStorageAt", [P.catalog, pad32(s), v]);
    if (BigInt(v) === BigInt(P.publisher) && OWNER_SLOT === undefined) OWNER_SLOT = s;
  }
  assert.ok(OWNER_SLOT !== undefined, "found the owner slot");
  // the book: exact runtime, owner (slot 0) = the admin, keys set by the owner
  await raw("anvil_setCode", [P.book, BOOK.runtime]);
  await raw("anvil_setStorageAt", [P.book, pad32(0), pad32(BigInt(P.publisher))]);
  const BOOK_SET = [{ type: "function", name: "setMany", inputs: [{ type: "bytes32[]" }, { type: "address[]" }], outputs: [], stateMutability: "nonpayable" }];
  await sendAs(P.publisher, { to: P.book, data: encodeFunctionData({ abi: BOOK_SET, functionName: "setMany",
    args: [[stringToHex("registry", { size: 32 }), stringToHex("deployments", { size: 32 }), stringToHex("appCatalog", { size: 32 })],
           ["0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac", P.ledger, P.catalog]] }) });
  await raw("anvil_setCode", [P.ledger, "0x6001600055"]);          // placeholder; hashed through the test seam
  await raw("anvil_setCode", [P.oracle, ORACLE.runtime]);
  for (let i = 0; i < 3; i++) await mine();                       // readDepth 2
});
after(() => anvil?.kill());

// two "RPCs" over the one local chain; anvil's 1 gwei tip suggestion replaced by a Base-like 0.001 gwei, and per-side
// tampering for disagreement tests
const counter = { n: 0 };
function rpcWith(tamper = () => undefined) {
  const base = httpRpc(15_000, counter);
  return async (url, method, params) => {
    const t = tamper(url, method, params);
    if (t !== undefined) { counter.n++; return t; }
    if (method === "eth_maxPriorityFeePerGas") { counter.n++; return "0xf4240"; }
    return base(URL0, method, params);
  };
}
const LEDGER_SEAM = () => P.ledgerCodeHash;
// a fake clock: pacing and backoff advance virtual time only (no real sleeps)
const fakeClock = (t0 = Date.parse("2026-10-23T22:00:00Z")) => { const c = { t: t0, now: () => c.t, sleepUntil: async (at) => { c.t = Math.max(c.t, at); } }; return c; };
const prep = (opts = {}) => createPreparer({ rpc: rpcWith(opts.tamper), ledgerCodeHashOf: opts.ledgerCodeHashOf ?? LEDGER_SEAM, clock: opts.clock ?? fakeClock() });
const http429 = (retryAfter = null) => Object.assign(new Error("fake HTTP 429"), { status: 429, retryAfter });
const refuses = async (code, opts) => assert.rejects(prep(opts).prepare(), (e) => e instanceof Refusal && e.code === code ? true : assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));
async function withState(addr, slot, value, fn) {
  const old = await raw("eth_getStorageAt", [addr, pad32(slot), "latest"]);
  await raw("anvil_setStorageAt", [addr, pad32(slot), value]); for (let i = 0; i < 3; i++) await mine();
  try { await fn(); } finally { await raw("anvil_setStorageAt", [addr, pad32(slot), old]); for (let i = 0; i < 3; i++) await mine(); }
}

test("offline request: exact selector, arguments, calldata and appId", () => {
  const r = request();
  assert.equal(SELECTOR, "0x47910c23");
  assert.equal(r.data.slice(0, 10), "0x47910c23");
  const d = decodeFunctionData({ abi: CATALOG_ABI, data: r.data });
  assert.deepEqual(d.args, ["custody-canary-proof", "Custody canary proof", P.request.description, "0.1.0", COMPONENT.cid, [0, 0, P.request.res[2], P.request.res[3]], "", '{"wasi":"0.2"}', 0n]);
  assert.equal(r.appId, keccak256(encodePacked(["address", "string"], [P.publisher, "custody-canary-proof"])));
  assert.ok(/canary use ONLY/i.test(P.request.description) && /Never stage real or user secrets/.test(P.request.description));
});

test("the component pins: file bytes, sha256, size and raw CIDv1", () => {
  const b = fs.readFileSync(WASM);
  assert.equal(createHash("sha256").update(b).digest("hex"), COMPONENT.sha256);
  assert.equal(b.length, COMPONENT.size);
  const b32 = (buf) => { const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0, o = ""; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(v << (5 - bits)) & 31]; return o; };
  assert.equal("b" + b32(Buffer.from([0x01, 0x55, 0x12, 0x20, ...createHash("sha256").update(b).digest()])), COMPONENT.cid);
});

test("config = what the CLI itself stamps for these bytes (its own classifier, run on the binary)", () => {
  const src = execFileSync("git", ["-C", "/home/steven/Projects/enclave", "show", "HEAD:cli/enclave.mjs"], { maxBuffer: 64 << 20 }).toString();
  const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } };
  const lib = new Function(`${fn("componentMem64")}\n${fn("componentContract")}\nreturn { componentMem64, componentContract };`)();
  const b = fs.readFileSync(WASM);
  const layer = b[6] | (b[7] << 8);
  assert.equal(layer, 1, "a component (layer 1)");
  const contract = lib.componentContract(b);
  assert.deepEqual(contract, { wasi: "0.2", world: "wasi:http/incoming-handler@0.2.4" });
  assert.equal(lib.componentMem64(b), false);
  assert.equal(b.includes("[thread-"), false); assert.equal(b.includes("[set-spawn-indirect]"), false);
  // the CLI's stamp for rev >= 4 and no --config: {} + wasi
  assert.equal(JSON.stringify({ wasi: contract.wasi }), P.request.config);
});

test("checkRequest enforces the catalog's own limits", () => {
  const bad = (patch) => assert.throws(() => checkRequest({ ...P.request, ...patch }), Refusal);
  bad({ slug: "Custody" }); bad({ slug: "x".repeat(41) }); bad({ name: "" }); bad({ name: "n".repeat(81) });
  bad({ description: "d".repeat(501) }); bad({ version: "" }); bad({ version: "v".repeat(33) }); bad({ cid: "c".repeat(101) });
  bad({ ports: "p".repeat(97) }); bad({ config: "{" + " ".repeat(4096) + "}" }); bad({ res: [0, 0, 0, 10] }); bad({ res: [0, 0, 256] });
  bad({ res: [0, 0, 1048577, 10] }); bad({ feePerSec6: 1n });
  assert.doesNotThrow(() => checkRequest(P.request));
});

test("the preparer refuses any non-production target or request", () => {
  assert.throws(() => createPreparer({ cfg: { ...P, catalog: "0x0000000000000000000000000000000000000001" } }), /catalog/);
  assert.throws(() => createPreparer({ cfg: { ...P, publisher: "0x0000000000000000000000000000000000000001" } }), /publisher/);
  assert.throws(() => createPreparer({ cfg: { ...P, request: { ...P.request, slug: "hello-world" } } }), /request/);
  assert.throws(() => createPreparer({ cfg: { ...P, rpcs: [P.rpcs[0], P.rpcs[0]] } }), /two distinct/);
  assert.equal(Object.keys(createPreparer({ rpc: rpcWith() })).sort().join(), "prepare,request,stats", "no send, sign or upload surface");
  const src = fs.readFileSync(new URL("../lib/publish.mjs", import.meta.url), "utf8");
  for (const s of ["eth_sendRawTransaction", "eth_sendTransaction", "privateKeyToAccount", "signTransaction", "add-wasm", "upload-token"]) assert.ok(!src.includes(s), s);
});

let prepared;
test("prepare: a new free listing, simulated from the admin, priced within the caps", async () => {
  counter.n = 0;
  prepared = await prep().prepare();
  const p = prepared.plan;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.planHash, "0x" + createHash("sha256").update(prepared.text).digest("hex"));
  assert.equal(p.observed.book.appCatalog, P.catalog); assert.equal(p.observed.book.deployments, P.ledger);
  assert.equal(p.observed.catalog.owner, P.publisher); assert.equal(p.observed.catalog.schema, "9"); assert.equal(p.observed.catalog.maxFeePerSec6, "1389");
  assert.equal(p.observed.simulation.appId, request().appId.toLowerCase()); assert.equal(p.observed.simulation.index, "0");
  assert.equal(p.unsignedTx.to, P.catalog); assert.equal(p.unsignedTx.value, "0"); assert.equal(p.unsignedTx.data, request().data);
  const f = p.observed.fees;
  const gas = BigInt(p.unsignedTx.gas), est = BigInt(p.observed.estimates[0]);
  assert.ok(gas >= est && gas <= P.caps.gas);
  assert.equal(BigInt(f.totalAtBlockWei), BigInt(f.l2MaxWei) + BigInt(f.l1DataUpperBoundWei) + BigInt(f.operatorFeeUpperBoundWei));
  assert.equal(BigInt(f.operatorFeeUpperBoundWei), gas * 7n, "the mock oracle's operator fee for the gas LIMIT");
  assert.equal(BigInt(f.l1DataUpperBoundWei), BigInt(f.encodedBytes.oracleArgument + 68) * 1000n);
  assert.ok(f.encodedBytes.oracleArgument + 68 >= f.encodedBytes.signedMax);
  assert.ok(BigInt(f.totalAtBlockWei) <= P.caps.totalWei);
  assert.equal(p.observed.publisher.code, "none (EOA)");
  console.log(`# local prepare: ${counter.n} RPC requests; estimate ${est}; gas ${gas}; total ${f.totalAtBlockWei} wei (mock oracle)`);
});

test("refusals: the book, the catalog, the ledger, authority, a pending handoff", async () => {
  await refuses("book", { tamper: (u, m, p) => (m === "eth_call" && p[0].to === P.book && p[0].data.includes(stringToHex("appCatalog", { size: 32 }).slice(2)) ? pad32(1) : undefined) });
  await refuses("book", { tamper: (u, m, p) => (m === "eth_getCode" && p[0] === P.book ? "0x00" : undefined) });
  await refuses("catalog", { tamper: (u, m, p) => (m === "eth_getCode" && p[0] === P.catalog ? "0x00" : undefined) });
  await refuses("ledger", { ledgerCodeHashOf: keccak256 });
  await withState(P.catalog, OWNER_SLOT, pad32(1n), () => refuses("authority"));            // another owner: no approval on publish
  await withState(P.catalog, OWNER_SLOT + 1, pad32(2n), () => assert.rejects(prep().prepare(), /handoff to 0x0+2 is pending/));   // pendingOwner
});

test("refusals: CID already listed, oracle not Isthmus, operator fee reverts, RPC disagreement, unsettled nonce, fee cap", async () => {
  await assert.rejects(prep({ tamper: (u, m, p) => (m === "eth_call" && p[0].data.startsWith("0x8747b2ff") ? pad32(1n) : undefined) }).prepare(),
    (e) => e.code === "listing" && /already has 1 version/.test(e.message));                   // an existing listing is never added to
  await refuses("listing", { tamper: (u, m, p) => (m === "eth_call" && p[0].data.startsWith("0x577d81b5") ? pad32(1n) + "0".repeat(64 * 9) : undefined) });
  await withState(P.oracle, 0, pad32(1n), () => refuses("operator_fee"));
  await withState(P.oracle, 0, pad32(2n), () => refuses("operator_fee"));
  await refuses("rpc_disagree", { tamper: (u, m, p) => (u === P.rpcs[1] && m === "eth_call" && p[0].data.startsWith("0x8da5cb5b") ? pad32(2n) : undefined) });
  await refuses("nonce", { tamper: (u, m, p) => (m === "eth_getTransactionCount" && p[1] === "pending" ? "0x999" : undefined) });
  await refuses("fees", { tamper: (u, m) => (m === "eth_maxPriorityFeePerGas" ? "0x5f5e100" : undefined) });
  await refuses("chain", { tamper: (u, m) => (u === P.rpcs[0] && m === "eth_chainId" ? "0x1" : undefined) });
});

test("pacing at prepare level: the 429 root hit is retried; exhausted 429s and stale blocks refuse with their own codes", async () => {
  // the failure root saw: mainnet.base.org eth_maxPriorityFeePerGas HTTP 429, here twice, then answered
  let n429 = 0;
  const ok = await prep({ tamper: (u, m) => { if (u === P.rpcs[0] && m === "eth_maxPriorityFeePerGas" && n429 < 2) { n429++; throw http429(); } } }).prepare();
  assert.equal(ok.status, "prepared");
  assert.equal(ok.plan.transport.retries429, 2);
  assert.ok(ok.plan.transport.requests <= PACING.maxRequests && ok.plan.transport.elapsedMs <= PACING.timeBudgetMs);
  assert.ok(ok.plan.transport.waitedMs >= 1500, "backoff 500 + 1000 ms in virtual time");
  // the same guards still hold after a retry: the plan is the same transaction
  assert.equal(ok.plan.unsignedTx.data, request().data);
  // exhausted: every attempt 429 -> rpc_rate_limited, not a fee/operator classification
  await refuses("rpc_rate_limited", { tamper: (u, m) => { if (u === P.rpcs[0] && m === "eth_maxPriorityFeePerGas") throw http429(); } });
  // a 429 inside the oracle reads is NOT relabelled as an undetermined operator fee
  await refuses("rpc_rate_limited", { tamper: (u, m, p) => { if (m === "eth_call" && p[0].to === P.oracle && p[0].data.startsWith(isIsthmusSel)) throw http429(); } });
  // Retry-After beyond the cap: no wait, refused
  await refuses("rpc_rate_limited", { tamper: (u, m) => { if (u === P.rpcs[1] && m === "eth_chainId") throw http429("30"); } });
  // a non-429 HTTP error is never retried
  await assert.rejects(prep({ tamper: (u, m) => { if (m === "eth_getCode") throw Object.assign(new Error("fake HTTP 503"), { status: 503 }); } }).prepare(), /HTTP 503/);
  // stale: the clock jumps past the freshness window during the LAST read (no later request to hit the time budget)
  const clock = fakeClock();
  await refuses("stale", { clock, tamper: (u, m, p) => { if (u === P.rpcs[1] && m === "eth_call" && p[0].to === P.oracle && p[0].data.startsWith(operatorFeeSel)) clock.t += PACING.freshnessMs + 1; } });
  // ...and a jump earlier in the run hits the overall time budget instead
  const clock2 = fakeClock();
  await refuses("rpc_budget", { clock: clock2, tamper: (u, m) => { if (u === P.rpcs[0] && m === "eth_getBlockByNumber") clock2.t += PACING.timeBudgetMs + 1; } });
});

test("the prepared transaction, executed on the local chain only, lists the canary APPROVED at index 0", async () => {
  const t = prepared.plan.unsignedTx;
  const rc = await sendAs(P.publisher, { to: t.to, data: t.data, gas: "0x" + BigInt(t.gas).toString(16), value: "0x0" });
  assert.equal(BigInt(rc.status), 1n);
  const appId = request().appId;
  const evs = rc.logs.filter((l) => l.address.toLowerCase() === P.catalog).map((l) => { try { return decodeEventLog({ abi: CAT.abi, data: l.data, topics: l.topics }); } catch { return null; } }).filter(Boolean);
  const names = evs.map((e) => e.eventName);
  assert.ok(names.includes("AppCreated") && names.includes("VersionPublished"));
  const appr = evs.find((e) => e.eventName === "VersionApprovalSet");
  assert.ok(appr && appr.args.appId === appId && appr.args.index === 0n && Number(appr.args.status) === 1, "approved on publish");
  assert.ok(!names.includes("VersionFeeSet") || evs.find((e) => e.eventName === "VersionFeeSet").args.feePerSec6 === 0n);
  assert.ok(BigInt(rc.gasUsed) <= BigInt(t.gas));
  const call = async (fn, args) => decodeFunctionResult({ abi: CAT.abi, functionName: fn, data: await raw("eth_call", [{ to: P.catalog, data: encodeFunctionData({ abi: CAT.abi, functionName: fn, args }) }, "latest"]) });
  const v = await call("getVersion", [appId, 0n]);
  assert.equal(v.cid, COMPONENT.cid); assert.equal(v.version, "0.1.0"); assert.equal(Number(v.approval), 1); assert.equal(v.config, '{"wasi":"0.2"}');
  assert.equal(Number(v.memMb), P.request.res[2]); assert.equal(Number(v.cpuGflops), P.request.res[3]);
  assert.equal(await call("versionFee", [appId, 0n]), 0n);
  // ...after which the same preparation refuses: the slug is no longer new (checked before the CID)
  for (let i = 0; i < 3; i++) await mine();
  await assert.rejects(prep().prepare(), (e) => e.code === "listing" && /already has 1 version/.test(e.message));
});
