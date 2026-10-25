// Owner-named history sources (work/history-owner-tools-interface.txt):
//   - one strict schema: the SDK (hosts, CLI) and the browser accept and refuse exactly the shared vectors the measured
//     guest runs through its real Authorize (isolation/m2/bootstrap/testdata/history-vectors.json; Go:
//     TestOwnerHistoryAgreesWithJavaScriptVectors); older packages keep their meaning;
//   - the SDK and the browser build the SAME bytes from the same owner input;
//   - credentials are never silent: userinfo/query refused, a key-like path only with explicit confirmation;
//   - the public options are offered with provenance and limits, never as a >31-day keyless promise;
//   - the relay reader's explicit-refusal cooldown (relay/lease-generation.mjs) on the live rev-16d bytecode rig: a 429ing
//     RPC sits out its cooldown without slowing the others, a slow HONEST contradiction is still seen, two refusing RPCs
//     never yield a fact, and a cooled RPC is probed again after its cooldown.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as SDK from "../sdk/bootstrap/package.mjs";
import { startLease16dRig } from "./helpers/lease16d-rig.mjs";
import { createLeaseGenerationReader } from "../relay/lease-generation.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hv = JSON.parse(fs.readFileSync(path.join(REPO, "isolation/m2/bootstrap/testdata/history-vectors.json"), "utf8"));
const intentOf = (s) => ({ version: 1, sha256: createHash("sha256").update(s).digest("hex") });
const anvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return false; } catch { return "needs anvil"; } })();
let SP;
before(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.location ??= { hostname: "localhost" };
  SP = await import(pathToFileURL(path.join(REPO, "site/js/core/startup-package.js")).href);
});

test("the SDK and the browser accept and refuse exactly the shared Go/JS history vectors", async () => {
  assert.ok(hv.cases.length >= 30 && hv.cases.filter((c) => c.valid).length >= 5);
  assert.ok(hv.cases.some((c) => c.valid && !c.manifest.includes('"history"')), "an older package without history is among the valid cases");
  for (const c of hv.cases){
    let sdk = null, browser = null;
    try { SDK.verifyPackage(Buffer.from(c.manifest), intentOf(c.manifest)); } catch (e){ sdk = e; }
    try { await SP.verifyPackage(new TextEncoder().encode(c.manifest), intentOf(c.manifest)); } catch (e){ browser = e; }
    assert.equal(sdk === null, c.valid, `${c.name}: SDK ${sdk ? sdk.message : "accepted"}`);
    assert.equal(browser === null, c.valid, `${c.name}: browser ${browser ? browser.message : "accepted"}`);
  }
});

test("the SDK (CLI) and the browser build the same bytes from the same owner input; history is appended last", async () => {
  const base = JSON.parse(hv.cases.find((c) => c.name === "no history member (an older package)").manifest);
  const scope = { chainId: base.chainId, ledger: base.ledger, deployment: base.deployment, owner: base.owner, appRef: base.appRef };
  const input = " https://gateway.tenderly.co/public/base\nhttps://base-rpc.polkachu.com ,https://base-rpc.polkachu.com";
  const fromSdk = SDK.historyFromList(input), fromSite = SP.historyFromForm({ rpcsText: input });
  assert.deepEqual(fromSdk, fromSite);
  assert.deepEqual(fromSdk.rpcs, ["https://base-rpc.polkachu.com", "https://gateway.tenderly.co/public/base"], "sorted, deduplicated");
  const names = { hosts: ["shop.example.com"] };
  const sdkPkg = SDK.preparePackage({ version: 1, ...scope, appId: base.appId, runtimeId: base.runtimeId, configText: base.configText, secretsMode: "public", names, history: fromSdk });
  const sitePkg = await SP.preparePackage(scope, { appId: base.appId, runtimeId: base.runtimeId, configText: base.configText, names, history: fromSite });
  assert.equal(Buffer.from(sitePkg.bytes).toString(), sdkPkg.bytes.toString());
  assert.deepEqual(Object.keys(JSON.parse(sdkPkg.bytes)).slice(-2), ["names", "history"]);
  // no history: exactly the bytes an older tool wrote
  const plainSdk = SDK.preparePackage({ version: 1, ...scope, appId: base.appId, runtimeId: base.runtimeId, configText: base.configText, secretsMode: "public" });
  const plainSite = await SP.preparePackage(scope, { appId: base.appId, runtimeId: base.runtimeId, configText: base.configText, history: SP.historyFromForm({ rpcsText: " " }) });
  assert.equal(Buffer.from(plainSite.bytes).toString(), plainSdk.bytes.toString());
  assert.equal(plainSdk.bytes.toString().includes("history"), false);
});

