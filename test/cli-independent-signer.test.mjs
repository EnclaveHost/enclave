// cli/independent-signer.mjs against real signed Ethereum bytes and a real local chain:
//   * the CHAIN is an anvil read through the CLI's QuorumChain (two clients, one agreed block);
//   * the WALLET is a SEPARATE anvil (its own state, never connected to the chain) behind small JSON-RPC fixtures that
//     behave like an eth_signTransaction endpoint, like Clef (account_* only), like a broadcast-only wallet
//     (eth_sendTransaction through its own node), and like wallets that tamper, hang, refuse or lie.
// Only anvil's published development keys are used. Nothing here talks to a network beyond 127.0.0.1.
//
//   run: node --test --test-concurrency=1 test/cli-independent-signer.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, parseTransaction, serializeTransaction, recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { QuorumChain } from "../cli/independent.mjs";
import { createExternalSigner, signerEndpoint, jsonRpcClient, verifySignedTransaction, intendedTx, intentJournal, resolveIntent,
  rebroadcast, attachHash, abandonIntent, signerCommand, SignerError } from "../cli/independent-signer.mjs";

const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil dev account 0 (published)
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // anvil dev account 1 (published)
const A0 = privateKeyToAccount(KEY0), A1 = privateKeyToAccount(KEY1);
const tools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return null; } catch { return "needs Foundry's anvil"; } })();
const T = tools ? { skip: tools } : { timeout: 120000 };
const SINK = "0x000000000000000000000000000000000000c0de";      // code 0x00: any call succeeds
const REVERTER = "0x000000000000000000000000000000000000dead";  // code: revert(0,0)
const HANG = Symbol("hang");

