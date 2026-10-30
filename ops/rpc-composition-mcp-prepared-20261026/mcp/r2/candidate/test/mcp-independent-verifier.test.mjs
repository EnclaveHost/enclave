// The standalone (independent) MCP server's explicit local-verifier selection (standalone-mcp-authority-stage; PREPARED,
// NOT RUN by Claude). REAL modules: mcp/independent.mjs loadConfig + Authority + Scope + VerifierChain, cli/independent.mjs
// loadIndependentTrust, network/chain-authority.mjs createChainAuthority (the established verifier client), against a
// loopback JSON-RPC recorder playing the local verifier. Every request it receives is recorded. A profile written exactly
// as an operator writes it ({format, profiles: {NAME: {...}}}, the repository's real contract pins).
// What this proves: SELECTION and refusal (every read goes to the verifier, at head - confirmations, with the block re-read;
// no RPC list exists; failures refuse). It proves nothing about proofs: the recorder serves none (the real verifier's job).
//   run: node --test test/mcp-independent-verifier.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp, encodeAbiParameters, parseAbi, toFunctionSelector } from "viem";
import { base } from "viem/chains";
import { loadConfig, Authority, Scope, VerifierChain, CONFIG_FORMAT } from "../mcp/independent.mjs";
import { QuorumChain } from "../cli/independent.mjs";
import { createIndependentServer } from "../mcp/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINS_FILE = path.join(ROOT, "contracts/deployments/contract-pins-base.json");
const PINS = JSON.parse(fs.readFileSync(PINS_FILE, "utf8")).contracts;
const HEAD = 0x64, AT = HEAD - 2, Z32 = "0x" + "00".repeat(32);
const SCHEMA_ABI = parseAbi(["function registrySchema() view returns (uint256)"]), SEL = toFunctionSelector("registrySchema()");

