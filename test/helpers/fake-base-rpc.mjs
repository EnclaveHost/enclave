// A fake Base JSON-RPC for node tests, so nothing reaches a public RPC. windows/node/chain.mjs reads BASE_RPCS when it
// LOADS, so a test calls fakeBaseRpc() and only then imports host.mjs / chain.mjs, dynamically (a static import is
// evaluated before any of the test's own code). It answers eth_chainId and the deployments contract's get(id) from
// `row.current`, its count() and getPage() (chain.allDeployments, the ledger scan) from `rows.current` when a test sets
// it, and the app catalog's getVersion (at CATALOG) from `catalog.current`. Every other call is an RPC error,
// which the node reads as a failed read, never as an answer.
// (enclave-d1's reviewer found this seam: chain.addresses is writable, so no code change is needed.)
import http from "node:http";
import { encodeFunctionResult, decodeFunctionData, keccak256, toBytes } from "viem";

const ROW = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
  { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
  { name: "leaseUntil", type: "uint64" }];
const GET_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
  outputs: [{ type: "tuple", components: ROW }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view", inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: ROW }] }];
export const DEPLOYMENTS = "0x" + "d0".repeat(20);
// the app catalog's getVersion, as windows/node/chain.mjs CATALOG_ABI declares it (a copy: that ABI is not exported)
const CATALOG_ABI = [{ type: "function", name: "getVersion", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }],
  outputs: [{ type: "tuple", components: [
    { name: "cid", type: "string" }, { name: "version", type: "string" }, { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
    { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" }, { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
    { name: "yanked", type: "bool" }, { name: "ports", type: "string" }, { name: "approval", type: "uint8" }, { name: "config", type: "string" }] }] }];
export const CATALOG = "0x" + "ca".repeat(20);
/** the enclave id a Host with this endpoint registers as */
export const enclaveIdOf = (endpoint) => keccak256(toBytes(endpoint));

export async function fakeBaseRpc() {
  const row = { current: null };
  const rows = { current: null };                    // the whole ledger for count()/getPage(); null = not served
  const catalog = { current: null };                 // what getVersion answers (a tuple per CATALOG_ABI); set per test
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const one = (m) => {
      calls.push(m.method);
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x2105" };
      if (m.method === "eth_call" && String(m.params?.[0]?.to || "").toLowerCase() === DEPLOYMENTS) {
        try {
          const { functionName, args } = decodeFunctionData({ abi: GET_ABI, data: m.params[0].data || m.params[0].input });
          if (functionName === "get" && row.current)
            return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: GET_ABI, functionName: "get", result: row.current }) };
          if (functionName === "get" && rows.current) {
            const hit = rows.current.find((r) => String(r.id).toLowerCase() === String(args[0]).toLowerCase());
            if (hit) return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: GET_ABI, functionName: "get", result: hit }) };
          }
          if (functionName === "count" && rows.current)
            return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: GET_ABI, functionName: "count", result: BigInt(rows.current.length) }) };
          if (functionName === "getPage" && rows.current) {
            const page = rows.current.slice(Number(args[0]), Number(args[0]) + Number(args[1]));
            return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: GET_ABI, functionName: "getPage", result: page }) };
          }
        } catch { /* not a get: an error below */ }
      }
      if (m.method === "eth_call" && String(m.params?.[0]?.to || "").toLowerCase() === CATALOG && catalog.current) {
        try {
          const { functionName } = decodeFunctionData({ abi: CATALOG_ABI, data: m.params[0].data || m.params[0].input });
          if (functionName === "getVersion")
            return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: CATALOG_ABI, functionName: "getVersion", result: catalog.current }) };
        } catch { /* another catalog call (catalogSchema): an error below, read as an older catalog */ }
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `fake rpc: ${m.method} is not served` } };
    };
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.BASE_RPCS = `http://127.0.0.1:${server.address().port}`;
  return { row, rows, catalog, calls, close: () => server.close() };
}