test("credentials are never silent: userinfo and query refused, a key-like path only when the owner confirms it is public", () => {
  for (const build of [(x, o) => SDK.historyFromList(x, o), (x, o) => SP.historyFromForm({ rpcsText: x, pathIsPublic: o?.pathIsPublic })]){
    assert.throws(() => build("https://user:pass@node.example.org"), /credentials/);
    assert.throws(() => build("https://node.example.org/rpc?apikey=abc"), /query/);
    assert.throws(() => build("https://node.example.org/#x"), /query or fragment/);
    assert.throws(() => build("http://node.example.org"), /https/);
    assert.throws(() => build("https://node.example.org:8545"), /no port/);
    const keyed = "https://base-mainnet.example-provider.com/v2/Ab3dE5gH7jK9mN1pQ3sT";
    assert.throws(() => build(keyed), /looks like a provider key/);
    assert.deepEqual(build(keyed, { pathIsPublic: true }).rpcs, [keyed], "the owner's explicit confirmation");
    assert.deepEqual(build("https://node.example.org/v2/node-1").rpcs, ["https://node.example.org/v2/node-1"], "an ordinary path is fine");
    assert.equal(build(""), null);
  }
  assert.equal(SDK.credentialLike("https://gateway.tenderly.co/public/base"), false);
});

test("warnings name what the owner should know; the public options carry provenance and limits and pass the schema", () => {
  for (const M of [SDK, SP]){
    assert.match(M.historyWarnings(null)[0], /no history sources/i);
    assert.match(M.historyWarnings({ rpcs: ["https://base.gateway.tenderly.co", "https://gateway.tenderly.co/public/base"] })[0], /only 1 independent operator/i);
    assert.equal(M.historyWarnings({ rpcs: ["https://base-rpc.polkachu.com", "https://gateway.tenderly.co/public/base"] }).length, 0);
    assert.match(M.historyWarnings({ rpcs: ["https://base-rpc.polkachu.com", "https://history.enclave.host"] }).join(" "), /run by Enclave/);
    assert.equal(M.HISTORY_PUBLIC_OPTIONS.length, 2);
    for (const o of M.HISTORY_PUBLIC_OPTIONS){
      assert.ok(o.url && o.operator && o.probed && o.served && o.limits, "provenance and limits shown");
      assert.ok(M.historyHost(o.url), `${o.url} passes the schema`);
      assert.match(o.limits, /not run by Enclave/);
    }
    assert.match(M.HISTORY_KEYLESS_LIMIT, /31 days/);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(SP.HISTORY_PUBLIC_OPTIONS)), JSON.parse(JSON.stringify(SDK.HISTORY_PUBLIC_OPTIONS)), "the browser shows the SDK's options");
  assert.ok(SDK.HISTORY_PUBLIC_OPTIONS.some((o) => /31\.7 days/.test(o.limits)), "the ~31-day pruning is stated, not hidden");
});

// ---- the relay reader's cooldown, on the live rev-16d bytecode rig ----
let rig;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reader = (o = {}) => createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: rig.ledger, fromBlock: 0, windowBlocks: 50,
  sleep: (ms, signal) => new Promise((ok) => { const t = setTimeout(ok, Math.min(ms, 20)); signal?.addEventListener("abort", () => clearTimeout(t), { once: true }); }), ...o });
const logCalls = (p) => p.mode.calls.filter((m) => m === "eth_getLogs").length;
after(async () => { if (rig) await rig.stop(); });

test("relay reader: a 429ing RPC sits out its cooldown and costs the others nothing; it is probed again afterwards", { skip: anvil, timeout: 120000 }, async () => {
  rig = await startLease16dRig();
  rig.honest(10);
  const id = await rig.create(), c = await rig.claim(id, rig.hosts.a);
  await rig.mine(400);                                                  // a search of ~8 steps of 50 blocks
  rig.peers[0].mode.rateLimit = 1_000_000;                              // every eth_getLogs refused with HTTP 429
  let clock = Date.now();
  const R = reader({ now: () => clock });
  const t0 = Date.now(), r = await R.writerAuthority(id);
  assert.equal(r.fact.claimBlock, c.block);
  assert.equal(logCalls(rig.peers[0]), 2, "one request and one retry, then the cooldown: not asked again for the other steps");
  assert.ok(logCalls(rig.peers[1]) >= 8, "the other two read every step");
  assert.ok(Date.now() - t0 < 10000, "no per-step backoff");
  // its cooldown over, it is asked again (and, still refusing, cools down for longer)
  rig.peers[0].mode.calls.length = 0; clock += 31_000;
  await rig.mine(60);
  await R.writerAuthority(id);
  assert.ok(logCalls(rig.peers[0]) >= 1, "probed again after its cooldown");
});

test("relay reader: a slow HONEST contradiction is still seen; two refusing RPCs give no fact", { skip: anvil, timeout: 120000 }, async () => {
  rig.honest(10);
  const id = await rig.create(); await rig.claim(id, rig.hosts.a); await rig.mine(30);
  Object.assign(rig.peers[2].mode, { delayMs: 400, dropLastLog: true });   // slower, answers, omits a log: no 429
  await assert.rejects(reader().writerAuthority(id), (e) => e.code === "disagree", "the slow answer was awaited and compared");
  rig.honest(10);
  rig.peers[0].mode.rateLimit = rig.peers[1].mode.rateLimit = 1_000_000;  // two of three refuse: one operator left
  await assert.rejects(reader().writerAuthority(id), (e) => e.code === "quorum_unavailable" && e.retry === true,
    "refusals are an RPC that may answer later: never empty history, never a fact");
  rig.honest(10);
});
