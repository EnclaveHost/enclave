// `enclave deploy` against a ledger that is not yet visible everywhere the
// moment its create mines (seen live 2026-09-26: fund's gas estimate reverted
// "unknown" and the relay's secrets gate 404'd the new id, seconds after the
// create's receipt). Same offline double as cli.test.mjs - real signed
// transactions, real calldata decoded - but TWO stub RPCs (ENCLAVE_RPC takes a
// comma list), each able to lag on get(id), and a relay that can 404 the id.
// ENCLAVE_VISIBLE_WAIT is kept small so the polls and pauses cost milliseconds.
//
//   run: node --test test/cli-deploy-visibility.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "cli", "enclave.mjs");
// the live rev-3 create + list prices ride along, as in cli.test.mjs (the stub plays rev 3)
const CREATE_LEGACY = { type: "function", name: "create", stateMutability: "nonpayable",
  inputs: [{ name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
           { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
           { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
           { name: "configCid", type: "string" }],
  outputs: [{ type: "bytes32" }] };
const PRICE_LEGACY = ["pricePerSec6", "cpuPricePerSec6"].map((name) => ({
  type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }));
const DEP_ABI = [...JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveDeployments.abi.json"), "utf8")),
                 CREATE_LEGACY, ...PRICE_LEGACY];
const CAT_ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveAppCatalog.abi.json"), "utf8"));
const ERC20_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const REVERT_ABI = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }];

const PK = "0x" + "11".repeat(32);
const OWNER = privateKeyToAccount(PK).address;
const CLI_SRC = fs.readFileSync(CLI, "utf8");
const cliDefault = (key) => CLI_SRC.match(new RegExp(key + String.raw`:\s*"(0x[0-9a-fA-F]{40})"`))[1].toLowerCase();
const DEPLOYMENTS = cliDefault("DEPLOYMENTS_ADDRESS");
const CATALOG = cliDefault("APP_CATALOG_ADDRESS");
const DEP_CREATED_TOPIC = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239";
const ID = "0x" + "ab".repeat(32);
const APP_ID = "0x" + "cd".repeat(32);
const ZERO32 = "0x" + "0".repeat(64), ZERO20 = "0x" + "0".repeat(40);

// ---- the platform double -------------------------------------------------------
// one shared chain (txs, the funded balance) seen through two RPCs that may lag
const S = {};
const events = [];                         // ordered: "A:get:hidden", "B:get:seen", "tx:create", "api:secrets:404", ...
function reset({ rpc = {}, ...over } = {}) {
  events.length = 0;
  // per reader: `lag` get(id) reads that miss the record, `unknownEstimates` fund estimates that revert "unknown"
  const reader = (o) => ({ lag: 0, unknownEstimates: 0, estimates: [], ...o });
  Object.assign(S, { txs: [], balance6: 0n, created: false, rpc: { A: reader(rpc.A), B: reader(rpc.B) },
    relayLag: 0, secrets404: 0, secretsPosts: 0,
    fundOnUnknown: false,                  // the first "unknown" estimate also lands the money (the double-fund guard's case)
    ...over });
}

function rpcServer(name) {
  const record = (seen) => ({
    id: seen ? ID : ZERO32, owner: seen ? OWNER : ZERO20, appRef: seen ? `catalog://${APP_ID}/0` : "",
    ports: "", configCid: "", gpuMilli: 0, cpuMilli: seen ? 50 : 0, appPort: 0, isPublic: seen, active: seen,
    createdAt: 0n, rate: seen ? 28n : 0n, balance6: seen ? S.balance6 : 0n, spent6: 0n,
    runner: ZERO32, runnerOperator: ZERO20, leaseUntil: 0n });
  const version = { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", version: "1",
    vramMb: 0, gpuGflops: 0, memMb: 256, cpuGflops: 10, createdAt: 1n, verified: true, yanked: false,
    ports: "http:8088", approval: 1, config: "" };
  function call(to, data) {
    const abi = to === DEPLOYMENTS ? DEP_ABI : to === CATALOG ? CAT_ABI : ERC20_ABI;
    const { functionName, args } = decodeFunctionData({ abi, data });
    const me = S.rpc[name];
    const out = {
      balanceOf: () => [100_000000n],
      pricePerSec6: () => [1667n], cpuPricePerSec6: () => [556n],
      deploymentsSchema: () => [3n], catalogSchema: () => [4n],
      get: () => {
        // this RPC's view: the record only once created AND its lag has run out
        const seen = S.created && args[0] === ID && !(me.lag > 0 && me.lag--);
        events.push(`${name}:get:${seen ? "seen" : "hidden"}`);
        return [record(seen)];
      },
      getAppsPage: () => [Number(args[0]) === 0 ? [{ appId: APP_ID, publisher: OWNER, slug: "hello-world",
        name: "Hello World", description: "", versionCount: 1, createdAt: 1n, updatedAt: 1n, active: true }] : []],
      getVersionsPage: () => [Number(args[1]) === 0 ? [version] : []],
    }[functionName];
    if (!out) throw new Error("unhandled eth_call: " + functionName);   // maxGpuMilli: the CLI reads a failure as uncapped
    const result = out();
    return encodeFunctionResult({ abi, functionName, result: result.length === 1 ? result[0] : result });
  }
  return http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    const fail = (error) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, error })); };
    try {
      switch (method) {
        case "eth_chainId": return reply("0x2105");
        case "eth_blockNumber": return reply("0x100");
        case "eth_getBalance": return reply("0xde0b6b3a7640000");
        case "eth_getTransactionCount": return reply("0x" + S.txs.length.toString(16));
        case "eth_maxPriorityFeePerGas": return reply("0xf4240");
        case "eth_gasPrice": return reply("0x3b9aca00");
        case "eth_getBlockByNumber": return reply({ number: "0x100", hash: "0x" + "12".repeat(32),
          baseFeePerGas: "0x3b9aca00", timestamp: "0x0", transactions: [] });
        case "eth_estimateGas": {
          const tx = params[0];
          if (String(tx.to).toLowerCase() === DEPLOYMENTS && tx.data) {
            const dec = decodeFunctionData({ abi: DEP_ABI, data: tx.data });
            if (dec.functionName === "fundWithAuthorization") {
              const me = S.rpc[name];
              me.estimates.push(dec.args[5]);                 // the authorization nonce this estimate carried
              events.push(`${name}:estimate:fund`);
              // the ledger's require(_exists[id], "unknown"), from a node without the record
              if (me.unknownEstimates > 0) {
                me.unknownEstimates--;
                if (S.fundOnUnknown) { S.fundOnUnknown = false; S.balance6 += dec.args[2]; }
                return fail({ code: 3, message: "execution reverted: unknown",
                  data: encodeErrorResult({ abi: REVERT_ABI, errorName: "Error", args: ["unknown"] }) });
              }
            }
          }
          return reply("0x30000");
        }
        case "eth_call": return reply(call(params[0].to.toLowerCase(), params[0].data));
        case "eth_sendRawTransaction": {
          const tx = parseTransaction(params[0]);
          const dec = decodeFunctionData({ abi: DEP_ABI, data: tx.data });
          const hash = "0x" + (70 + S.txs.length).toString(16).padStart(64, "0");
          S.txs.push({ hash, ...dec });
          events.push(`tx:${dec.functionName}`);
          if (dec.functionName === "create") S.created = true;
          if (dec.functionName === "fundWithAuthorization") S.balance6 += dec.args[2];
          return reply(hash);
        }
        case "eth_getTransactionReceipt": {
          const tx = S.txs.find((t) => t.hash === params[0]);
          const logs = tx?.functionName === "create"
            ? [{ address: DEPLOYMENTS, topics: [DEP_CREATED_TOPIC, ID, "0x" + OWNER.slice(2).padStart(64, "0")], data: "0x",
                 blockNumber: "0x100", blockHash: "0x" + "12".repeat(32), transactionHash: params[0],
                 transactionIndex: "0x0", logIndex: "0x0", removed: false }] : [];
          return reply({ transactionHash: params[0], transactionIndex: "0x0", blockNumber: "0x100",
            blockHash: "0x" + "12".repeat(32), from: OWNER, to: DEPLOYMENTS, contractAddress: null,
            cumulativeGasUsed: "0x30000", gasUsed: "0x30000", effectiveGasPrice: "0x3b9aca00",
            status: "0x1", type: "0x2", logsBloom: "0x" + "0".repeat(512), logs });
        }
        default: throw new Error("unhandled rpc method: " + method);
      }
    } catch (e) { fail({ code: -32000, message: e.message }); }
  });
}

function apiServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = ""; for await (const c of req) body += c;
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/v1/pricing")
      return json(200, { node: { vcpus: 32, ramGb: 32, gflops: 200 }, card: {} });
    if (u.pathname === "/availability") return json(200, { aggregate: true, secrets: true });
    if (u.pathname === "/v1/claim-hint") return json(200, { accepted: true });
    // the relay's tokenless record read: answers from its own ledger cache
    if (u.pathname === `/v1/deployments/${ID}` && req.method === "GET" && !req.headers.authorization) {
      const seen = S.created && !(S.relayLag > 0 && S.relayLag--);
      events.push(`api:record:${seen ? "seen" : "404"}`);
      return seen ? json(200, { id: ID, owner: OWNER, status: "queued" })
                  : json(404, { error: "not_found", message: `No live enclave has ${ID}, and the ledger has no deployment under it.` });
    }
    if (u.pathname === `/v1/secrets/${ID}` && req.method === "POST") {
      S.secretsPosts++;
      const { payload } = JSON.parse(body);
      if (S.secrets404 > 0) {
        S.secrets404--;
        events.push("api:secrets:404");
        return json(404, { error: "not_found", message: `No deployment ${ID} on the ledger.` });
      }
      events.push("api:secrets:200");
      return json(200, { id: ID, rev: 1, names: Object.keys(JSON.parse(payload).set).sort() });
    }
    json(404, { error: "no_route", path: u.pathname });
  });
}

