// mcp/independent.mjs without a chain: operator configuration, the agreed-block Scope over scripted peers (a liar is
// outvoted; too few honest peers refuse), the builder snapshot replay (a change between build and answer forces ONE
// rebuild, then a refusal), per-call isolation, and the closed gateway. The protocol-level suite is mcp-independent.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuorumChain } from "../cli/independent.mjs";
import { loadConfig, Scope, revalidate, independentBackend, currentScope } from "../mcp/independent.mjs";
import { createTools } from "../relay/mcp.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ind-unit-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, o) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); return f; };
const base = { contractPins: "pins.json", rpcs: ["http://127.0.0.1:1", "http://127.0.0.1:2"], stateDir: "state" };

test("configuration: strict, operator-owned, relative to its file; a remote adapter never takes plaintext secrets", () => {
  write("pins.json", { version: 1, chainId: 8453, contracts: {} });
  const ok = loadConfig(write("c1.json", { format: "enclave-mcp-independent/v1", profiles: { local: base } }));
  assert.equal(ok.profiles.get("local").contractPins, path.join(tmp, "pins.json"));
  assert.equal(ok.profiles.get("local").stateDir, path.join(tmp, "state"));
  for (const [bad, why] of [
    [{ format: "x", profiles: { a: base } }, /not an enclave-mcp-independent\/v1/],
    [{ format: "enclave-mcp-independent/v1", profiles: { a: { ...base, apiBase: "https://api.enclave.host" } } }, /unknown key apiBase/],
    [{ format: "enclave-mcp-independent/v1", profiles: { a: { ...base, stateDir: undefined } } }, /stateDir is required/],
    [{ format: "enclave-mcp-independent/v1", profiles: { Bad: base } }, /lowercase/],
    [{ format: "enclave-mcp-independent/v1", profiles: { a: { ...base, remote: { allowPlaintextSecrets: true } } } }, /never accepts plaintext secrets/],
    [{ format: "enclave-mcp-independent/v1", profiles: { a: { ...base, managementDirectories: ["http://10.0.0.1:80/path"] } } }, /must be an origin/],
  ]) assert.throws(() => loadConfig(write("bad.json", bad)), why);
  assert.throws(() => loadConfig(write("dup.json", '{"format":"enclave-mcp-independent/v1","format":"x","profiles":{}}')), /duplicate|cannot read/);
});

test("a backend may add optional arguments, never replace an original one", () => {
  const stub = { read() {}, addresses() {}, depRev() {}, catRev() {}, catalogApps() {} };
  assert.throws(() => createTools({ ...stub, extend: { get_deployment: { properties: { id: { type: "string" } } } } }), /would replace an original argument/);
  const t = createTools({ ...stub, extend: { account: { properties: { owner: { type: "string" } } } } }).tools.find((x) => x.name === "account");
  assert.ok(t.inputSchema.properties.owner && t.inputSchema.properties.token, "added beside the originals");
});

