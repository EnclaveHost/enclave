// custody/chain-source.mjs: the explicit local-verifier custody chain source (legacy quorum default unchanged). The
// verifier is the REAL network/chain-authority.mjs client; only its HTTP peer is faked (injected fetch: a small signed-
// chain model answering eth_chainId / eth_blockNumber / eth_getBlockBy{Number,Hash} / eth_call), so every refusal below
// is the reviewed authority's or the custody readers' own behaviour, not the fake's. v2 refuses the verifier (see
// custody/chain-source.mjs); the A-B-A test pins that a hash read is never number-translated.
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, encodeFunctionResult, encodeFunctionData, decodeFunctionData, decodeFunctionResult } from "viem";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { custodyChainSource } from "../custody/chain-source.mjs";
import { custodianConfigFromEnv } from "../custody/custodian-config.mjs";
import { createChainReaderV2 } from "../custody/v2/chain.mjs";
import { createChainReader, VAULT_ABI } from "../custody/chain.mjs";
import { createQuorumReader } from "../custody/v2/quorum.mjs";

const VERIFIER = "http://127.0.0.1:8545";
const VAULT = "0x" + "11".repeat(20), BOOK = "0x" + "22".repeat(20), OWNER = "0x" + "33".repeat(20), ZERO = "0x" + "00".repeat(20);
const ID = "0x" + "44".repeat(32), CID = "0x" + "55".repeat(32);
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ type: "address" }] }];
const ABI = [...VAULT_ABI, ...BOOK_ABI];

function fakeVerifier() {
  const st = { head: 1000n, lagSec: 0n, paused: false, down: false, fork: "", urls: new Set(), callBlocks: [] };
  const hashOf = (n, fork = st.fork) => keccak256(toHex(`block:${n}:${fork}`));
  const block = (n, fork) => ({ number: toHex(n), hash: hashOf(n, fork), parentHash: hashOf(n - 1n, fork), transactions: [], gasLimit: "0x1c9c380", gasUsed: "0x0",
    timestamp: toHex(BigInt(Math.floor(Date.now() / 1000)) - (st.head - n) * 2n - st.lagSec), baseFeePerGas: "0x1", miner: ZERO, difficulty: "0x0", extraData: "0x", size: "0x1", uncles: [] });
  const call = ({ to, data }) => {
    const { functionName, args } = decodeFunctionData({ abi: ABI, data });
    const out = {
      policyOf: [OWNER, 3n, 7n, CID, st.paused, "0x"], bundleOf: [7n, 0, "0x"], book: BOOK, beneficialOwnerOf: OWNER, addr: ZERO, committeeOf: [OWNER, 2],
    }[functionName];
    if (out === undefined || (functionName === "addr" ? to.toLowerCase() !== BOOK : to.toLowerCase() !== VAULT)) throw new Error(`fake: no ${functionName} at ${to} ${args}`);
    return encodeFunctionResult({ abi: ABI, functionName, result: out });
  };
  const answer = ({ method, params }) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return toHex(st.head);
    if (method === "eth_getBlockByNumber") { const n = BigInt(params[0]); return n <= st.head ? block(n) : null; }
    if (method === "eth_getBlockByHash") {
      for (const fork of [st.fork, "sibling"]) for (let n = st.head; n > st.head - 50n; n--) if (hashOf(n, fork) === params[0]) return block(n, fork);
      return null;
    }
    if (method === "eth_call") {
      st.callBlocks.push(params[1]);
      // A-B-A: the canonical block at abaNumber is A before and after, but a by-NUMBER read lands on B in between
      if (st.abaNumber !== undefined && typeof params[1] === "string" && BigInt(params[1]) === st.abaNumber) return encodeFunctionResult({ abi: ABI, functionName: "book", result: "0x" + "bb".repeat(20) });
      return call(params[0]);
    }
    throw new Error(`fake: ${method}`);
  };
  const fetch = async (url, init) => {
    st.urls.add(String(url));
    if (st.down) throw new Error("connect ECONNREFUSED");
    const body = JSON.parse(init.body);
    try { return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body) }), { headers: { "content-type": "application/json" } }); }
    catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: e.message } }), { headers: { "content-type": "application/json" } }); }
  };
  return { st, fetch, hashOf };
}
const verifierSource = (fake, extra = {}) => custodyChainSource({ chainSource: "verifier", verifier: VERIFIER, chainId: 8453, ...extra }, { fetch: fake.fetch });