// ---- harness ---------------------------------------------------------------------
let apiPort, rpcA, rpcB, confDir;
const servers = [];
test.before(async () => {
  confDir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-cli-vis-"));
  for (const [mk, set] of [[apiServer, (p) => apiPort = p], [() => rpcServer("A"), (p) => rpcA = p], [() => rpcServer("B"), (p) => rpcB = p]]) {
    const s = mk(); servers.push(s);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    set(s.address().port);
  }
});
test.after(() => servers.forEach((s) => s.close()));

function run(cliArgs, { wait = "2" } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...cliArgs, "--yes"], {
      env: { ...process.env, ENCLAVE_KEY: PK,
             ENCLAVE_API_BASE: `http://127.0.0.1:${apiPort}`,
             // A first: pub()'s fallback sends every read and tx there; B is the second reader
             ENCLAVE_RPC: `http://127.0.0.1:${rpcA},http://127.0.0.1:${rpcB}`,
             ENCLAVE_ADDRESS_BOOK: "", ENCLAVE_VISIBLE_WAIT: wait, XDG_CONFIG_HOME: confDir },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const funds = () => S.txs.filter((t) => t.functionName === "fundWithAuthorization");
const DEPLOY = ["deploy", "hello-world:1", "--fund", "2", "--no-wait"];

// ---- tests -----------------------------------------------------------------------
test("deploy waits until EVERY RPC sees the new record, then funds exactly once", async () => {
  reset({ rpc: { B: { lag: 3 } } });                     // B misses the record for three reads
  const r = await run(DEPLOY);
  assert.equal(r.code, 0, r.err);
  assert.equal(funds().length, 1, "funded exactly once");
  assert.equal(funds()[0].args[2], 2_000000n);
  assert.equal(events.filter((e) => e === "B:get:hidden").length, 3, "B was polled through its lag");
  const firstBSeen = events.indexOf("B:get:seen"), firstEstimate = events.indexOf("A:estimate:fund");
  assert.ok(firstBSeen >= 0 && firstEstimate > firstBSeen, `no funding step before B saw the record: ${events.join(" ")}`);
  assert.match(r.out, /waiting for the new record to reach every RPC…/);
  assert.match(r.out, /funded \$2\.00/);
});

test("an 'unknown' estimate revert is retried once, with the SAME signed authorization", async () => {
  reset({ rpc: { A: { unknownEstimates: 1 } } });
  const r = await run(DEPLOY);
  assert.equal(r.code, 0, r.err);
  assert.equal(S.rpc.A.estimates.length, 2, "one retry");
  assert.equal(S.rpc.A.estimates[0], S.rpc.A.estimates[1], "one EIP-3009 nonce: at most one of the two can ever land");
  assert.equal(funds().length, 1);
  assert.match(r.out, /retrying once/);
  assert.match(r.out, /funded \$2\.00/);
});

test("an estimate that keeps reverting 'unknown' stops after ONE retry and sends no money", async () => {
  reset({ rpc: { A: { unknownEstimates: 99 } } });
  const r = await run(DEPLOY);
  assert.equal(r.code, 1);
  assert.equal(S.rpc.A.estimates.length, 2, "one retry, never two");
  assert.equal(funds().length, 0);
  assert.equal(S.balance6, 0n);
  assert.match(r.err, /created but NOT funded \(.*unknown/s);
  assert.match(r.err, new RegExp(`top up later: enclave fund ${ID} --usdc 2`));
});

test("before the retry, the balance is re-read: money that already arrived is never sent again", async () => {
  // the first attempt's funds land even though its estimate reported "unknown"
  reset({ rpc: { A: { unknownEstimates: 1 } }, fundOnUnknown: true });
  const r = await run(DEPLOY);
  assert.equal(r.code, 0, r.err);
  assert.equal(S.rpc.A.estimates.length, 1, "no second attempt");
  assert.equal(funds().length, 0, "no second funding tx");
  assert.equal(S.balance6, 2_000000n, "funded once");
  assert.match(r.out, /balance already moved; not sending again/);
});

test("with secrets: the relay's 404 for the new id is waited out before they are staged", async () => {
  reset({ relayLag: 2 });
  const r = await run([...DEPLOY, "--secrets", '{"S3_KEY":"v"}']);
  assert.equal(r.code, 0, r.err);
  assert.equal(events.filter((e) => e === "api:record:404").length, 2);
  const seen = events.indexOf("api:record:seen"), put = events.indexOf("api:secrets:200");
  assert.ok(seen >= 0 && put > seen, `secrets staged only once the relay saw the record: ${events.join(" ")}`);
  assert.equal(S.secretsPosts, 1);
  assert.ok(events.indexOf("tx:fundWithAuthorization") > put, "staged before funding");
  assert.match(r.out, /secrets staged \(rev 1\): S3_KEY/);
});

test("a secrets 404 that slips past the wait is retried once, never twice", async () => {
  reset({ secrets404: 1 });
  let r = await run([...DEPLOY, "--secrets", '{"S3_KEY":"v"}']);
  assert.equal(r.code, 0, r.err);
  assert.equal(S.secretsPosts, 2);
  assert.match(r.out, /secrets staged \(rev 1\)/);

  reset({ secrets404: 99 });
  r = await run([...DEPLOY, "--secrets", '{"S3_KEY":"v"}']);
  assert.equal(r.code, 0, r.err);
  assert.equal(S.secretsPosts, 2, "one retry, never two");
  assert.match(r.out, /secrets NOT stored/);
  assert.equal(funds().length, 1, "a secrets failure still leaves the deployment funded, as before");
});

test("timeout: says the deployment exists unfunded and how to fund it; no funding is attempted", async () => {
  reset({ rpc: { B: { lag: 1e9 } } });
  const r = await run([...DEPLOY, "--secrets", '{"S3_KEY":"v"}'], { wait: "0.5" });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`created ${ID}, but after 0\\.5s 127\\.0\\.0\\.1:${rpcB} still can't see it`));
  assert.match(r.err, /exists on-chain, NOT funded/);
  // secrets first, as deploy itself orders them: claims only chase funded work
  assert.match(r.err, new RegExp(`stage its secrets \\(enclave secrets set ${ID} KEY=VALUE…\\), then fund it: enclave fund ${ID} --usdc 2`));
  assert.equal(S.rpc.A.estimates.length + S.rpc.B.estimates.length, 0, "no fund attempt");
  assert.equal(funds().length, 0);
  assert.equal(S.secretsPosts, 0);
});