let chainProc, walletProc, chainRpc, walletRpc, pc, chain, tmp;
const procs = [], servers = [];
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function anvil(extra = []) {
  const port = await freePort();
  const p = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent", "--base-fee", "5000000", ...extra], { stdio: "ignore" });
  procs.push(p);
  const url = `http://127.0.0.1:${port}`, c = createPublicClient({ chain: foundry, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await c.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { url, c };
}
const call = async (url, method, params = []) => {
  const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  return "error" in j ? { error: j.error } : { result: j.result };
};
/** A JSON-RPC wallet fixture: handler(msg) -> {result} | {error} | HANG. Records every method asked. */
async function walletServer(handler, { status = 200, headers = {} } = {}) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const m = JSON.parse(b); calls.push(m);
    const r = await handler(m);
    if (r === HANG) return;
    if (r?.raw !== undefined) { res.writeHead(status, { "content-type": "application/json", ...headers }); return res.end(r.raw); }
    res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.address().port}/rpc?token=SECRET-TOKEN`, calls, methods: () => calls.map((c) => c.method), close: () => { srv.closeAllConnections(); srv.close(); } };
}
const forward = (url) => (m) => call(url, m.method, m.params);
const nonceOf = (a) => pc.getTransactionCount({ address: a });
let dirN = 0;
const jdir = () => path.join(tmp, `journal-${++dirN}`);
const signer = (url, o = {}) => createExternalSigner({ url, from: A0.address, chainId: 31337, journalDir: o.journalDir || jdir(), approvalTimeoutMs: 3000, probeTimeoutMs: 2000, ...o });
const WAIT = { timeoutMs: 15000, pollMs: 50 };

before(async () => {
  if (tools) return;
  ({ url: chainRpc, c: pc } = await anvil());
  ({ url: walletRpc } = await anvil());
  await pc.request({ method: "anvil_setCode", params: [SINK, "0x00"] });
  await pc.request({ method: "anvil_setCode", params: [REVERTER, "0x60006000fd"] });
  // the wallet's own node has a different history: its view of account 0's nonce is 3, the chain's is 0
  const w = createWalletClient({ chain: foundry, account: A0, transport: viemHttp(walletRpc) });
  for (let i = 0; i < 3; i++) await w.sendTransaction({ to: A1.address, value: 1n });
  const c = () => createPublicClient({ chain: foundry, transport: viemHttp(chainRpc) });
  chain = new QuorumChain({ clients: [{ origin: chainRpc + "/a", client: c() }, { origin: chainRpc + "/b", client: c() }], quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ind-signer-"));
});
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } for (const p of procs) p.kill("SIGKILL"); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("signer URLs follow the shared policy and are never echoed", () => {
  assert.equal(signerEndpoint("http://127.0.0.1:1248").label, "http://127.0.0.1:1248");
  assert.equal(signerEndpoint("https://signer.example/v1?key=SECRET").label, "https://signer.example");
  for (const bad of ["http://signer.example:8550", "https://user:pw@signer.example", "https://signer.example/#x", "ftp://127.0.0.1", "nonsense"]) {
    const e = (() => { try { signerEndpoint(bad); } catch (x) { return x; } })();
    assert.ok(e instanceof SignerError && e.code === "url", bad);
    assert.doesNotMatch(e.message, /signer\.example|user|pw|SECRET/);
  }
  assert.throws(() => createExternalSigner({ url: "http://127.0.0.1:1", chainId: 31337, journalDir: jdir() }), /--from/);
});

test("JSON-RPC transport: redirects, oversize, timeouts, malformed answers, refusals and unreachable signers are each classified", T, async () => {
  const other = await walletServer(() => ({ result: "0x7a69" }));
  const redirect = await walletServer(() => ({ raw: "" }), { status: 307, headers: { location: other.url } });
  const r1 = await jsonRpcClient({ url: redirect.url, label: "w" }).call("eth_chainId", []).catch((e) => e);
  assert.equal(r1.code, "transport"); assert.match(r1.message, /redirect/); assert.equal(other.calls.length, 0, "a redirect is never followed");
  const big = await walletServer(() => ({ raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(2 << 20) }) }));
  assert.equal((await jsonRpcClient({ url: big.url, label: "w" }).call("eth_chainId", []).catch((e) => e)).code, "protocol");
  const hang = await walletServer(() => HANG);
  const t = await jsonRpcClient({ url: hang.url, label: "w" }).call("eth_signTransaction", [{}], { timeoutMs: 300 }).catch((e) => e);
  assert.equal(t.code, "timeout"); assert.equal(t.delivered, "unknown");
  const wrongId = await walletServer((m) => ({ raw: JSON.stringify({ jsonrpc: "2.0", id: m.id + 1, result: "0x1" }) }));
  assert.equal((await jsonRpcClient({ url: wrongId.url, label: "w" }).call("eth_chainId", []).catch((e) => e)).code, "protocol");
  const notJson = await walletServer(() => ({ raw: "<html>" }));
  assert.equal((await jsonRpcClient({ url: notJson.url, label: "w" }).call("eth_chainId", []).catch((e) => e)).code, "protocol");
  const deny = await walletServer(() => ({ error: { code: 4001, message: "User rejected the request at https://u:p@wallet.example/x?k=SECRET" } }));
  const d = await jsonRpcClient({ url: deny.url, label: "w" }).call("eth_sendTransaction", [{}]).catch((e) => e);
  assert.equal(d.code, "rejected"); assert.doesNotMatch(d.message, /SECRET|u:p/);
  const clefDeny = await walletServer(() => ({ error: { code: -32000, message: "request denied" } }));
  assert.equal((await jsonRpcClient({ url: clefDeny.url, label: "w" }).call("account_signTransaction", [{}]).catch((e) => e)).code, "rejected");
  const nf = await walletServer(() => ({ error: { code: -32601, message: "the method eth_signTransaction does not exist/is not available" } }));
  assert.equal((await jsonRpcClient({ url: nf.url, label: "w" }).call("eth_signTransaction", [{}]).catch((e) => e)).code, "unsupported");
  const noSigner = await walletServer(() => ({ error: { code: -32602, message: "No Signer available" } }));
  assert.equal((await jsonRpcClient({ url: noSigner.url, label: "w" }).call("eth_signTransaction", [{}]).catch((e) => e)).code, "wallet", "an unknown account is not 'unsupported'");
  const port = await freePort();
  const u = await jsonRpcClient({ url: `http://127.0.0.1:${port}`, label: "w" }).call("eth_chainId", []).catch((e) => e);
  assert.equal(u.code, "unreachable"); assert.equal(u.delivered, false);
});