/** The local verifier, recorded. opts: stale (1 h old block), chainId, down, hashFor(n, i). */
async function verifier({ stale = false, chainId = "0x2105", down = false, hashFor = () => "0x" + "ab".repeat(32) } = {}) {
  const calls = []; let i = 0;
  const TS = "0x" + Math.floor((Date.now() - (stale ? 3_600_000 : 0)) / 1000).toString(16);
  const blk = (n) => ({ number: "0x" + n.toString(16), hash: hashFor(n, i++), parentHash: "0x" + "aa".repeat(32), timestamp: TS, stateRoot: Z32,
    receiptsRoot: Z32, transactionsRoot: Z32, baseFeePerGas: "0x1", gasLimit: "0x1", gasUsed: "0x0", miner: "0x" + "00".repeat(20), difficulty: "0x0",
    totalDifficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), mixHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32, size: "0x1",
    transactions: [], uncles: [] });
  const answer = (m, p) => {
    if (m === "eth_chainId") return chainId;
    if (m === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (m === "eth_getBlockByNumber") return blk(p[0] === "latest" ? HEAD : Number(BigInt(p[0])));
    if (m === "eth_call") return String(p[0].to).toLowerCase() === PINS.registry && String(p[0].data).startsWith(SEL) ? encodeAbiParameters([{ type: "uint256" }], [4n]) : "0x";
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { const j = JSON.parse(body); const one = (r) => { calls.push({ method: r.method, params: r.params }); return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params || []) }; };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (down) await new Promise((r) => server.close(r));
  return { url, calls, methods: () => calls.map((c) => c.method), close: () => new Promise((r) => (down ? r() : server.close(r))) };
}
/** Write an operator config with ONE profile and load it with the REAL loader. */
function profile(fields) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpv-")), file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ format: CONFIG_FORMAT, profiles: { own: { contractPins: PINS_FILE, stateDir: path.join(dir, "state"), ...fields } } }));
  return { cfg: loadConfig(file).profiles.get("own"), dir };
}
const ready = async (fields) => { const { cfg, dir } = profile(fields); try { return await new Authority(cfg).ready(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };

test("explicit verifier profile: every read goes to the ONE local verifier at head - confirmations; no RPC list exists; the answer says so", async () => {
  const v = await verifier();
  try {
    const a = await ready({ chainAuthority: "verifier", chainVerifier: v.url });
    assert.ok(a.chain instanceof VerifierChain, "the profile's chain is the verifier chain, not a quorum");
    assert.deepEqual([...a.trust.rpcs], []); assert.equal(a.trust.quorum, null); assert.equal(a.trust.chainAuthority, "verifier");
    const s = new Scope(a);
    assert.equal(await s.read(PINS.registry, SCHEMA_ABI, "registrySchema"), 4n, "the value read through the verifier");
    assert.equal(s.block.number, BigInt(AT), "the call's block is head - confirmations (2)");
    const calls = v.calls.filter((c) => c.method === "eth_call");
    assert.ok(calls.length === 1 && BigInt(calls[0].params[1]) === BigInt(AT), `the read is pinned at ${AT}: ${JSON.stringify(calls)}`);
    assert.ok(v.calls.filter((c) => c.method === "eth_getBlockByNumber" && BigInt(c.params[0]) === BigInt(AT)).length >= 2, "the block is read before and after the value");
    const sum = s.summary();
    assert.match(sum.authority, /local-verifier \(proof-backed; unsafe tier, no L1 finality\)/); assert.equal(sum.peers, 1);
  } finally { await v.close(); }
});

test("verifier refusals with their causes - down, stale, wrong chain, block replaced during the read - and nothing else is asked", async () => {
  const cases = [[{ down: true }, /local verifier is unavailable/], [{ stale: true }, /stale or in the future/], [{ chainId: "0x1" }, /follows chain 1, not 8453/]];
  for (const [opts, cause] of cases) {
    const v = await verifier(opts);
    try {
      const a = await ready({ chainAuthority: "verifier", chainVerifier: v.url });
      await assert.rejects(new Scope(a).read(PINS.registry, SCHEMA_ABI, "registrySchema"), cause, JSON.stringify(opts));
      assert.ok(!v.methods().includes("eth_call") || opts.down, "no value is read from a refused verifier");
    } finally { await v.close(); }
  }
  const moving = await verifier({ hashFor: (n, i) => "0x" + (i > 0 ? "ee" : "ab").repeat(32) });   // the block changes after the first read
  try {
    const a = await ready({ chainAuthority: "verifier", chainVerifier: moving.url });
    await assert.rejects(new Scope(a).read(PINS.registry, SCHEMA_ABI, "registrySchema"), (e) => (e.failures || []).some((f) => /block replaced during the read/.test(f)));
  } finally { await moving.close(); }
});

test("ambiguous or invalid selections are refused before anything is read (rpcs or quorum beside the verifier, no/remote verifier, unknown authority)", async () => {
  const v = await verifier();
  try {
    for (const [fields, why] of [
      [{ chainAuthority: "verifier", chainVerifier: v.url, rpcs: ["https://a.example/", "https://b.example/"] }, /rpcs must be absent/],
      [{ chainAuthority: "verifier", chainVerifier: v.url, quorum: 2 }, /quorum must be absent/],
      [{ chainAuthority: "verifier" }, /needs chainVerifier/],
      [{ chainAuthority: "verifier", chainVerifier: "http://example.com/" }, /local endpoint|loopback/],
      [{ chainAuthority: "bogus", chainVerifier: v.url }, /quorum or verifier/],
    ]) await assert.rejects(ready(fields), why, JSON.stringify(fields));
    assert.equal(v.calls.length, 0, "a refused selection reads nothing");
  } finally { await v.close(); }
});

// The mark DISTINGUISHES createChainAuthority's clients from ordinary RPC clients; it is not a security boundary against
// in-process code (Symbol.for is global). What is asserted: an ordinary client and an unregistered look-alike are refused.
test("the verifier chain accepts ONLY the marked local-verifier client: an ordinary RPC client never stands in for it", () => {
  const plain = createPublicClient({ chain: base, transport: viemHttp("http://127.0.0.1:9/") });
  assert.throws(() => new VerifierChain({ client: plain }), /one ordinary RPC never decides/);
  assert.throws(() => new VerifierChain({ client: { [Symbol("enclave.chain-authority.local-verifier")]: true } }), /local verifier client/, "a look-alike symbol is not the mark");
});

test("legacy profiles are unchanged: no chainAuthority keeps the RPC quorum (and an existing chainVerifier keeps its narrower meaning)", async () => {
  const clients = [{ origin: "https://a.example", client: {} }, { origin: "https://b.example", client: {} }];
  for (const fields of [{ rpcs: ["https://a.example/", "https://b.example/"] }, { rpcs: ["https://a.example/", "https://b.example/"], chainAuthority: "quorum" }]) {
    const { cfg, dir } = profile(fields);
    try {
      const a = await new Authority(cfg, { clients }).ready();
      assert.ok(a.chain instanceof QuorumChain && !(a.chain instanceof VerifierChain)); assert.equal(a.chain.quorum, 2); assert.equal(a.trust.chainAuthority, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const v = await verifier();
  const { cfg, dir } = profile({ rpcs: ["https://a.example/", "https://b.example/"], chainVerifier: v.url });
  try {
    // the EXISTING narrower meaning is kept: the quorum serves every tool read; chainVerifier serves only the LeaseReader reads
    const a = await new Authority(cfg, { clients }).ready();
    assert.ok(a.chain instanceof QuorumChain && !(a.chain instanceof VerifierChain)); assert.equal(a.trust.chainVerifier, v.url); assert.equal(a.trust.chainAuthority, undefined);
    assert.equal(v.calls.length, 0, "building a legacy profile reads nothing from the verifier");
  } finally { await v.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a legacy profile without RPCs is still refused (the quorum rule is not weakened by the new selection)", async () => {
  await assert.rejects(ready({}), /RPC/i);
});

// ---- r2: the PUBLIC tool path for custody v2 secrets, and recorded network destinations ------------------------------
/** Record every fetch this process makes (the verifier client, the custodian client and any default all use fetch). */
function fetchSpy() {
  const real = globalThis.fetch, urls = [];
  globalThis.fetch = (u, init) => { urls.push(String(u?.url ?? u)); return real(u, init); };
  return { urls, restore: () => { globalThis.fetch = real; } };
}
const callTool = (server, name, args) => server.dispatch({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const ID = "0x" + "12".repeat(32);

test("custody v2 secret tools on a verifier profile (local AND remote adapter, the real tools/call path) refuse before ANY chain, custodian or network read", async () => {
  const v = await verifier(), spy = fetchSpy();
  const { cfg, dir } = profile({ chainAuthority: "verifier", chainVerifier: v.url });
  try {
    for (const [remote, name, args] of [[false, "get_secrets", { id: ID }], [false, "set_secrets", { id: ID }],
                                        [true, "get_secrets", { id: ID, action: "prepare" }], [true, "set_secrets", { id: ID, action: "prepare" }]]) {
      const server = createIndependentServer(cfg, {}, { remote });
      const r = await callTool(server, name, args);
      const text = r?.result?.content?.[0]?.text ?? JSON.stringify(r);
      assert.equal(r?.result?.isError, true, `${remote ? "remote" : "local"} ${name}: ${text}`);
      assert.match(text, /reads the chain through its local verifier: custody v2 secrets are not served under it \(custody v2 stays refused until separately qualified\); nothing was read/,
        `${remote ? "remote" : "local"} ${name} refuses with the custody v2 reason: ${text}`);
    }
    assert.equal(v.calls.length, 0, `no chain read reached the verifier: ${v.methods()}`);
    assert.deepEqual(spy.urls, [], "no request of any kind left this process (no custodian, no default RPC)");
  } finally { spy.restore(); await v.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("existing quorum secrets functionality is unchanged: on a quorum profile get_secrets proceeds to its chain reads (no verifier refusal)", async () => {
  const seen = [];
  const peer = (origin) => ({ origin, client: { getChainId: async () => { seen.push(`${origin} chainId`); throw new Error("offline fixture"); },
    getBlockNumber: async () => { seen.push(`${origin} head`); throw new Error("offline fixture"); }, getBlock: async () => { throw new Error("offline fixture"); } } });
  const { cfg, dir } = profile({ rpcs: ["https://a.example/", "https://b.example/"] });
  try {
    const server = createIndependentServer(cfg, { clients: [peer("https://a.example"), peer("https://b.example")] });
    const r = await callTool(server, "get_secrets", { id: ID });
    const text = r?.result?.content?.[0]?.text ?? JSON.stringify(r);
    assert.equal(r?.result?.isError, true);
    assert.doesNotMatch(text, /custody v2 secrets are not served/, "the verifier refusal never applies to a quorum profile");
    assert.match(text, /quorum|RPCs/i, `the quorum path ran and refused only for the offline fixture: ${text}`);
    assert.ok(seen.some((x) => x.startsWith("https://a.example")) && seen.some((x) => x.startsWith("https://b.example")), `both quorum peers were asked: ${seen}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("recorded destinations: stale, replaced and unavailable verifier cases contact ONLY the configured verifier - never a public default", async () => {
  const PUBLIC = /publicnode|drpc|1rpc|mainnet\.base\.org|blastapi|tenderly|nodies|llamarpc|ankr|alchemy|infura/;
  const cases = [[{ stale: true }, /stale or in the future/], [{ hashFor: (n, i) => "0x" + (i > 0 ? "ee" : "ab").repeat(32) }, /no 1 RPCs agreed|block replaced/],
                 [{ down: true }, /local verifier is unavailable/]];
  for (const [opts, cause] of cases) {
    const v = await verifier(opts), spy = fetchSpy();
    try {
      const a = await ready({ chainAuthority: "verifier", chainVerifier: v.url });
      await assert.rejects(new Scope(a).read(PINS.registry, SCHEMA_ABI, "registrySchema"), cause, JSON.stringify(Object.keys(opts)));
      assert.ok(spy.urls.length > 0, "the verifier was tried");
      assert.ok(spy.urls.every((u) => u === v.url), `only the configured verifier was contacted: ${spy.urls}`);
      assert.ok(!spy.urls.some((u) => PUBLIC.test(u)), "no public default");
    } finally { spy.restore(); await v.close(); }
  }
});
