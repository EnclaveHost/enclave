// relay/fleet.mjs registry reads through an injected chain authority (the DNS relay's relayChainAuthority client):
// offline, no network - globalThis.fetch is replaced by a spy that records and refuses, so ANY provider request is seen.
// What this proves: endpoint selection (no public RPC is contacted when the authority is injected, and nothing falls back
// to BASE_RPC). It does NOT prove anything about proof/finality: that is the verifier's own property (unsafe tier, no L1
// finality), tested in test/chain-authority.test.mjs and test/relay-chain-authority.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { fleetConfig, createFleet } from "../relay/fleet.mjs";
import { relayChainSelection } from "../relay/relay-chain-authority.mjs";

const REG = "0x" + "12".repeat(20), OP = "0x" + "34".repeat(20);
const ROWS = [{ endpoint: "https://h1.example.com/", operator: OP, active: true, caps: 0n }, { endpoint: "https://gone.example.com", operator: OP, active: false, caps: 0n }];
function fetchSpy() {
  const urls = []; const real = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u?.url ?? u)); throw new Error("offline test: no network"); };
  return { urls, restore: () => { globalThis.fetch = real; } };
}
function fakeChain({ fail = false } = {}) {
  const calls = [];
  return { calls, readContract: async ({ address, functionName, args }) => {
    calls.push(functionName);
    if (fail) throw new Error("verifier unavailable");
    assert.equal(address.toLowerCase(), REG);
    if (functionName === "registrySchema") return 1n;
    if (functionName === "count") return BigInt(ROWS.length);
    if (functionName === "getPage") return args[0] === 0n ? ROWS : [];
    throw new Error(`unexpected ${functionName}`);
  } };
}
const cfgOf = (extra = {}) => ({ ...fleetConfig({ REGISTRY_ADDRESS: REG, TRUSTED_OPERATORS: OP, REGISTRY_POLL_SEC: "3600" }), ...extra });

test("injected chain authority: every registry read goes to it, no provider URL is contacted", async () => {
  const spy = fetchSpy(), chain = fakeChain();
  const fleet = createFleet(cfgOf({ chainClient: chain }));
  try {
    await fleet.start();
    assert.deepEqual(fleet.origins(), ["https://h1.example.com"]);
    assert.equal(fleet.operatorForEndpoint("https://h1.example.com"), OP);
    assert.equal(fleet.operatorForEndpoint("https://gone.example.com"), null, "inactive rows grant nothing");
    assert.ok(chain.calls.includes("count") && chain.calls.includes("getPage"));
    assert.deepEqual(spy.urls, [], "no BASE_RPC / public RPC request");
  } finally { fleet.stop(); spy.restore(); }
});

test("injected authority outage fails closed: empty fleet, no fallback to BASE_RPC", async () => {
  const spy = fetchSpy();
  const fleet = createFleet(cfgOf({ chainClient: fakeChain({ fail: true }), baseRpc: "https://mainnet.base.org" }));
  try {
    await fleet.start();
    assert.deepEqual(fleet.origins(), []);
    assert.equal(fleet.operatorForEndpoint("https://h1.example.com"), null);
    assert.deepEqual(spy.urls, [], "the legacy provider is never tried");
  } finally { fleet.stop(); spy.restore(); }
});

test("legacy default unchanged: without an injected authority the fleet reads BASE_RPC (default mainnet.base.org)", async () => {
  const spy = fetchSpy();
  const cfg = cfgOf();
  assert.equal(cfg.baseRpc, "https://mainnet.base.org");
  const fleet = createFleet(cfg);
  try {
    await fleet.start();                                  // the spy refuses: refresh() keeps the (empty) last known fleet
    assert.deepEqual(fleet.origins(), []);
    assert.ok(spy.urls.length > 0 && spy.urls.every((u) => u.startsWith("https://mainnet.base.org")), JSON.stringify(spy.urls));
  } finally { fleet.stop(); spy.restore(); }
});