test("signed bytes are accepted only when every field, the encoding and the sender are exactly the prepared transaction", T, async () => {
  const want = intendedTx({ chainId: 31337, nonce: 7, to: SINK, value: 5n, data: "0xabcd", gas: 50000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000n }, 31337);
  const raw = await A0.signTransaction(want);
  assert.equal((await verifySignedTransaction(raw, want, A0.address)).hash, keccak256(raw));
  const variants = {
    chainId: { chainId: 1 }, nonce: { nonce: 8 }, to: { to: REVERTER }, value: { value: 6n }, data: { data: "0xabce" }, gas: { gas: 50001n },
    maxFeePerGas: { maxFeePerGas: 2000000001n }, maxPriorityFeePerGas: { maxPriorityFeePerGas: 1000001n },
    accessList: { accessList: [{ address: SINK, storageKeys: [] }] },
  };
  for (const [field, change] of Object.entries(variants)) {
    const e = await verifySignedTransaction(await A0.signTransaction({ ...want, ...change }), want, A0.address).catch((x) => x);
    assert.equal(e.code, "mismatch", field); assert.match(e.message, /nothing was broadcast/);
  }
  assert.match((await verifySignedTransaction(await A1.signTransaction(want), want, A0.address).catch((x) => x)).message, /signed by 0x7099/i);
  assert.match((await verifySignedTransaction(raw + "00", want, A0.address).catch((x) => x)).message, /non-canonical/);
  assert.match((await verifySignedTransaction(await A0.signTransaction({ ...want, type: "legacy", gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }), want, A0.address).catch((x) => x)).message, /not EIP-1559/);
  // the same signature with s flipped to the high half still recovers, but is refused
  const t = parseTransaction(raw), N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const high = serializeTransaction(want, { r: t.r, s: "0x" + (N - BigInt(t.s)).toString(16).padStart(64, "0"), yParity: 1 - t.yParity });
  assert.match((await verifySignedTransaction(high, want, A0.address).catch((x) => x)).message, /high-s/);
});

