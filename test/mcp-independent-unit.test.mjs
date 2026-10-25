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
  assert.ok("action" in local.inputSchema.properties, "the local server answers its own sealing facts (prepare)");
});

test("remote seal: the recipient is the owner's OWN read; a remote hint differing in any field, or an altered update, is refused", async () => {
  const { sealForRemote, verifyRemoteUpdate, SEALING_FIELDS, RecipientError } = await import("../mcp/remote-secrets-client.mjs");
  const v2 = await import("../custody/v2/protocol.mjs");
  const { UPDATE_V2_ABI } = await import("../custody/v2/owner.mjs");
  const { encodeFunctionData } = await import("viem");
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const key = () => { const s = v2.randomScalar(); return { s, Y: "0x" + Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(s).toRawBytes(true)).toString("hex") }; };
  const committee = key(), attacker = key();
  const own = { sealing: { chainId: 8453, vault: "0x" + "ab".repeat(20), id: "0x" + "11".repeat(32), committeeId: "0x" + "c1".repeat(32), committeeY: committee.Y,
    nextSecretRev: "4", expectPolicyRev: "7", owner: "0x" + "0e".repeat(20), configSha256: "cf".repeat(32) } };
  const env = { TOKEN: "unit-secret-" + Math.random().toString(36).slice(2) };
  // no own read: refused, whatever the hint says
  assert.throws(() => sealForRemote(own, env), RecipientError);
  assert.throws(() => sealForRemote(own, env, {}), /needs the sealing facts the owner's own client read/);
  // each substitution: an attacker's VALID point, another deployment, chain, vault, committee, revision or owner
  const subs = { committeeY: attacker.Y, id: "0x" + "22".repeat(32), chainId: 1, vault: "0x" + "cd".repeat(20), committeeId: "0x" + "c2".repeat(32),
    nextSecretRev: "3", expectPolicyRev: "6", owner: "0x" + "0f".repeat(20) };
  assert.deepEqual(Object.keys(subs).sort(), [...SEALING_FIELDS].sort(), "every security field is exercised");
  for (const [k, v] of Object.entries(subs))
    assert.throws(() => sealForRemote({ sealing: { ...own.sealing, [k]: v } }, env, { expected: own }), new RegExp(`names ${k} .*nothing was sealed or sent`), k);
  assert.throws(() => sealForRemote({ sealing: { ...own.sealing, configSha256: "00".repeat(32) } }, env, { expected: own }), /config commitment differs/);
  assert.throws(() => sealForRemote(own, env, { expected: own, id: "0x" + "22".repeat(32) }), /not the requested deployment/);
  // agreement: sealed to the owner's read, which only the committee's key opens; the attacker's key does not
  const { sealedBundle, expectPolicyRev } = sealForRemote(own, env, { expected: own, id: own.sealing.id });
  assert.equal(expectPolicyRev, "7");
  const bundle = Buffer.from(sealedBundle.slice(2), "hex");
  const label = v2.labelOf({ chainId: 8453, vault: own.sealing.vault, id: own.sealing.id, secretRev: 4n, committeeId: own.sealing.committeeId });
  assert.ok(v2.verifyLabelProof(bundle, label), "bound to the owner's label");
  const R = v2.parseBundle(bundle).Rp;
  assert.deepEqual(v2.decryptBundle({ S: R.multiply(committee.s), label, bundle }).env, env);
  assert.throws(() => v2.decryptBundle({ S: R.multiply(attacker.s), label, bundle }));
  // the returned update: exactly this bundle, this guard, no policy change, to this vault on this chain
  const ZERO32 = "0x" + "00".repeat(32);
  const upd = (o = {}) => ({ expectPolicyRev: 7n, setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: true, bundle: sealedBundle, clear: false, ...o });
  const answer = ({ u = upd(), id = own.sealing.id, to = own.sealing.vault, chainId = 8453, value = "0x0", fn = "update" } = {}) => ({ transactions: [{ chainId, to, value,
    data: fn === "update" ? encodeFunctionData({ abi: UPDATE_V2_ABI, functionName: "update", args: [id, u] }) : "0x12345678" }] });
  assert.equal(verifyRemoteUpdate(answer(), { expected: own, sealedBundle }).to, own.sealing.vault);
  const other = sealForRemote(own, { X: "1" }, { expected: own }).sealedBundle;
  for (const [why, a] of [["policy", answer({ u: upd({ setPolicy: true, committeeId: "0x" + "c2".repeat(32), rules: "0x01" }) })], ["pause", answer({ u: upd({ paused: true }) })],
    ["bundle", answer({ u: upd({ bundle: other }) })], ["guard", answer({ u: upd({ expectPolicyRev: 6n }) })], ["deployment", answer({ id: "0x" + "22".repeat(32) })],
    ["vault", answer({ to: "0x" + "cd".repeat(20) })], ["chain", answer({ chainId: 1 })], ["value", answer({ value: "0x1" })], ["clear", answer({ u: upd({ clear: true }) })],
    ["not update", answer({ fn: "other" })], ["two", { transactions: [...answer().transactions, ...answer().transactions] }]])
    assert.throws(() => verifyRemoteUpdate(a, { expected: own, sealedBundle }), RecipientError, why);
  const clearA = answer({ u: upd({ setBundle: false, bundle: "0x", clear: true }) });
  assert.ok(verifyRemoteUpdate(clearA, { expected: own, clear: true }));
  assert.throws(() => verifyRemoteUpdate(answer(), { expected: own, clear: true }), /not exactly a clear/);
});

