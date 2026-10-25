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