test("sign path (eth_signTransaction): the wallet only signs; the quorum supplies the state and broadcasts the identical bytes once", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const notes = [], traced = [];
  const s = signer(w.url, { log: (m) => notes.push(m) });
  const before = await nonceOf(A0.address);
  const sent = [];
  const counting = (client) => new Proxy(client, { get: (t, k) => k === "request" ? async (a) => { if (a.method === "eth_sendRawTransaction") sent.push(a.params[0]); return t.request(a); } : t[k] });
  const c2 = new QuorumChain({ clients: chain.peers.map((p) => ({ origin: p.origin, client: counting(p.client) })), quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
  const r = await s.sendQuorumTx(c2, { to: SINK, data: "0x1234", value: 3n, ...WAIT, log: (m) => traced.push(m) });   // as the hook passes the CLI's -x trace
  assert.equal(r.status, "success");
  assert.ok(notes.some((m) => m.includes(`signed ${r.transactionHash} (intent ${r.intent})`)), "the signed hash and intent reach the user, not only the trace");
  assert.ok(traced.some((m) => /broadcasting the same bytes/.test(m)), "sendQuorumTx's own detail still goes to the caller's log");
  assert.equal(await nonceOf(A0.address), before + 1, "exactly one transaction");
  const rec = s.journal.get(r.intent);
  assert.equal(rec.state, "confirmed"); assert.equal(rec.mode, "sign"); assert.equal(rec.nonce, before, "the chain's nonce, not the wallet node's (3)");
  assert.equal(r.transactionHash, rec.hash); assert.equal(keccak256(rec.raw), rec.hash);
  assert.deepEqual(sent, [rec.raw, rec.raw], "the same bytes to each quorum RPC, once");
  const tx = await pc.getTransaction({ hash: r.transactionHash });
  assert.equal(tx.input, "0x1234"); assert.equal(tx.to.toLowerCase(), SINK);
  const asked = w.methods();
  assert.equal(asked.filter((m) => m === "eth_signTransaction").length, 1);
  assert.deepEqual(asked.filter((m) => !["account_version", "eth_accounts", "eth_chainId", "eth_signTransaction"].includes(m)), [], "the wallet is never asked about chain state");
  const st = fs.statSync(path.join(s.journal.dir, `${r.intent}.json`)); assert.equal(st.mode & 0o777, 0o600);
  for (const f of fs.readdirSync(s.journal.dir)) assert.doesNotMatch(fs.readFileSync(path.join(s.journal.dir, f), "utf8"), /SECRET-TOKEN/);
  // a reverting call is refused at the agreed simulation: the wallet is never asked
  const n0 = w.calls.length;
  await assert.rejects(s.sendQuorumTx(chain, { to: REVERTER, data: "0x", ...WAIT }), /would revert/);
  assert.equal(w.methods().slice(n0).includes("eth_signTransaction"), false);
});

test("a wallet that changes, re-encodes or re-addresses what it signs is refused before anything is broadcast", T, async () => {
  const cases = {
    recipient: (m) => m.method === "eth_signTransaction" ? call(walletRpc, m.method, [{ ...m.params[0], to: REVERTER }]) : forward(walletRpc)(m),
    fee: (m) => m.method === "eth_signTransaction" ? call(walletRpc, m.method, [{ ...m.params[0], maxFeePerGas: "0x77359400" }]) : forward(walletRpc)(m),
    trailing: async (m) => { const r = await forward(walletRpc)(m); return m.method === "eth_signTransaction" ? { result: r.result + "00" } : r; },
    sender: (m) => m.method === "eth_signTransaction" ? call(walletRpc, m.method, [{ ...m.params[0], from: A1.address }]) : forward(walletRpc)(m),
    legacy: (m) => { if (m.method !== "eth_signTransaction") return forward(walletRpc)(m); const { maxFeePerGas, maxPriorityFeePerGas, ...p } = m.params[0]; return call(walletRpc, m.method, [{ ...p, type: "0x0", gasPrice: maxFeePerGas }]); },
  };
  const before = await nonceOf(A0.address);
  for (const [name, h] of Object.entries(cases)) {
    const w = await walletServer(h);
    const s = signer(w.url);
    const e = await s.sendQuorumTx(chain, { to: SINK, data: "0x01", ...WAIT }).catch((x) => x);
    assert.equal(e.code, "mismatch", name); assert.match(e.message, /nothing was broadcast/, name);
    assert.deepEqual(s.journal.list(), [], `${name}: no intent: nothing left this process`);
  }
  assert.equal(await nonceOf(A0.address), before);
});

test("no silent account or chain choice; a refused or unanswered signature request sends nothing and is never repeated", T, async () => {
  const notOffered = await walletServer((m) => m.method === "eth_accounts" || m.method === "eth_requestAccounts" ? { result: [A1.address] } : forward(walletRpc)(m));
  const e1 = await signer(notOffered.url).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e1.code, "account"); assert.ok(!notOffered.methods().includes("eth_signTransaction"));
  const otherChain = await walletServer((m) => m.method === "eth_chainId" ? { result: "0x2105" } : forward(walletRpc)(m));
  const e2 = await signer(otherChain.url).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e2.code, "chain"); assert.ok(!otherChain.methods().includes("eth_signTransaction"));
  const refuse = await walletServer((m) => m.method === "eth_signTransaction" ? { error: { code: 4001, message: "User rejected" } } : forward(walletRpc)(m));
  const e3 = await signer(refuse.url).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e3.code, "rejected"); assert.equal(refuse.methods().filter((m) => m === "eth_signTransaction").length, 1);
  const hang = await walletServer((m) => m.method === "eth_signTransaction" ? HANG : forward(walletRpc)(m));
  const s4 = signer(hang.url, { approvalTimeoutMs: 400 });
  const e4 = await s4.sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e4.code, "timeout"); assert.match(e4.message, /nothing was broadcast/);
  assert.equal(hang.methods().filter((m) => m === "eth_signTransaction").length, 1, "never asked twice");
  // sign-only mode never falls back to letting the wallet broadcast
  const sendOnly = await walletServer((m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } } : forward(chainRpc)(m));
  const e5 = await signer(sendOnly.url, { mode: "sign" }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e5.code, "unsupported"); assert.ok(!sendOnly.methods().includes("eth_sendTransaction"));
});

