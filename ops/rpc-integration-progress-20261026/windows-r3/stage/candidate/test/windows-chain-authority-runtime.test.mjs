// The Windows node's remaining chain consumers under the explicit chain authority (windows-chain-authority-stage r2; PREPARED,
// NOT RUN by Claude). Real modules, loopback JSON-RPC recorders only (a local VERIFIER, an OWN BACKEND, a PUBLIC sentinel that
// stands in for BASE_RPCS and any public RPC); every request each recorder receives is recorded and asserted.
//   * chain.mjs (child process: its authority is read from the environment at load, as on a box): reads -> verifier, the
//     operator send -> own backend (pending nonce + exactly one submission), no public request; verifier down / no backend /
//     invalid selection refuse; legacy unchanged; chainAuthoritySelection() for the agent;
//   * the shielded startup reader: host-identity.mjs verifierReader over the REAL chain.mjs authority client - the same
//     per-read policy as quorumReader (head - confirmations, block re-read, reorg and staleness refused), no fallback;
//   * the privacy agent's chain: network-enroll.mjs baseConfig/agentChain -> the REAL network/lease-reader.mjs LeaseReader
//     built exactly as network/privacy-agent.mjs builds it ({...cfg.chain}) -> its reads reach the verifier only;
//   * wallet host admission: network/host-admission-runtime.mjs hostAdmissionFromEnv with rpc [] under the verifier.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const CHAIN = root("windows/node/chain.mjs"), IDENTITY = root("windows/node/host-identity.mjs"), ENROLL = root("windows/node/network-enroll.mjs");
const LEASE_READER = root("network/lease-reader.mjs"), ADMISSION = root("network/host-admission-runtime.mjs");
const KEY = "0x" + "11".repeat(32), TO = "0x" + "22".repeat(20), BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const HEAD = 0x64, TXH = "0x" + "cd".repeat(32);
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

/** A JSON-RPC recorder. opts: {role, down, hashFor(n, callIndex) -> hash, stale}. */
async function recorder(role, { down = false, hashFor = () => "0x" + "ab".repeat(32), stale = false } = {}) {
  const calls = []; let blockCalls = 0;
  const blk = (n) => ({ number: "0x" + n.toString(16), hash: hashFor(n, blockCalls++), parentHash: "0x" + "aa".repeat(32),
    timestamp: "0x" + Math.floor((Date.now() - (stale ? 3_600_000 : 0)) / 1000).toString(16), baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380",
    gasUsed: "0x0", miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256),
    mixHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), size: "0x1",
    stateRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), transactions: [], uncles: [] });
  const receipt = { transactionHash: TXH, transactionIndex: "0x0", blockHash: "0x" + "ab".repeat(32), blockNumber: "0x" + HEAD.toString(16),
    from: "0x" + "00".repeat(20), to: TO, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca01", contractAddress: null,
    logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2" };
  const answer = (m, p) => {
    if (m === "eth_chainId") return "0x2105";
    if (m === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (m === "eth_getBlockByNumber") { const tag = p[0]; return blk(tag === "latest" || tag === "pending" ? HEAD : Number(BigInt(tag))); }
    if (m === "eth_getBlockByHash") return blk(HEAD);
    if (role === "backend") {
      if (m === "eth_getTransactionCount") return "0x5";
      if (m === "eth_maxPriorityFeePerGas" || m === "eth_gasPrice") return "0x1";
      if (m === "eth_feeHistory") return { oldestBlock: "0x63", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x1"]] };
      if (m === "eth_sendRawTransaction") return TXH;
      return null;
    }
    if (m === "eth_call") return word(7);
    if (m === "eth_estimateGas") return "0x5208";
    if (m === "eth_getTransactionCount") return "0x5";
    if (m === "eth_getTransactionReceipt") return p[0] === TXH ? receipt : null;
    if (m === "eth_maxPriorityFeePerGas" || m === "eth_gasPrice") return "0x1";
    if (m === "eth_sendRawTransaction") return TXH;
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const one = (r) => { calls.push({ method: r.method, params: r.params }); return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params || []) }; };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (down) await new Promise((r) => server.close(r));
  return { url, calls, methods: () => calls.map((c) => c.method), close: () => new Promise((r) => (down ? r() : server.close(r))) };
}

/** Run `body` (an async module script with `out` in scope) in a child with `env`; returns out. */
function child(env, body) {
  const script = `const out = {}; const run = async (k, f) => { try { const v = await f(); out[k] = { ok: typeof v === "bigint" ? String(v) : v === undefined ? null : JSON.parse(JSON.stringify(v, (_, x) => typeof x === "bigint" ? String(x) : x)) }; } catch (e) { out[k] = { err: String(e.shortMessage || e.message) }; } };
    ${body}
    process.stdout.write("\\n@@" + JSON.stringify(out) + "\\n"); process.exit(0);`;
  return new Promise((resolve, reject) => {
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BASE_RPCS|ENCLAVE_CHAIN_|NODE_OPERATOR_KEY|ENCLAVE_LEASE_GAS_|LEASE_GAS_|ENCLAVE_HOST_|ENCLAVE_STARTUP_)/.test(k)));
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...keep, NODE_OPERATOR_KEY: KEY, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = ""; p.stdout.on("data", (c) => (o += c)); p.stderr.on("data", (c) => (e += c));
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("child timed out: " + e.slice(-500))); }, 90_000);
    p.on("close", () => { clearTimeout(t); const m = o.match(/@@(.*)\n/); m ? resolve(JSON.parse(m[1])) : reject(new Error("no result: " + e.slice(-800))); });
  });
}
const J = JSON.stringify;
const ABI = `[{ type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }, { type: "function", name: "ping", stateMutability: "nonpayable", inputs: [], outputs: [] }]`;
const chainSteps = `const chain = await import(${J(CHAIN)}); const abi = ${ABI};
  await run("read", () => chain.blockNumber());
  await run("readContract", () => chain.publicClient().readContract({ address: ${J(TO)}, abi, functionName: "count" }));
  chain.loadOperator(); await run("send", () => chain.sendOperatorTx(${J(TO)}, abi, "ping", []));
  out.urls = chain.rpcUrls(); out.selection = chain.chainAuthoritySelection();`;