test("legacy default and explicit quorum are unchanged; verifier settings are refused there", () => {
  const cfg = { rpcs: ["https://a.example", "https://b.example"], minAgree: 2 };
  assert.deepEqual(custodyChainSource(cfg), { mode: "quorum", rpcs: cfg.rpcs, minAgree: 2, clients: null, authority: null });
  assert.equal(custodyChainSource({ ...cfg, chainSource: "quorum" }).mode, "quorum");
  for (const k of ["verifier", "txBackend"]) assert.throws(() => custodyChainSource({ ...cfg, [k]: VERIFIER }), /not verifier/, k);
});

test("verifier mode refuses mixed or public-fallback configuration", () => {
  const fake = fakeVerifier();
  for (const [k, v] of [["rpcs", ["https://mainnet.base.org"]], ["rpc", "https://mainnet.base.org"], ["bindingRpcs", ["https://x.example"]], ["fallbackRpcs", ["https://x.example"]], ["minAgree", 2]])
    assert.throws(() => verifierSource(fake, { [k]: v }), /must be unset/, k);
  assert.throws(() => custodyChainSource({ chainSource: "verifier" }, { fetch: fake.fetch }), /needs verifier/);
  assert.throws(() => verifierSource(fake, { verifier: "https://mainnet.base.org" }), /loopback|verifier/i, "a public RPC is never the verifier");
  assert.throws(() => verifierSource(fake, { chainId: 1 }), /not the verifier's chain/);
  assert.throws(() => custodyChainSource({ chainSource: "public" }), /quorum or verifier/);
  assert.equal(fake.st.urls.size, 0, "nothing was contacted while refusing");
});

test("a verifier is never one vote in a v1 quorum; v2 refuses it alone or mixed", () => {
  const [v] = verifierSource(fakeVerifier()).clients;
  const other = { getBlockNumber: async () => 1n, getBlock: async () => ({}), getChainId: async () => 8453, readContract: async () => null };
  assert.throws(() => createChainReader({ clients: [v, other], minAgree: 1, vault: VAULT }), /one chain authority/);
  assert.throws(() => createChainReader({ clients: [v, other], minAgree: 2, vault: VAULT }), /one chain authority/);
  assert.throws(() => createChainReader({ clients: [v], rpcs: ["https://a.example"], minAgree: 1, vault: VAULT }), /one chain authority/);
  assert.ok(createChainReader({ clients: [v], minAgree: 1, vault: VAULT }), "v1: the verifier alone, minAgree 1");
  // v2 (r3): unsupported mode, refused at construction whether alone or mixed into a quorum
  for (const [clients, minAgree] of [[[v, other, { ...other }], 2], [[v], 1]])
    assert.throws(() => createQuorumReader({ clients, minAgree, chainId: 8453 }), (e) => e.code === "chain_verifier_unsupported");
});

test("v1 reads go through the verifier at head - confirmations and see a revoked (paused) policy at once", async () => {
  const fake = fakeVerifier(), src = verifierSource(fake);
  const r = createChainReader({ clients: src.clients, minAgree: src.minAgree, vault: VAULT, confirmations: 3, maxAgeSec: 120 });
  const a = await r.readState({ id: ID });
  assert.equal(a.blockNumber, 997n); assert.equal(a.policy.paused, false); assert.equal(a.policy.owner, OWNER);
  fake.st.paused = true; fake.st.head = 1001n; fake.st.callBlocks.length = 0;
  const b = await r.readState({ id: ID });
  assert.equal(b.blockNumber, 998n); assert.equal(b.policy.paused, true, "the owner's pause is seen at the next verified block");
  assert.ok(fake.st.callBlocks.length > 0 && fake.st.callBlocks.every((x) => x === toHex(998n)), "every state read is pinned to that block number");
  assert.ok(fake.st.urls.size > 0 && [...fake.st.urls].every((u) => u.startsWith(VERIFIER)), "only the verifier was asked");
});

test("v1 via the verifier: a stale head and confirmations past the head fail closed; v2 checkpoint mode is unreachable", async () => {
  const fake = fakeVerifier(), src = verifierSource(fake);
  fake.st.lagSec = 1000n;
  const r = createChainReader({ clients: src.clients, minAgree: 1, vault: VAULT, maxAgeSec: 120 });
  await assert.rejects(r.readState({ id: ID }), (e) => e.code === "chain_stale");
  await assert.rejects(r.readRelease({ id: ID }), (e) => e.code === "chain_stale");
  fake.st.lagSec = 0n;
  const deep = createChainReader({ clients: src.clients, minAgree: 1, vault: VAULT, confirmations: 1001, maxAgeSec: 120 });
  await assert.rejects(deep.readState({ id: ID }), (e) => e.code === "chain_unconfirmed", "no block below genesis is invented");
  // v1 has NO sealed checkpoint API (its restart protection is the custodian's high-water marks, custody/custodian.mjs,
  // not exercised here). The v2 checkpoint/rollback rules stay covered by test/custody-v2-chain-quorum.test.mjs (RPC
  // quorum, regression); with a verifier, v2 is refused before any read:
  const f2 = fakeVerifier(), saved = { blockNumber: "2000", blockHash: f2.hashOf(2000n), blockTimestamp: Math.floor(Date.now() / 1000) };
  assert.throws(() => createQuorumReader({ clients: verifierSource(f2).clients, minAgree: 1, chainId: 8453, checkpoint: { load: async () => saved, save: async () => {} } }),
    (e) => e.code === "chain_verifier_unsupported");
  assert.equal(f2.st.urls.size, 0, "the refused v2 reader contacted nothing");
});

test("verifier outage fails closed for every v1 read and never falls back to another server", async () => {
  const fake = fakeVerifier(), src = verifierSource(fake);
  fake.st.down = true;
  const r = createChainReader({ clients: src.clients, minAgree: 1, vault: VAULT, maxAgeSec: 120 });
  for (const read of [() => r.readState({ id: ID }), () => r.readRelease({ id: ID }), () => r.readCommittee({ committeeId: CID }), () => r.readEpoch({ committeeId: CID, epoch: 1 })])
    await assert.rejects(read(), (e) => e.code === "chain_unconfirmed");
  assert.ok(fake.st.urls.size > 0 && [...fake.st.urls].every((u) => u.startsWith(VERIFIER)), "only the verifier was ever contacted");
});

test("no finality is invented: the authority refuses safe/finalized, v1 reads only numbered blocks, the chain is pinned", async () => {
  const fake = fakeVerifier(), [v] = verifierSource(fake).clients;
  for (const tag of ["safe", "finalized"]) {
    await assert.rejects(v.request({ method: "eth_getBlockByNumber", params: [tag, false] }), /no safe or finalized tier/);
    await assert.rejects(v.request({ method: "eth_call", params: [{ to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: "book" }) }, tag] }), /no safe or finalized tier/);
  }
  await createChainReader({ clients: [v], minAgree: 1, vault: VAULT, confirmations: 2, maxAgeSec: 120 }).readState({ id: ID });
  assert.ok(fake.st.callBlocks.length > 0 && fake.st.callBlocks.every((b) => /^0x[0-9a-f]+$/.test(b)), "v1 state reads use block numbers, never a tag");
  assert.throws(() => verifierSource(fakeVerifier(), { chainId: 10 }), /not the verifier's chain/, "v1 verifier source is pinned to Base");
});