test("Clef (account_* API only): transactions, text and typed data through account_signTransaction / account_signData / account_signTypedData", T, async () => {
  let edit = null;
  const clef = await walletServer(async (m) => {
    if (!m.method.startsWith("account_")) return { error: { code: -32601, message: `the method ${m.method} does not exist/is not available` } };
    if (m.method === "account_version") return { result: "6.0.0" };
    if (m.method === "account_list") return { result: [A0.address, A1.address] };
    if (m.method === "account_signTransaction") {
      const { input, ...args } = m.params[0];
      assert.equal(input, args.data); assert.equal(args.chainId, "0x7a69");
      const r = await call(walletRpc, "eth_signTransaction", [{ ...args, ...(edit || {}), type: "0x2" }]);
      return r.error ? r : { result: { raw: r.result, tx: {} } };
    }
    if (m.method === "account_signData") { assert.equal(m.params[0], "text/plain"); return call(walletRpc, "personal_sign", [m.params[2], m.params[1]]); }
    if (m.method === "account_signTypedData") return call(walletRpc, "eth_signTypedData_v4", [m.params[0], JSON.stringify(m.params[1])]);
    return { error: { code: -32601, message: "no" } };
  });
  const s = signer(clef.url);
  const before = await nonceOf(A0.address);
  const r = await s.sendQuorumTx(chain, { to: SINK, data: "0xc1ef", ...WAIT });
  assert.equal(r.status, "success"); assert.equal(s.protocol, "clef"); assert.equal(await nonceOf(A0.address), before + 1);
  const sig = await s.signMessage({ message: "enclave-upload:abc:123" });
  assert.equal(await recoverMessageAddress({ message: "enclave-upload:abc:123", signature: sig }), A0.address);
  const td = { domain: { name: "Enclave", version: "1", chainId: 31337, verifyingContract: SINK }, types: { Grant: [{ name: "key", type: "bytes32" }, { name: "n", type: "uint256" }] },
    primaryType: "Grant", message: { key: "0x" + "11".repeat(32), n: 5n } };
  const tsig = await s.signTypedData(td);
  assert.equal(await recoverTypedDataAddress({ ...td, signature: tsig }), A0.address);
  // Clef's UI may edit the request before signing (signer/core/api.go logDiff): the edit is caught
  edit = { gas: "0x30d40" };
  const e = await s.sendQuorumTx(chain, { to: SINK, data: "0xc1ef", ...WAIT }).catch((x) => x);
  assert.equal(e.code, "mismatch"); assert.match(e.message, /gas 200000 != intended/);
  assert.equal(await nonceOf(A0.address), before + 1);
});

test("message and typed-data signatures are verified; the wrong signer or the wrong chain is refused", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const s = signer(w.url);
  const sig = await s.signMessage({ message: "enclave-encvol:key-1" });
  assert.equal(await recoverMessageAddress({ message: "enclave-encvol:key-1", signature: sig }), A0.address);
  const rawSig = await s.signMessage({ message: { raw: "0x" + "ab".repeat(32) } });
  assert.equal(await recoverMessageAddress({ message: { raw: "0x" + "ab".repeat(32) }, signature: rawSig }), A0.address);
  const td = { domain: { name: "SessionVault", version: "1", chainId: 31337, verifyingContract: SINK }, types: { Open: [{ name: "x", type: "uint256" }] }, primaryType: "Open", message: { x: 1n } };
  assert.equal(await recoverTypedDataAddress({ ...td, signature: await s.signTypedData(td) }), A0.address);
  const n0 = w.calls.length;
  await assert.rejects(s.signTypedData({ ...td, domain: { ...td.domain, chainId: 8453 } }), (e) => e.code === "chain");
  assert.equal(w.calls.length, n0, "not even asked");
  const liar = await walletServer(async (m) => m.method === "personal_sign" ? { result: await A1.signMessage({ message: { raw: m.params[0] } }) } : forward(walletRpc)(m));
  await assert.rejects(signer(liar.url).signMessage({ message: "x" }), (e) => e.code === "mismatch" && /not 0xf39f/i.test(e.message));
  const v01 = await walletServer(async (m) => { const r = await forward(walletRpc)(m); if (m.method !== "personal_sign") return r; return { result: r.result.slice(0, 130) + (parseInt(r.result.slice(130), 16) - 27).toString(16).padStart(2, "0") }; });
  const norm = await signer(v01.url).signMessage({ message: "v" });
  assert.match(norm, /(1b|1c)$/);
});