test("chain.mjs, verifier + own backend: reads -> verifier, pending nonce + one submission -> backend, no public request", async () => {
  const v = await recorder("verifier"), b = await recorder("backend"), pub = await recorder("public");
  try {
    const r = await child({ BASE_RPCS: pub.url, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_CHAIN_TX_BACKEND: b.url }, chainSteps);
    assert.equal(r.read.ok, String(HEAD), J(r)); assert.equal(r.readContract.ok, "7"); assert.equal(r.send.ok, TXH, J(r.send));
    assert.deepEqual(r.urls, []); assert.deepEqual(r.selection, { authority: "verifier", verifier: v.url });
    assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
    assert.ok(!v.methods().includes("eth_sendRawTransaction"), "never a transaction to the read-only verifier");
    assert.equal(b.methods().filter((m) => m === "eth_sendRawTransaction").length, 1);
    assert.ok(b.calls.some((c) => c.method === "eth_getTransactionCount" && c.params?.[1] === "pending"));
    for (const m of ["eth_call", "eth_getTransactionReceipt", "eth_estimateGas"]) assert.ok(!b.methods().includes(m), `${m} never asked of the backend`);
  } finally { await v.close(); await b.close(); await pub.close(); }
});

test("chain.mjs refusals: verifier down, no backend, invalid selections - nothing sent, no public fallback; legacy unchanged", async () => {
  const pub = await recorder("public"), b = await recorder("backend"), vdown = await recorder("verifier", { down: true }), v = await recorder("verifier");
  try {
    const down = await child({ BASE_RPCS: pub.url, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: vdown.url, ENCLAVE_CHAIN_TX_BACKEND: b.url }, chainSteps);
    assert.ok(down.read.err && down.send.err);
    const nob = await child({ BASE_RPCS: pub.url, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url }, chainSteps);
    assert.equal(nob.read.ok, String(HEAD)); assert.ok(nob.send.err && /backend/i.test(nob.send.err), J(nob.send));
    for (const env of [{ ENCLAVE_CHAIN_AUTHORITY: "bogus" }, { ENCLAVE_CHAIN_AUTHORITY: "verifier" }, { ENCLAVE_CHAIN_TX_BACKEND: b.url },
                       { ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://example.com/" }]) {
      const r = await child({ BASE_RPCS: pub.url, ...env }, chainSteps);
      assert.ok(r.read.err && r.send.err, J(env)); assert.deepEqual(r.urls, []); assert.ok(r.selection && typeof r.selection.invalid === "string", J(r.selection));
    }
    assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
    assert.ok(!b.methods().includes("eth_sendRawTransaction") && !v.methods().includes("eth_sendRawTransaction"));
    const legacy = await child({ BASE_RPCS: pub.url }, `const chain = await import(${J(CHAIN)}); await run("read", () => chain.blockNumber()); out.urls = chain.rpcUrls(); out.selection = chain.chainAuthoritySelection();`);
    assert.equal(legacy.read.ok, String(HEAD)); assert.deepEqual(legacy.urls, [pub.url]); assert.equal(legacy.selection, null);
  } finally { await pub.close(); await b.close(); await vdown.close(); await v.close(); }
});

const startupSteps = (fn) => `const chain = await import(${J(CHAIN)}); const { verifierReader, quorumReader } = await import(${J(IDENTITY)});
  const a = chain.chainAuthority(); const abi = ${ABI};
  await run("plainClientRefused", () => verifierReader({ client: chain.publicClient === undefined ? null : { getChainId() {}, getBlockNumber() {}, getBlock() {} } }));
  await run("singleQuorumRefused", () => quorumReader({ clients: [a.client] }));
  const reader = verifierReader({ client: a.client, deadlineMs: 20000 });
  await run("agreed", () => reader.agreed(${fn}));`;

test("shielded startup reader: the same reader contract through the ONE verifier, no public request; policy kept", async () => {
  const v = await recorder("verifier"), pub = await recorder("public");
  try {
    const r = await child({ BASE_RPCS: pub.url, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url },
      startupSteps(`async (c, at) => String(await c.readContract({ address: ${J(TO)}, abi, functionName: "count", blockNumber: at })) + "@" + String(at)`));
    assert.ok(r.plainClientRefused.err, "an ordinary client is never a single authority");
    assert.ok(r.singleQuorumRefused.err, "quorumReader still refuses one client");
    assert.equal(r.agreed.ok, `7@${HEAD - 2}`, J(r.agreed));            // head - confirmations (2)
    const calls = v.calls.filter((c) => c.method === "eth_call");
    assert.ok(calls.length >= 1 && calls.every((c) => BigInt(c.params[1]) === BigInt(HEAD - 2)), "the value is read AT the target block");
    assert.ok(v.methods().filter((m) => m === "eth_getBlockByNumber").length >= 2, "the block is read before and after the value");
    assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
  } finally { await v.close(); await pub.close(); }
});

test("shielded startup reader refuses a reorg during the read, a stale block, and a down verifier - with no fallback", async () => {
  const pub = await recorder("public");
  const reorg = await recorder("verifier", { hashFor: (n, i) => "0x" + (i % 2 ? "ee" : "ab").repeat(32) });
  const stale = await recorder("verifier", { stale: true }), down = await recorder("verifier", { down: true });
  try {
    for (const [v, what] of [[reorg, /reorganized/], [stale, /stale/], [down, /refused/]]) {
      const r = await child({ BASE_RPCS: pub.url, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url }, startupSteps(`async (c, at) => String(at)`));
      assert.ok(r.agreed.err && what.test(r.agreed.err), `${what}: ${J(r.agreed)}`);
    }
    assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
  } finally { await pub.close(); await reorg.close(); await stale.close(); await down.close(); }
});

test("privacy agent chain: enrollment writes {addressBook, authority, verifier} (no rpc); the agent's REAL LeaseReader reads the verifier only", async () => {
  const v = await recorder("verifier"), pub = await recorder("public");
  try {
    const r = await child({}, `const { baseConfig, agentChain } = await import(${J(ENROLL)}); const { LeaseReader } = await import(${J(LEASE_READER)});
      const cfg = baseConfig({ agentDir: "/x", binDir: "/x/bin", nodeBinary: "node", operatorKeyFile: "/x/k", runner: "0x" + "33".repeat(32), endpoint: "https://e.example",
        relayBase: "https://r.example", policyFile: "/x/p", tpmBinary: "/x/t", tpmSha256: "00", addressBook: ${J(BOOK)}, chainRpc: [],
        chainAuthority: { authority: "verifier", verifier: ${J(v.url)} }, enclaveNetwork: {} });
      out.chain = cfg.chain;
      await run("mixed", () => agentChain({ addressBook: ${J(BOOK)}, chainRpc: [${J(pub.url)}], chainAuthority: { authority: "verifier", verifier: ${J(v.url)} } }));
      await run("remote", () => agentChain({ addressBook: ${J(BOOK)}, chainRpc: [], chainAuthority: { authority: "verifier", verifier: "http://example.com/" } }));
      out.invalid = agentChain({ addressBook: ${J(BOOK)}, chainRpc: [], chainAuthority: { invalid: "x" } });
      out.legacy = agentChain({ addressBook: ${J(BOOK)}, chainRpc: [${J(pub.url)}] });
      const reader = new LeaseReader({ ...cfg.chain });                 // exactly network/privacy-agent.mjs:237
      out.authority = reader.authority;
      await run("read", () => reader.agreed(async (c, at) => String(at)));
      await run("invalidReader", () => new LeaseReader({ ...out.invalid }));`);
    assert.deepEqual(r.chain, { addressBook: BOOK, authority: "verifier", verifier: v.url }, "no rpc key under the explicit authority");
    assert.ok(r.mixed.err && /never mixed/.test(r.mixed.err)); assert.ok(r.remote.err && /loopback/.test(r.remote.err));
    assert.deepEqual(r.invalid, { addressBook: BOOK }); assert.deepEqual(r.legacy, { addressBook: BOOK, rpc: [pub.url] });
    assert.equal(r.authority, "verifier"); assert.ok(r.read.ok !== undefined || r.read.err, J(r.read));
    assert.ok(r.invalidReader.err, "an agent with an invalid node selection has no RPC: its reader refuses");
    assert.ok(v.calls.length > 0, "the agent's reader reached the verifier"); assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
  } finally { await v.close(); await pub.close(); }
});

test("wallet host admission: rpc [] under the verifier builds through the real module; legacy rpc [] still refuses", async () => {
  const v = await recorder("verifier"), pub = await recorder("public");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adm-")); const pins = path.join(dir, "pins.json");
  const REG = "0x" + "44".repeat(20), CAT = "0x" + "55".repeat(20), OWN = "0x" + "66".repeat(20), HOST = "0x" + "77".repeat(32);
  fs.writeFileSync(pins, JSON.stringify({ registry: REG, appCatalog: CAT, deployments: "0x" + "88".repeat(20) }));
  const env = { ENCLAVE_HOST_OWNERSHIP: OWN, ENCLAVE_HOST_REGISTRY_PIN: REG, ENCLAVE_HOST_CATALOG_PIN: CAT, ENCLAVE_HOST_POLICY_DIR: dir, ENCLAVE_CONTRACT_PINS_FILE: pins };
  try {
    const body = (e) => `const { hostAdmissionFromEnv } = await import(${J(ADMISSION)});
      await run("admission", () => { const a = hostAdmissionFromEnv({ hostId: ${J(HOST)}, rpc: [], addressBook: ${J(BOOK)}, env: ${J(e)} }); return a ? Object.keys(a).sort() : null; });`;
    const ver = await child({}, body({ ...env, ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url }));
    const legacy = await child({}, body(env));
    assert.ok(ver.admission.ok, `verifier mode with rpc []: ${J(ver.admission)}`);
    assert.ok(legacy.admission.err, "legacy mode with rpc [] still refuses (two RPCs required): nothing changed there");
    assert.equal(pub.calls.length, 0);
  } finally { await v.close(); await pub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- r3: the agent network host's contract-wallet owner signatures through the SAME verifier authority ----
// network/enclave-network-host.mjs ownerSignatureReader + network/owner-signature.mjs verifyOwnerSignature + the REAL
// LeaseReader in verifier mode (exactly the agent's leaseReader when cfg.chain = {addressBook, authority, verifier}).
const OWNER_SIG = root("network/owner-signature.mjs"), NET_HOST = root("network/enclave-network-host.mjs");
const { LeaseReader } = await import(LEASE_READER);
const { verifyOwnerSignature } = await import(OWNER_SIG);
const { ownerSignatureReader } = await import(NET_HOST);
const { privateKeyToAccount } = await import("viem/accounts");
const { toFunctionSelector, encodeAbiParameters } = await import("viem");
const SIGNER = privateKeyToAccount(KEY), MESSAGE = "enclave network policy v1", VAULT = "0x" + "99".repeat(20), WALLET = "0x" + "98".repeat(20), FACTORY = "0x" + "97".repeat(20);
const SEL = { erc1271: toFunctionSelector("isValidSignature(bytes32,bytes)"), addr: toFunctionSelector("addr(bytes32)"),
              isVault: toFunctionSelector("isVault(address)"), owner: toFunctionSelector("owner()") };
/** A verifier recorder whose eth_call/eth_getCode answer the contract-wallet reads; `magic` is what isValidSignature returns. */
async function walletVerifier({ magic = "0x1626ba7e", down = false } = {}) {
  const v = await recorder("verifier", { down });
  if (down) return v;
  const base = v.close; const calls = v.calls;
  // replace the generic answers for eth_call/eth_getCode by wrapping the server's handler is not possible after listen, so
  // a second small server is used instead: same recording contract
  await base();
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body); const list = Array.isArray(j) ? j : [j];
      const ans = list.map((r) => { calls.push({ method: r.method, params: r.params });
        const p = r.params || [], blk = { number: "0x" + HEAD.toString(16), hash: "0x" + "ab".repeat(32), parentHash: "0x" + "aa".repeat(32),
          timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32),
          transactionsRoot: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), miner: "0x" + "00".repeat(20), gasLimit: "0x1", gasUsed: "0x0",
          extraData: "0x", mixHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), baseFeePerGas: "0x1",
          difficulty: "0x0", size: "0x1", transactions: [], uncles: [] };
        let result = null;
        if (r.method === "eth_chainId") result = "0x2105";
        else if (r.method === "eth_blockNumber") result = "0x" + HEAD.toString(16);
        else if (r.method === "eth_getBlockByNumber" || r.method === "eth_getBlockByHash") result = blk;
        else if (r.method === "eth_getCode") result = String(p[0]).toLowerCase() === WALLET ? "0x6001" : "0x";
        else if (r.method === "eth_call") {
          const to = String(p[0].to).toLowerCase(), sel = String(p[0].data).slice(0, 10);
          if (to === WALLET && sel === SEL.erc1271) result = magic.padEnd(66, "0");
          else if (sel === SEL.addr) result = encodeAbiParameters([{ type: "address" }], [FACTORY]);
          else if (to === FACTORY && sel === SEL.isVault) result = encodeAbiParameters([{ type: "bool" }], [true]);
          else if (to === VAULT && sel === SEL.owner) result = encodeAbiParameters([{ type: "address" }], [SIGNER.address]);
          else result = "0x";
        }
        return { jsonrpc: "2.0", id: r.id, result }; });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(j) ? ans : ans[0]));
    });
  });
  await new Promise((r) => server.listen(Number(new URL(v.url).port), "127.0.0.1", r));
  return { url: v.url, calls, methods: () => calls.map((c) => c.method), close: () => new Promise((r) => server.close(r)) };
}