test("v2 refuses the verifier (alone or mixed): requireCanonical is not enforced by the pinned verifier", () => {
  const [v] = verifierSource(fakeVerifier()).clients;
  const other = { getBlockNumber: async () => 1n, getBlock: async () => ({}), getChainId: async () => 8453 };
  for (const clients of [[v], [v, other, { ...other }]])
    assert.throws(() => createQuorumReader({ clients, minAgree: clients.length === 1 ? 1 : 2, chainId: 8453 }), (e) => e.code === "chain_verifier_unsupported");
  assert.throws(() => createChainReaderV2({ clients: [v], vault: VAULT, minAgree: 1, chainId: 8453 }), (e) => e.code === "chain_verifier_unsupported");
});

test("wrong-branch / A-B-A negative: a hash read is never translated to a block number", async () => {
  const fake = fakeVerifier(), [v] = verifierSource(fake).clients;
  fake.st.abaNumber = 990n;
  const pin = { blockHash: fake.hashOf(990n), requireCanonical: true };
  const data = encodeFunctionData({ abi: ABI, functionName: "book" });
  const out = await v.request({ method: "eth_call", params: [{ to: VAULT, data }, pin] });
  assert.deepEqual(fake.st.callBlocks.at(-1), pin, "the canonical hash object reaches the verifier unchanged");
  assert.equal(decodeFunctionResult({ abi: ABI, functionName: "book", data: out }).toLowerCase(), BOOK, "block A's state, not B's");
  // what a number translation would have read in the A-B-A window (the rejected r2 design): B's state
  const byNumber = await v.request({ method: "eth_call", params: [{ to: VAULT, data }, toHex(990n)] });
  assert.notEqual(decodeFunctionResult({ abi: ABI, functionName: "book", data: byNumber }).toLowerCase(), BOOK);
});

