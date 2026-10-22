// Review follow-ups for the independent dashboard:
//  1. per-HOST quotes (never one host's CPU price mixed with another's GPU price), owner-chosen ceilings;
//  2. a bounded, resumable ledger listing that never presents a partial scan as complete, follows transfers through
//     the ledger's own events, and re-reads every row at the current agreed block;
//  4. custom names built exactly as the CLI builds them, with the owner-bound challenge alias.
//   run: node --test test/site-independent-review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionResult, keccak256, toBytes, pad } from "viem";
import * as cliPkg from "../sdk/bootstrap/package.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "0x" + "22".repeat(20);
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: "0x" + "11".repeat(20), deployments: LEDGER, appCatalog: "0x" + "33".repeat(20),
    proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
    sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });
let IC, IL, SP;
test.before(async () => {
  const text = JSON.stringify(profile);
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost" };
  IC = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-chain.js")).href);
  IL = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-list.js")).href);
  SP = await import(pathToFileURL(path.join(REPO, "site/js/core/startup-package.js")).href);
});

// ---- 1. per-host quotes ----
const host = (endpoint, cpu, gpu, { lastSeen = 1000, active = true, payoutWallet = "0x" + "00".repeat(20) } = {}) =>
  ({ endpoint, cpuPricePerSec6: cpu, gpuPricePerSec6: gpu, lastSeen, active, payoutWallet, operator: "0x" + "99".repeat(20) });

test("quotes are per host: a CPU-cheap/GPU-dear host and a GPU-cheap/CPU-dear host never combine into a price nobody offers", () => {
  const hosts = [host("https://a.example", 100, 5000), host("https://b.example", 3000, 1000)];
  const q = IC.quoteHosts(hosts, { chainNow: 1000, nowMs: 1000 * 1000, gpuMilli: 500, cpuMilli: 100, rev: 16 });
  const totals = q.hosts.map((h) => h.rate6);
  assert.deepEqual(totals, [800n, 2510n], "B: 1000*0.5 + 3000*0.1 = 800; A: 5000*0.5 + 100*0.1 = 2510");
  assert.equal(q.defaultCap6, 800n);
  const mixed = (1000n * 500n + 100n * 100n + 999n) / 1000n;           // B's GPU + A's CPU = 510: offered by no host
  assert.ok(!totals.includes(mixed));
  assert.equal(q.hosts[0].endpoint, "https://b.example");
});

test("eligibility: a GPU request needs a posted card price and fresh authenticated liveness; free-for-you hosts never set the default ceiling", () => {
  const owner = "0x" + "ab".repeat(20);
  const hosts = [host("https://cpu-only.example", 50, 0), host("https://stale.example", 10, 10, { lastSeen: 1000 - 4000 }),
    host("https://mine.example", 1, 1, { payoutWallet: owner }), host("https://gpu.example", 200, 2000), host("https://off.example", 5, 5, { active: false })];
  const q = IC.quoteHosts(hosts, { chainNow: 1000, nowMs: 1000 * 1000, gpuMilli: 100, cpuMilli: 100, owner, rev: 16 });
  const by = Object.fromEntries(q.hosts.map((h) => [h.endpoint, h]));
  assert.equal(by["https://cpu-only.example"].eligible, false); assert.match(by["https://cpu-only.example"].reason, /GPU/);
  assert.equal(by["https://stale.example"].eligible, false); assert.match(by["https://stale.example"].reason, /no fresh authenticated liveness/);
  assert.equal(by["https://mine.example"].free, true);
  assert.ok(!("https://off.example" in by), "inactive registrations are not offered");
  assert.equal(q.defaultCap6, (2000n * 100n + 200n * 100n + 999n) / 1000n, "the cheapest CHARGING eligible host");
  assert.equal(IC.quoteHosts(hosts, { chainNow: 1000, nowMs: 1000 * 1000, gpuMilli: 100, cpuMilli: 100, owner, rev: 11 }).hosts.some((h) => h.free), false, "pre-rev-12 ledgers never waive");
});