test("remote clear: judged against the owner's own clear plan (no recipient needed); a false no-op or any altered clear is refused", async () => {
  const { verifyRemoteClear, RecipientError } = await import("../mcp/remote-secrets-client.mjs");
  const { remoteClearSecrets } = await import("../mcp/hosted-client.mjs");
  const { UPDATE_V2_ABI } = await import("../custody/v2/owner.mjs");
  const { encodeFunctionData } = await import("viem");
  const ZERO32 = "0x" + "00".repeat(32), id = "0x" + "11".repeat(32), vault = "0x" + "ab".repeat(20);
  const clearU = (o = {}) => ({ expectPolicyRev: 7n, setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true, ...o });
  const txOf = ({ u = clearU(), tid = id, to = vault, chainId = 8453, value = "0x0" } = {}) => ({ chainId, to, value, data: encodeFunctionData({ abi: UPDATE_V2_ABI, functionName: "update", args: [tid, u] }) });
  const plan = { transactions: [txOf()] }, noop = { note: "nothing stored: already clear", transactions: [] };
  // already clear, confirmed locally: the adapter's no-op is accepted; a clear it invents is refused
  assert.equal(verifyRemoteClear({ transactions: [] }, noop), null);
  assert.throws(() => verifyRemoteClear(plan, noop), /owner's own read shows nothing stored/);
  assert.throws(() => verifyRemoteClear({}, noop), RecipientError);
  // values stored: a missing or empty answer is a false no-op
  for (const a of [{}, { transactions: [] }, { note: "nothing stored: already clear", transactions: [] }, null])
    assert.throws(() => verifyRemoteClear(a, plan), /refusing a false no-op/);
  assert.equal(verifyRemoteClear({ transactions: [txOf()] }, plan).to, vault);
  for (const [why, t] of [["chain", txOf({ chainId: 1 })], ["vault", txOf({ to: "0x" + "cd".repeat(20) })], ["value", txOf({ value: "0x1" })],
    ["deployment", txOf({ tid: "0x" + "22".repeat(32) })], ["stale guard", txOf({ u: clearU({ expectPolicyRev: 6n }) })],
    ["policy mutation", txOf({ u: clearU({ setPolicy: true, committeeId: "0x" + "c2".repeat(32), rules: "0x01" }) })], ["pause", txOf({ u: clearU({ paused: true }) })]])
    assert.throws(() => verifyRemoteClear({ transactions: [t] }, plan), /differs from the owner's own plan/, why);
  assert.throws(() => verifyRemoteClear({ transactions: [txOf(), txOf()] }, plan), /false no-op/);
  // the client: the owner's clear plan only (never sealing facts, so a deployment needs no recipient to be cleared)
  const calls = [];
  const local = { call: async (n, a) => { calls.push(a); if (a.action === "prepare") throw new Error("sealing facts asked for a clear"); return { structuredContent: noop }; } };
  const remote = (answer) => ({ callTool: async () => ({ structuredContent: answer }) });
  assert.deepEqual(await remoteClearSecrets(remote(noop), { id, local }), noop);
  assert.deepEqual(calls, [{ id, payload: JSON.stringify({ clear: true }) }]);
  await assert.rejects(remoteClearSecrets(remote(plan), { id, local }), /nothing stored/);
  const stored = { call: async () => ({ structuredContent: plan }) };
  await assert.rejects(remoteClearSecrets(remote(noop), { id, local: stored }), /false no-op/);
  await assert.rejects(remoteClearSecrets(remote(noop), { id }), /local authority/);
});