test("owner-signature reader: pinned -> quorum reader (unchanged); explicit verifier -> that verifier; legacy -> clients path", () => {
  const verifierReader = new LeaseReader({ addressBook: BOOK, authority: "verifier", verifier: "http://127.0.0.1:9/" });
  const quorum = new LeaseReader({ addressBook: BOOK, rpc: ["https://a.example/", "https://b.example/"] });
  assert.equal(ownerSignatureReader({ pins: { registry: "0x" }, leaseReader: quorum }), quorum);
  assert.equal(ownerSignatureReader({ pins: null, leaseReader: verifierReader }), verifierReader);
  assert.equal(ownerSignatureReader({ pins: null, leaseReader: quorum }), undefined);
  assert.equal(ownerSignatureReader({ pins: null, leaseReader: undefined }), undefined);
});

test("contract-wallet owners under the verifier: ERC-1271 and SessionVault succeed, a wrong answer and a down verifier refuse, no public request", async () => {
  const sig = await SIGNER.signMessage({ message: MESSAGE });
  const pub = await recorder("public");
  const check = async (verifier, owner) => {
    const leaseReader = new LeaseReader({ addressBook: BOOK, authority: "verifier", verifier, rpc: [] });
    return verifyOwnerSignature({ clients: [], reader: ownerSignatureReader({ pins: null, leaseReader }), owner, message: MESSAGE, signature: sig, addressBook: BOOK });
  };
  const ok = await walletVerifier(), bad = await walletVerifier({ magic: "0xffffffff" }), down = await walletVerifier({ down: true });
  try {
    assert.equal(await check(ok.url, WALLET), true, "ERC-1271 passkey vault: isValidSignature magic through the verifier");
    assert.equal(await check(ok.url, VAULT), true, "SessionVault: factory.isVault + vault.owner() = the signer, through the verifier");
    assert.ok(ok.methods().includes("eth_call") && ok.methods().includes("eth_getCode"));
    assert.ok(ok.calls.filter((c) => c.method === "eth_call").every((c) => c.params?.[1]?.blockHash), "every read is pinned to one verified block");
    assert.equal(await check(bad.url, WALLET), false, "a wrong ERC-1271 answer refuses");
    assert.equal(await check(down.url, WALLET), false, "a down verifier refuses (no fallback)");
    assert.equal(await verifyOwnerSignature({ clients: [], reader: undefined, owner: WALLET, message: MESSAGE, signature: sig, addressBook: BOOK }), false,
      "without the verifier reader a contract wallet is refused, as before (never a public client)");
    assert.equal(await verifyOwnerSignature({ clients: [], reader: undefined, owner: SIGNER.address, message: MESSAGE, signature: sig, addressBook: BOOK }), true,
      "EOA owners recover locally, unchanged");
    assert.equal(pub.calls.length, 0, `public contacted: ${pub.methods()}`);
  } finally { await ok.close(); await bad.close(); await down.close(); await pub.close(); }
});