// ---- 2. resumable listing over a scripted ledger, ABI-encoded from the real artifact ----
const ART = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json"), "utf8"));
const fn = (name) => ART.abi.find((x) => x.type === "function" && x.name === name && (name !== "getPage" || x.inputs.length === 2));
const sel = (sig) => keccak256(toBytes(sig)).slice(2, 10);
const TRANSFER = keccak256(toBytes("DeploymentTransferred(bytes32,address,address)"));
function ledgerChain(n, ownerOf){
  const recs = Array.from({ length: n }, (_, i) => ({ id: pad(("0x" + (i + 1).toString(16)), { size: 32 }), owner: ownerOf(i) }));
  const chain = { recs, block: 100, transfers: [], logsDown: false, calls: { getPage: 0, get: 0 } };
  const struct = (r) => ({ id: r.id, owner: r.owner, appRef: "catalog://x/0", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 100, appPort: 8080,
    isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 1n, spent6: 0n, runner: "0x" + "00".repeat(32),
    runnerOperator: "0x" + "00".repeat(20), leaseUntil: 0n });
  chain.transfer = (i, to) => { chain.block += 3; chain.recs[i].owner = to; chain.transfers.push({ block: chain.block, id: chain.recs[i].id, to }); };
  chain.append = (owner) => { chain.block += 1; chain.recs.push({ id: pad(("0x" + (chain.recs.length + 1).toString(16)), { size: 32 }), owner }); };
  chain.reader = {
    snapshot: async () => ({ number: chain.block, hash: "0x" + chain.block.toString(16).padStart(64, "0"), timestamp: 1000 + chain.block, rpcs: ["a", "b"] }),
    call: async (_s, to, data) => {
      const s4 = data.slice(2, 10);
      if (s4 === sel("count()")) return encodeFunctionResult({ abi: [fn("count")], functionName: "count", result: BigInt(chain.recs.length) });
      if (s4 === sel("getPage(uint256,uint256)")){
        chain.calls.getPage++;
        const start = Number(BigInt("0x" + data.slice(10, 74))), k = Number(BigInt("0x" + data.slice(74, 138)));
        return encodeFunctionResult({ abi: [fn("getPage")], functionName: "getPage", result: chain.recs.slice(start, start + k).map(struct) });
      }
      if (s4 === sel("get(bytes32)")){
        chain.calls.get++;
        const id = "0x" + data.slice(10, 74), r = chain.recs.find((x) => x.id === id);
        return encodeFunctionResult({ abi: [fn("get")], functionName: "get", result: r ? struct(r) : { ...struct({ id, owner: "0x" + "00".repeat(20) }), createdAt: 0n } });
      }
      throw new Error("unexpected call " + s4);
    },
    logs: async (_s, { fromBlock, toBlock, topics }) => {
      if (chain.logsDown) throw new Error("eth_getLogs range not served");
      assert.equal(topics[0], TRANSFER);
      return chain.transfers.filter((t) => t.block >= fromBlock && t.block <= toBlock)
        .map((t) => ({ blockNumber: t.block, logIndex: 0, topics: [TRANSFER, t.id, pad("0x01", { size: 32 }), pad(t.to, { size: 32 })], data: "0x" }));
    },
  };
  return chain;
}
const ME = "0x" + "aa".repeat(20), VAULT = "0x" + "bb".repeat(20), OTHER = "0x" + "cc".repeat(20);
const ledgerRev = async () => 16;
const step = (chain, store, extra = {}) => IL.listOwned([ME, VAULT], { reader: chain.reader, ledgerRev, maxPages: 2, store, ...extra });

test("a large ledger is read a few pages per call; partial results are labeled; rows appear only when verified", async () => {
  const chain = ledgerChain(650, (i) => (i % 97 === 5 ? ME : i === 600 ? VAULT : OTHER));
  const store = mem();
  const a = await step(chain, store);
  assert.equal(a.complete, false); assert.equal(a.scanned, 200); assert.equal(a.total, 650);
  assert.deepEqual(a.rows.map((r) => r.owner.toLowerCase()), [ME, ME, ME], "records 5, 102 and 199 so far");
  let r = a;
  for (let i = 0; i < 5 && !r.complete; i++) r = await step(chain, store);
  assert.equal(r.complete, true); assert.equal(r.scanned, 650);
  assert.equal(r.rows.length, 8, "seven of the wallet's records (5, 102, 199, 296, 393, 490, 587) and the vault's record 600");
  assert.ok(r.rows.some((x) => x.owner.toLowerCase() === VAULT), "vault rows are listed");
});

test("transfers in and out are followed through the ledger's events; new records are picked up; nothing is rescanned", async () => {
  const chain = ledgerChain(250, (i) => (i === 3 ? ME : OTHER));
  const store = mem();
  for (let i = 0; i < 3; i++) await step(chain, store);
  const pagesBefore = chain.calls.getPage;
  chain.transfer(10, ME);           // into the wallet
  chain.transfer(3, OTHER);         // away from the wallet
  chain.append(VAULT);              // a new vault record
  const r = await step(chain, store);
  assert.equal(r.complete, true);
  assert.deepEqual(r.rows.map((x) => x.id).sort(), [chain.recs[10].id, chain.recs[250].id].sort());
  assert.equal(chain.calls.getPage - pagesBefore, 1, "only the page holding the new record is read");
});

test("without event history the scan restarts and stays labeled incomplete until a full pass fits one call", async () => {
  const chain = ledgerChain(300, (i) => (i === 250 ? ME : OTHER));
  const store = mem();
  await step(chain, store);
  chain.logsDown = true; chain.transfer(0, ME);
  const r = await step(chain, store, { maxPages: 1, budgetMs: 1 });
  assert.equal(r.mode, "rescan"); assert.match(r.reason, /transfer history unavailable/);
  // the rescan gets a larger budget and here finishes in this call, so the result is complete and current
  assert.equal(r.complete, true);
  assert.deepEqual(r.rows.map((x) => x.id).sort(), [chain.recs[0].id, chain.recs[250].id].sort());
});