test("the DNS relay's selection: unset keeps the legacy path; verifier + BASE_RPC is refused, not resolved", () => {
  assert.equal(relayChainSelection({}), null);
  assert.throws(() => relayChainSelection({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:8545", BASE_RPC: "https://mainnet.base.org" }), /BASE_RPC/);
  assert.throws(() => relayChainSelection({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "https://mainnet.base.org" }), /loopback|verifier/i, "a public URL is never the verifier");
  const a = relayChainSelection({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:8545" });
  assert.equal(a.mode, "verifier"); assert.equal(typeof a.client.readContract, "function");
});

// ---- address book + deployments ledger (the SECOND client site, runnerClient) and outage AFTER a healthy refresh ----
import { keccak256, stringToBytes } from "viem";
const BOOK = "0x" + "56".repeat(20), DEP = "0x" + "78".repeat(20), DEP_ID = "0x" + "9a".repeat(32);
const KEY_REGISTRY = "0x7265676973747279000000000000000000000000000000000000000000000000";
const KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42);
const H1 = "https://h1.example.com";
function fakeBookChain() {
  const st = { down: false, calls: [] };
  const answer = ({ address, functionName, args }) => {
    const a = address.toLowerCase();
    if (a === BOOK && functionName === "addr") return args[0] === KEY_REGISTRY ? REG : args[0] === KEY_DEPLOYMENTS ? DEP : "0x" + "00".repeat(20);
    if (a === REG) return { registrySchema: 1n, count: BigInt(ROWS.length), getPage: args?.[0] === 0n ? ROWS : [] }[functionName];
    if (a === DEP) return { deploymentsSchema: 2n, count: 1n,
      getPage: [{ id: DEP_ID, runner: keccak256(stringToBytes(H1)), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 86400) }] }[functionName];
    return undefined;
  };
  return { st, readContract: async (q) => {
    st.calls.push(`${q.address.toLowerCase()}.${q.functionName}`);
    if (st.down) throw new Error("verifier unavailable");
    const v = answer(q); if (v === undefined) throw new Error(`unexpected ${q.address}.${q.functionName}`); return v;
  } };
}
const bookCfg = (extra = {}) => ({ ...fleetConfig({ ADDRESS_BOOK_ADDRESS: BOOK, TRUSTED_OPERATORS: OP, REGISTRY_POLL_SEC: "3600" }), ...extra });

test("address book and deployments ledger are read through the injected authority (both client sites)", async () => {
  const spy = fetchSpy(), chain = fakeBookChain();
  const fleet = createFleet(bookCfg({ chainClient: chain }));
  try {
    await fleet.start();
    assert.deepEqual(fleet.origins(), [H1], "registry resolved from the book, rows read at that registry");
    assert.ok(chain.st.calls.includes(`${BOOK}.addr`) && chain.st.calls.includes(`${REG}.getPage`));
    assert.equal(await fleet.runnerEndpointFor(DEP_ID), H1, "the ledger's runner resolves to the in-fleet endpoint");
    assert.ok(chain.st.calls.includes(`${DEP}.deploymentsSchema`) && chain.st.calls.includes(`${DEP}.getPage`), "ledger reads used the injected client");
    assert.deepEqual(spy.urls, [], "no BASE_RPC / public RPC request from either client site");
  } finally { fleet.stop(); spy.restore(); }
});

test("outage AFTER a healthy refresh: no public fallback; the INHERITED stale-cache behaviour is kept and documented", async () => {
  const spy = fetchSpy(), chain = fakeBookChain(), logs = [];
  // registryPollSec 0.05 -> the existing refresh interval fires every 50 ms (fleet.mjs start())
  const fleet = createFleet(bookCfg({ chainClient: chain, registryPollSec: 0.05 }), (m) => logs.push(m));
  const realNow = Date.now;
  try {
    await fleet.start();
    assert.deepEqual(fleet.origins(), [H1]);
    assert.equal(await fleet.runnerEndpointFor(DEP_ID), H1);          // fills the 10 s ledger cache
    chain.st.down = true; const before = chain.st.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(chain.st.calls.length > before, "refreshes kept asking the injected authority");
    assert.deepEqual(spy.urls, [], "no public RPC fallback during the outage");
    // INHERITED (unchanged fleet.mjs refresh(), :~600): a failed registry read keeps the LAST KNOWN fleet, with no expiry,
    // so origins and operatorForEndpoint stay at the pre-outage answer. This is NOT fail-closed for an existing fleet.
    assert.deepEqual(fleet.origins(), [H1]);
    assert.equal(fleet.operatorForEndpoint(H1), OP);
    assert.ok(logs.some((m) => /registry read failed \(keeping 1 known\)/.test(m)), logs.join("\n"));
    // INHERITED ledger cache (ledgerRows, 10 s): within it the pre-outage runner answer is served; past it the failed read
    // makes runnerEndpointFor answer null (the caller's probe path), never a provider read.
    assert.equal(await fleet.runnerEndpointFor(DEP_ID), H1, "inside the 10 s ledger cache: cached answer");
    Date.now = () => realNow() + 11_000;
    assert.equal(await fleet.runnerEndpointFor(DEP_ID), null, "past the cache: null, not a fallback");
    assert.deepEqual(spy.urls, []);
  } finally { Date.now = realNow; fleet.stop(); spy.restore(); }
});