// ---- scripted peers -------------------------------------------------------------------------------------------------
function peers({ n = 3, head = 100n, value = () => 7n, lie = new Set(), now = Date.now }) {
  const st = { head, value, lie };
  const hash = (b) => "0x" + b.toString(16).padStart(64, "0");
  const client = (i) => ({
    getChainId: async () => 8453,
    getBlockNumber: async () => st.head,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: hash(blockNumber), timestamp: BigInt(Math.floor(now() / 1000)) }),
    readContract: async ({ functionName, args, blockNumber }) => (st.lie.has(i) ? 900n + BigInt(i) : st.value(functionName, args, blockNumber)),   // liars disagree with each other
    getCode: async () => "0x",
  });
  return { st, clients: Array.from({ length: n }, (_, i) => ({ origin: `http://127.0.0.1:${i + 1}`, client: client(i) })) };
}
const authorityOf = (clients) => {
  const chain = new QuorumChain({ clients, quorum: 2, confirmations: 1 });
  return { chain, name: "unit", cfg: { name: "unit", grantFrontend: null }, trust: { pins: {} }, ready: async () => {} };
};
const ABI = [{ type: "function", name: "x", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

test("one call reads at ONE agreed block; a liar is outvoted, two disagreeing peers of three refuse", async () => {
  const p = peers({ lie: new Set([0]) });
  const s = new Scope(authorityOf(p.clients));
  assert.equal(await s.read("0x" + "11".repeat(20), ABI, "x"), 7n);
  assert.equal(s.block.number, 99n, "the quorum-th head minus the confirmations");
  p.st.head = 200n;
  assert.equal(await s.read("0x" + "22".repeat(20), ABI, "x"), 7n);
  assert.equal(s.block.number, 99n, "later reads of the same call stay on its block");
  const q = peers({ lie: new Set([0, 1]) });
  await assert.rejects(new Scope(authorityOf(q.clients)).read("0x" + "11".repeat(20), ABI, "x"), /no 2 RPCs agreed|different answers/);
  // the documented limit (RPC agreement is not a light client): two COLLUDING peers of three are believed
  const c = peers({ lie: new Set([0, 1]) }); c.clients.forEach((x, i) => { if (i < 2) x.client.readContract = async () => 999n; });
  assert.equal(await new Scope(authorityOf(c.clients)).read("0x" + "11".repeat(20), ABI, "x"), 999n);
});

test("replay: a record that changed between the build and the answer is a SnapshotChanged; time-dependent reads are exempt", async () => {
  let v = 7n;
  const p = peers({ value: (fn) => (fn === "refundableOf" ? BigInt(Date.now()) : v) });
  const a = authorityOf(p.clients);
  const s = new Scope(a);
  await s.read("0x" + "11".repeat(20), ABI, "x");
  await s.read("0x" + "11".repeat(20), [{ ...ABI[0], name: "refundableOf" }], "refundableOf");
  p.st.head = 105n;
  assert.ok(await revalidate(s), "unchanged state revalidates at the fresh block");
  v = 8n;
  await assert.rejects(revalidate(s), (e) => e.name === "SnapshotChanged" && /x changed between block 99 and 104/.test(e.message));
});

test("the backend rebuilds once on a changed snapshot, then refuses; every call gets its own scope; the gateway is closed", async () => {
  let v = 1n;
  const p = peers({ value: () => v });
  const B = independentBackend(authorityOf(p.clients));
  let builds = 0;
  const builder = async () => { builds++; await B.read("0x" + "11".repeat(20), ABI, "x"); v++; p.st.head += 1n; return { transactions: [] }; };
  await assert.rejects(B.run({}, async () => B.finalize("b", await builder())), /refused: x changed/);
  assert.equal(builds, 2, "one rebuild, then the refusal");
  v = 5n; let stable = 0;
  const out = await B.run({}, async () => { stable++; await B.read("0x" + "11".repeat(20), ABI, "x"); return B.finalize("b", { transactions: [] }); });
  assert.equal(stable, 1); assert.ok(out.authority.revalidatedAt && out.authority.blockNumber);
  const seen = await Promise.all([1, 2, 3].map(() => B.run({}, async () => currentScope())));
  assert.equal(new Set(seen).size, 3, "concurrent calls never share a scope");
  await assert.rejects(B.run({}, () => B.self("GET", "/v1/pricing")), /never contacts the Enclave gateway \(GET \/v1\/pricing refused\)/);
  assert.throws(() => currentScope(), /outside a tools\/call scope/);
});

test("verified host capacity records become the hosted availability/pricing shapes; without records capabilities are unknown", async () => {
  const { independentExtras } = await import("../mcp/independent-tools.mjs");
  const p = peers({});
  const a = { ...authorityOf(p.clients), cfg: { name: "unit", grantFrontend: null, hostPolicy: "off", capacityDirectories: [], capacityCold: false, stateDir: tmp } };
  const B = independentBackend(a, independentExtras());
  const host = (id, cpu, gpu = 0n) => ({ id, endpoint: `https://${id.slice(2, 6)}.test`, repo: "", measurement: "0x" + "00".repeat(32), operator: "0x" + "aa".repeat(20),
    registeredAt: 1, lastSeen: Math.floor(Date.now() / 1000), active: true, cpuPricePerSec6: cpu, gpuPricePerSec6: gpu, proofKey: "0x" + "00".repeat(20), payoutWallet: "0x" + "bb".repeat(20) });
  const h1 = host("0x" + "01".repeat(32), 2000n), h2 = host("0x" + "02".repeat(32), 1500n, 9000n);
  const prime = (s, capacity) => { s._bindings = Promise.resolve({ book: "0x" + "cc".repeat(20) }); s.block = { number: 99n, hash: "0x" + "99".repeat(32), timestamp: Date.now(), agreeing: 3, of: 3, peers: [0, 1, 2] };
    s.memo.set("registry", Promise.resolve([h1, h2])); s.memo.set("capacity", Promise.resolve(capacity)); };
  const noRecords = await B.run({}, async () => { prime(currentScope(), null); return { av: await B.availability(), hw: await B.pricing(), rows: await B.enclaves() }; });
  assert.equal(noRecords.av.aggregate, false, "no verified record: fleet capabilities are unknown");
  assert.equal(noRecords.av.cheapestCpuPricePerSec6, "1500"); assert.equal(noRecords.av.cheapestGpuPricePerSec6, "9000"); assert.equal(noRecords.hw, null);
  assert.equal(noRecords.rows.find((x) => x.id === h1.id).availability.askCpuPricePerSec6, "2000", "a host's ask is its posted registry price");
  const rec = (gpu, extra) => ({ status: "verified", expiresAt: Date.now() + 60000, availability: { gpu, claimEnabled: true, nodeRamGb: 64, nodeGflops: 900, nodeVcpus: 16,
    cardVramGb: gpu ? 80 : 0, cardTflops: gpu ? 400 : 0, devDeploy: true, p3: true, configOverride: true, configCidOverride: true, configEdit: true, shareResize: true, waf: true, ...extra } });
  const both = { hosts: [{ hostId: h1.id, capacity: rec(false, { p3: false }) }, { hostId: h2.id, capacity: rec(true) }], aggregate: { aggregate: true, enclaves: 2, claiming: 2 } };
  const v = await B.run({}, async () => { prime(currentScope(), both); return { av: await B.availability(), hw: await B.pricing() }; });
  assert.equal(v.av.aggregate, true); assert.equal(v.av.verifiedCapacityRecords, 2);
  assert.equal(v.av.devDeploy, true); assert.equal(v.av.p3, false, "a capability is the fleet's only if EVERY verified host reports it");
  assert.deepEqual(v.hw.node, { ramGb: 64, gflops: 900, vcpus: 16 }); assert.deepEqual(v.hw.card, { vramGb: 80, tflops: 400 });
});

test("entrypoints: loopback-only unless --remote; --remote serves profiles by path only; a profile is never a tool argument", async () => {
  const { main } = await import("../mcp/server.mjs");
  write("pins.json", { version: 1, chainId: 8453, contracts: {} });
  const cfg = write("entry.json", { format: "enclave-mcp-independent/v1", profiles: { a: base, b: base } });
  await assert.rejects(main(["--config", cfg, "--profile", "a", "--listen", "0.0.0.0:0"]), /loopback only/);
  await assert.rejects(main(["--config", cfg, "--profile", "a", "--listen", "localhost:0"]), /loopback only/);
  await assert.rejects(main(["--config", cfg, "--remote"]), /--remote needs --listen/);
  await assert.rejects(main(["--config", cfg, "--remote", "--profile", "a", "--listen", "127.0.0.1:0"]), /serves every configured profile/);
  await assert.rejects(main(["--config", cfg]), /--profile NAME: one of a, b/);
  await assert.rejects(main([]), /--config FILE is required/);
  const { createTools } = await import("../relay/mcp.js");
  const { independentBackend } = await import("../mcp/independent.mjs");
  const { independentExtras } = await import("../mcp/independent-tools.mjs");
  const tools = createTools(independentBackend({ cfg: { name: "x" } }, independentExtras())).tools;
  for (const t of tools) for (const k of Object.keys(t.inputSchema.properties))
    assert.ok(!/profile|digest|rpc|directory|config(File|Path)|pins/i.test(k) || ["config", "configCid", "clearConfig"].includes(k), `${t.name}.${k} must not select trust`);
});

test("remote adapter secrets: ciphertext-only schemas; plaintext-shaped arguments refused statically before ANY chain read", async () => {
  const { createTools: ct, callToolIn } = await import("../relay/mcp.js");
  const { independentBackend: ib } = await import("../mcp/independent.mjs");
  const { independentExtras } = await import("../mcp/independent-tools.mjs");
  let touched = 0;
  const trap = new Proxy({}, { get: () => { touched++; throw new Error("chain touched"); } });
  const authority = { cfg: { name: "remote" }, name: "remote", chain: trap, trust: trap, ready: async () => {} };
  const B = ib(authority, independentExtras({ remote: true }));
  const set = ct(B);
  const st = set.tools.find((t) => t.name === "set_secrets"), gt = set.tools.find((t) => t.name === "get_secrets");
  assert.deepEqual(Object.keys(st.inputSchema.properties), ["id", "action", "sealedBundle", "expectPolicyRev"]);
  assert.deepEqual(Object.keys(gt.inputSchema.properties), ["id", "action"]);
  const canary = "unit-canary-value";
  for (const args of [{ id: "0x" + "11".repeat(32), action: "write", payload: JSON.stringify({ set: { K: canary } }) },
                      { id: "0x" + "11".repeat(32), payload: canary, expiry: 1, signature: "0x" + "22".repeat(65) },
                      { id: "0x" + "11".repeat(32), action: "prepare", readToken: canary }]) {
    const out = await callToolIn(set, B, "set_secrets", args, {});
    assert.equal(out.isError, true); assert.match(out.content[0].text, /accepts no plaintext values/);
    assert.ok(!out.content[0].text.includes(canary), "never echoed");
  }
  const g = await callToolIn(set, B, "get_secrets", { id: "0x" + "11".repeat(32), action: "prepare", signature: canary }, {});
  assert.match(g.content[0].text, /accepts no plaintext values/);
  assert.equal(touched, 0, "nothing was read for a refused call");
  // the local server keeps the original arguments
  const local = ct(ib(authority, independentExtras())).tools.find((t) => t.name === "set_secrets");
  assert.ok(["payload", "expiry", "signature", "readToken"].every((k) => k in local.inputSchema.properties));
  // the client seal refuses incomplete inputs instead of guessing
  const { sealForRemote } = await import("../mcp/remote-secrets-client.mjs");
  assert.throws(() => sealForRemote({ sealing: {} }, { A: "1" }), /lacks the vault/);
});