test("a planted index can nominate but never add a row; a shrinking count starts over; watched ids are re-read", async () => {
  const chain = ledgerChain(120, () => OTHER);
  const store = mem();
  const key = "enclave_ind_index:v1:8453:" + LEDGER;
  store.setItem(key, JSON.stringify({ v: 1, ids: chain.recs.map((r) => r.id), owners: chain.recs.map(() => ME), next: 120, synced: chain.block }));
  const r = await step(chain, store);
  assert.equal(r.rows.length, 0, "planted ownership claims are refused by the per-row re-read");
  store.setItem(key, JSON.stringify({ v: 1, ids: Array.from({ length: 500 }, (_, i) => pad(("0x" + (i + 1).toString(16)), { size: 32 })), owners: Array(500).fill(OTHER), next: 500, synced: chain.block }));
  const reset = await step(chain, store);
  assert.match(reset.reason, /started over/); assert.equal(reset.complete, true);
  IL.watchId(chain.recs[7].id, store);
  assert.deepEqual((await step(chain, store)).notMine, [chain.recs[7].id], "a watched id owned by someone else is reported, not listed");
  assert.throws(() => IL.watchId("0x1234", store), /full deployment id/);
});

// ---- 4. names ----
test("custom names: CLI-identical member and package bytes, owner-bound alias, strict validation", async () => {
  const scope = { chainId: 8453, ledger: LEDGER, deployment: "0x" + "ab".repeat(32), owner: "0x" + "77".repeat(20), appRef: "catalog://0x" + "cd".repeat(32) + "/0" };
  const names = SP.namesFromForm({ hostsText: "WWW.example.org\nshop.example.org, www.example.org", directory: "https://ca.example/dir",
    challenge: "https://responder.example", zone: "acme.responder.example" }, "public");
  assert.deepEqual(names, { hosts: ["shop.example.org", "www.example.org"], acme: { directory: "https://ca.example/dir", challenge: "https://responder.example", zone: "acme.responder.example" } });
  const mine = await SP.preparePackage(scope, { appId: "a1".repeat(32), runtimeId: "b2".repeat(32), configText: "{}", names });
  // the CLI side built as cli/enclave.mjs builds it from --names/--acme-* flags (not from namesFromForm), so a
  // member or key-order difference changes the bytes
  const f = { names: "www.example.org,shop.example.org", "acme-directory": "https://ca.example/dir", "acme-challenge": "https://responder.example", "acme-zone": "acme.responder.example" };
  const cliHosts = [...new Set(f.names.split(",").map((x) => x.trim()).filter(Boolean))].sort();
  const cliNames = { hosts: cliHosts, acme: { directory: f["acme-directory"], challenge: f["acme-challenge"], zone: f["acme-zone"] } };
  const cli = cliPkg.preparePackage({ version: 1, ...scope, appId: "a1".repeat(32), runtimeId: "b2".repeat(32), configText: "{}", secretsMode: "public", names: cliNames });
  assert.equal(Buffer.from(mine.bytes).toString(), cli.bytes.toString(), "byte-identical package");
  assert.equal(await SP.challengeAlias(scope.deployment, scope.owner, "acme.responder.example"), cliPkg.challengeAlias(scope.deployment, scope.owner, "acme.responder.example"));
  assert.notEqual(await SP.challengeLabel(scope.deployment, scope.owner), await SP.challengeLabel(scope.deployment, "0x" + "78".repeat(20)), "a new owner needs new DNS records");
  assert.equal(SP.namesFromForm({ hostsText: " " }, "public"), null, "empty = no names member");
  for (const [input, re] of [[{ hostsText: "", zone: "z.example" }, /at least one name/], [{ hostsText: "a.example.org", eabKid: "K", eabHmac: "H" }, /ACME directory/],
    [{ hostsText: "x.enclave.host" }, /outside enclave.host/], [{ hostsText: "a.example.org", directory: "http://ca.example", challenge: "https://r.example", zone: "z.example" }, /HTTPS/],
    [{ hostsText: "a.example.org", directory: "https://ca.example", challenge: "https://r.example", zone: "z.example", eabKid: "K", eabHmac: "H" }, /custody-v2/],
    [{ hostsText: Array.from({ length: 11 }, (_, i) => "h" + i + ".example.org").join("\n") }, /1 to 10/]])
    assert.throws(() => SP.namesFromForm(input, "public"), re, JSON.stringify(input));
  const withEab = SP.namesFromForm({ hostsText: "a.example.org", directory: "https://ca.example", challenge: "https://r.example", zone: "z.example", eabKid: "K", eabHmac: "H" }, "custody-v2");
  assert.equal(JSON.stringify(withEab), '{"hosts":["a.example.org"],"acme":{"directory":"https://ca.example","challenge":"https://r.example","zone":"z.example","eab":{"kid":"K","hmac":"H"}}}');
  assert.throws(() => SP.namesFromForm({ hostsText: "a.example.org", directory: "https://ca.example", challenge: "https://r.example", zone: "z.example", eabKid: "K" }, "custody-v2"), "EAB needs both names");
});