const ENV0 = { CUSTODY_VAULT: VAULT };
test("v1 daemon config (pure): legacy unchanged; verifier needs RPC settings ABSENT, blank is refused", () => {
  assert.deepEqual(custodianConfigFromEnv({ ...ENV0, CUSTODY_RPCS: "https://a.example, https://b.example" }),
    { vault: VAULT, rpcs: ["https://a.example", "https://b.example"], minAgree: 2, maxAgeSec: 120, chainId: 8453, stateDir: path.resolve("custodian-state") });
  assert.throws(() => custodianConfigFromEnv({ ...ENV0, CUSTODY_RPCS: "" }), /names 0 RPC/, "legacy: blank RPCs still refused as before");
  const V = { ...ENV0, CUSTODY_CHAIN_SOURCE: "verifier", CUSTODY_CHAIN_VERIFIER: VERIFIER };
  const ok = custodianConfigFromEnv(V);
  assert.deepEqual([ok.chainSource, ok.verifier, ok.txBackend, ok.rpcs, ok.minAgree], ["verifier", VERIFIER, null, undefined, undefined]);
  for (const [k, val] of [["CUSTODY_RPCS", ""], ["CUSTODY_RPCS", "https://mainnet.base.org"], ["CUSTODY_MIN_AGREE", ""], ["CUSTODY_MIN_AGREE", "1"]])
    assert.throws(() => custodianConfigFromEnv({ ...V, [k]: val }), /must be unset, not blank/, `${k}=${JSON.stringify(val)}`);
  assert.throws(() => custodianConfigFromEnv({ ...V, CUSTODY_TX_BACKEND: "" }), /blank/);
  assert.throws(() => custodianConfigFromEnv({ ...V, CUSTODY_CHAIN_VERIFIER: "" }), /needs CUSTODY_CHAIN_VERIFIER/);
  assert.throws(() => custodianConfigFromEnv({ ...ENV0, CUSTODY_RPCS: "https://a.example,https://b.example", CUSTODY_CHAIN_VERIFIER: VERIFIER }), /not verifier/);
  for (const src of ["", "public", "rpc"]) assert.throws(() => custodianConfigFromEnv({ ...ENV0, CUSTODY_CHAIN_SOURCE: src }), /quorum \(default\) or verifier/);
  // the daemon's reader wiring for that config: the verifier source, one authority
  const s = custodyChainSource(ok, { fetch: fakeVerifier().fetch });
  assert.equal(s.mode, "verifier"); assert.ok(createChainReader({ rpcs: s.rpcs, clients: s.clients, minAgree: s.minAgree, vault: VAULT }));
});

test("the real custodian daemon refuses a mixed or blank verifier config before any key, file or network use", () => {
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "../custody/custodian-daemon.mjs");
  const run = (extra) => spawnSync(process.execPath, [daemon, "serve"], { env: { PATH: process.env.PATH, CUSTODY_VAULT: VAULT, CUSTODY_STATE_DIR: "/nonexistent/custody-test", ...extra }, encoding: "utf8", timeout: 20_000 });
  for (const extra of [{ CUSTODY_CHAIN_SOURCE: "verifier", CUSTODY_CHAIN_VERIFIER: VERIFIER, CUSTODY_RPCS: "" },
                       { CUSTODY_CHAIN_SOURCE: "verifier", CUSTODY_CHAIN_VERIFIER: VERIFIER, CUSTODY_MIN_AGREE: "1" },
                       { CUSTODY_CHAIN_SOURCE: "public" }, { CUSTODY_RPCS: "https://a.example,https://b.example", CUSTODY_TX_BACKEND: "http://127.0.0.1:9" }]) {
    const r = run(extra);
    assert.equal(r.status, 1, JSON.stringify(extra) + r.stderr);
    assert.match(r.stderr, /custodian: (CUSTODY_CHAIN_SOURCE|CUSTODY_TX_BACKEND)/, r.stderr);
  }
});