test("broadcast-only wallet (auto): the prepared transaction is sent by the wallet once, and the returned hash is accepted only as the quorum sees it", T, async () => {
  let rewrite = null;
  const frameLike = await walletServer(async (m) => {
    if (m.method === "eth_signTransaction") return { error: { code: -32601, message: "Method not found" } };
    if (m.method === "eth_sendTransaction") return call(chainRpc, m.method, [{ ...m.params[0], ...(rewrite ? rewrite(m.params[0]) : {}) }]);   // the wallet's own node
    return forward(chainRpc)(m);
  });
  const logs = [];
  const s = signer(frameLike.url, { log: (l) => logs.push(l) });
  const before = await nonceOf(A0.address);
  const r = await s.sendQuorumTx(chain, { to: SINK, data: "0xf4a3", value: 2n, ...WAIT, log: () => {} });   // a silent caller log, as the CLI hook passes
  assert.equal(r.status, "success"); assert.equal(await nonceOf(A0.address), before + 1);
  assert.ok(logs.some((l) => /cannot sign without broadcasting.*weaker/.test(l)), "the fallback is announced, never silent");
  const rec = s.journal.get(r.intent);
  assert.equal(rec.mode, "wallet-send"); assert.equal(rec.state, "confirmed"); assert.equal(rec.hash, r.transactionHash); assert.deepEqual(r.adjusted, []);
  assert.equal(frameLike.methods().filter((m) => m === "eth_sendTransaction").length, 1);
  const p = frameLike.calls.find((c) => c.method === "eth_sendTransaction").params[0];
  for (const k of ["nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "chainId", "type", "to", "data", "value"]) assert.ok(p[k] !== undefined, `${k} is prepared, not left to the wallet`);
  // the user raised the tip in the wallet UI, within the cap: confirmed and reported
  rewrite = (q) => ({ maxPriorityFeePerGas: "0x" + (BigInt(q.maxPriorityFeePerGas) + 7n).toString(16) });
  const r2 = await signer(frameLike.url, { mode: "wallet-send" }).sendQuorumTx(chain, { to: SINK, data: "0xf4a3", ...WAIT });
  assert.equal(r2.status, "success"); assert.match(r2.adjusted.join(), /maxPriorityFeePerGas/);
  // exact policy: the same edit is a mismatch
  const e3 = await signer(frameLike.url, { mode: "wallet-send", feePolicy: "exact" }).sendQuorumTx(chain, { to: SINK, data: "0xf4a3", ...WAIT }).catch((x) => x);
  assert.equal(e3.code, "mismatch"); assert.match(e3.message, /THE WALLET SENT A DIFFERENT TRANSACTION/);
  // the wallet sent different calldata: it is mined, detected and reported loudly; the intent records it
  rewrite = () => ({ data: "0xbad0" });
  const s4 = signer(frameLike.url, { mode: "wallet-send" });
  const e4 = await s4.sendQuorumTx(chain, { to: SINK, data: "0xf4a3", ...WAIT }).catch((x) => x);
  assert.equal(e4.code, "mismatch"); assert.match(e4.message, /data/);
  assert.equal(s4.journal.get(e4.intent).state, "mismatch");
  rewrite = null;
  // the wallet refused: nothing sent, the intent is closed and the next send may proceed
  const deny = await walletServer((m) => m.method === "eth_sendTransaction" ? { error: { code: 4001, message: "User denied transaction signature" } } : forward(chainRpc)(m));
  const s5 = signer(deny.url, { mode: "wallet-send" });
  const n5 = await nonceOf(A0.address);
  const e5 = await s5.sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e5.code, "rejected"); assert.equal(s5.journal.get(e5.intent).state, "rejected"); assert.equal(await nonceOf(A0.address), n5);
});

test("broadcast-only wallet, ambiguous outcomes: a lost answer is found by nonce; a hash that never appears stays unknown until resolved or abandoned", T, async () => {
  // 1. the wallet broadcasts, then its answer is lost: unknown, no hash; the busy guard holds; resolve finds it by nonce
  const lost = await walletServer(async (m) => { if (m.method === "eth_sendTransaction") { await call(chainRpc, m.method, m.params); return HANG; } return forward(chainRpc)(m); });
  const dir = jdir();
  const s = signer(lost.url, { mode: "wallet-send", approvalTimeoutMs: 500, journalDir: dir });
  const before = await nonceOf(A0.address);
  const e = await s.sendQuorumTx(chain, { to: SINK, data: "0x10", ...WAIT }).catch((x) => x);
  assert.equal(e.code, "unknown"); assert.match(e.message, /Do not resend/); assert.equal(e.hash, null);
  assert.equal(lost.methods().filter((m) => m === "eth_sendTransaction").length, 1, "never retried");
  const busy = await s.sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(busy.code, "busy"); assert.match(busy.message, new RegExp(e.intent));
  assert.equal(await nonceOf(A0.address), before + 1);
  const r = await resolveIntent(chain, s.journal, e.intent);
  assert.equal(r.state, "confirmed"); assert.equal(r.intent.state, "confirmed"); assert.match(r.intent.hash, /^0x[0-9a-f]{64}$/);
  assert.equal((await pc.getTransaction({ hash: r.intent.hash })).input, "0x10");
  // 2. the wallet hands back a hash and never broadcasts (a cancelled smart transaction, a dropped send): unknown with the hash
  const ghost = await walletServer((m) => m.method === "eth_sendTransaction" ? { result: "0x" + "77".repeat(32) } : forward(chainRpc)(m));
  const g = signer(ghost.url, { mode: "wallet-send", journalDir: dir });
  const e2 = await g.sendQuorumTx(chain, { to: SINK, ...WAIT, timeoutMs: 600 }).catch((x) => x);
  assert.equal(e2.code, "unknown"); assert.equal(e2.hash, "0x" + "77".repeat(32));
  const r2 = await resolveIntent(chain, g.journal, e2.intent);
  assert.equal(r2.state, "submitted"); assert.ok(r2.open || r2.pending); assert.match(r2.note || "", /may still send it/);
  const ab = abandonIntent(g.journal, e2.intent);
  assert.match(ab.warning, /at most one/);
  // 3. after abandoning, the next transaction takes the same nonce; the abandoned hash can never be mined
  const ok = await walletServer((m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } } : forward(chainRpc)(m));
  const r3 = await signer(ok.url, { journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(r3.status, "success");
  assert.equal(Number((await pc.getTransaction({ hash: r3.transactionHash })).nonce), Number(g.journal.get(e2.intent).nonce));
});

test("sign path, ambiguous broadcast: the journaled bytes are resolved from the chain or rebroadcast unchanged, never re-signed", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const dir = jdir();
  const s = signer(w.url, { journalDir: dir });
  const wrap = (fn) => new QuorumChain({ clients: chain.peers.map((p) => ({ origin: p.origin, client: new Proxy(p.client, { get: (t, k) => k === "request" ? (a) => a.method === "eth_sendRawTransaction" ? fn(t, a) : t.request(a) : t[k] }) })),
    quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
  // 1. delivered, but every answer lost
  const delivered = wrap(async (t, a) => { await t.request(a).catch(() => {}); throw new Error("socket hang up"); });
  const before = await nonceOf(A0.address);
  const e = await s.sendQuorumTx(delivered, { to: SINK, data: "0x21", ...WAIT }).catch((x) => x);
  assert.equal(e.code, "unknown"); assert.ok(e.outcomeUnknown); assert.match(e.message, /Do not resend/);
  assert.equal(s.journal.get(e.intent).state, "unknown");
  assert.equal((await resolveIntent(chain, s.journal, e.intent)).state, "confirmed");
  assert.equal(await nonceOf(A0.address), before + 1);
  // 2. never delivered: resolve keeps it open; rebroadcast sends THE SAME BYTES; no second signature is asked for
  const dropped = wrap(async () => { throw new Error("socket hang up"); });
  const signs = w.methods().filter((m) => m === "eth_signTransaction").length;
  const e2 = await s.sendQuorumTx(dropped, { to: SINK, data: "0x22", ...WAIT }).catch((x) => x);
  assert.equal(e2.code, "unknown");
  const rec = s.journal.get(e2.intent);
  const r = await resolveIntent(chain, s.journal, e2.intent);
  assert.equal(r.intent.state, "unknown"); assert.ok(r.open);
  await assert.rejects(s.sendQuorumTx(chain, { to: SINK, ...WAIT }), (x) => x.code === "busy");
  const rb = await rebroadcast(chain, s.journal, e2.intent, WAIT);
  assert.equal(rb.transactionHash, rec.hash); assert.equal(rb.status, "success");
  assert.equal(w.methods().filter((m) => m === "eth_signTransaction").length, signs + 1, "one signature for the whole story");
  assert.equal(await nonceOf(A0.address), before + 2);
  await assert.rejects(rebroadcast(chain, s.journal, e2.intent, WAIT), /confirmed; nothing to repeat/);
});

test("handoff (MetaMask or any wallet without an endpoint): the exact transaction is printed, the hash attached, the quorum decides", T, async () => {
  let handed = null;
  const dir = jdir();
  const h = createExternalSigner({ from: A0.address, chainId: 31337, mode: "handoff", journalDir: dir, onHandoff: (rec, params) => { handed = { rec, params }; return { handoff: rec.id }; } });
  const out = await h.sendQuorumTx(chain, { to: SINK, data: "0x3a", value: 9n, ...WAIT });
  assert.equal(out.handoff, handed.rec.id);
  assert.deepEqual(Object.keys(handed.params).sort(), ["chainId", "data", "from", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "to", "type", "value"]);
  await assert.rejects(h.sendQuorumTx(chain, { to: SINK, ...WAIT }), (e) => e.code === "busy");
  // the user's own wallet sends exactly those parameters (here: the chain node's unlocked dev account, as a browser wallet would)
  const sent = await call(chainRpc, "eth_sendTransaction", [handed.params]);
  // attaching someone else's transaction is a mismatch, not a confirmation
  const otherHash = await createWalletClient({ chain: foundry, account: A1, transport: viemHttp(chainRpc) }).sendTransaction({ to: SINK, data: "0x3a", value: 9n });
  await pc.waitForTransactionReceipt({ hash: otherHash });
  const j = intentJournal(dir);
  const { id: _id, createdAt: _c, ...base } = j.get(handed.rec.id);
  const decoy = j.create({ ...base, state: "handoff", hash: null });
  await assert.rejects(attachHash(chain, j, decoy.id, otherHash, WAIT), (e) => e.code === "mismatch" && /signed by 0x7099/i.test(e.message));
  const r = await attachHash(chain, j, handed.rec.id, sent.result, WAIT);
  assert.equal(r.status, "success"); assert.equal(j.get(handed.rec.id).state, "confirmed");
  await assert.rejects(attachHash(chain, j, handed.rec.id, sent.result, WAIT), /nothing to attach/);
});

test("signer commands: probe signs nothing, list hides signed bytes, resolve/attach/abandon are explicit", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const s = signer(w.url);
  const lines = [], ctx = { chain, signer: s, say: (l) => lines.push(l), jout: (o) => lines.push(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? String(v) : v)), json: false, waitOpts: WAIT };
  await signerCommand("probe", [], ctx);
  assert.match(lines.at(-1), /EIP-1193 JSON-RPC; offers 0xf39F/i); assert.doesNotMatch(lines.join("\n"), /SECRET-TOKEN/);
  assert.ok(!w.methods().some((m) => /sign/i.test(m)), "a probe asks for no signature");
  const r = await s.sendQuorumTx(chain, { to: SINK, ...WAIT });
  await signerCommand("list", [], { ...ctx, json: true });
  assert.doesNotMatch(lines.at(-1), /"raw"/); assert.match(lines.at(-1), new RegExp(r.intent));
  await signerCommand("show", [r.intent], ctx);
  assert.doesNotMatch(lines.at(-1), /^raw /m); assert.match(lines.at(-1), /state\s+confirmed/);
  await signerCommand("resolve", [r.intent], ctx);
  assert.match(lines.at(-1), /confirmed/);
  await assert.rejects(signerCommand("abandon", [r.intent], ctx), /is confirmed/);
  await assert.rejects(signerCommand("bogus", ["x"], ctx), /usage/);
});
