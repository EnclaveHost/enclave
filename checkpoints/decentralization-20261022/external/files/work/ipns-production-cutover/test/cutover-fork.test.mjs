// The cutover tool against an anvil FORK of Base at a fresh agreed block: the real ledger, catalog, CREATE2 deployer,
// production deployment record (owner, appRef, envelope) and owner nonce/balance. Every write is local: the owner is
// impersonated on the fork (no key), the delegate is a fresh keystore, the IPNS key is a throwaway seed standing in
// for the production one (the name differs; the record, config and old-code behaviour are the production shape).
// The OLD publisher is the production 1.0.5 component itself (fetched by catalog CID, verified), on the OLD config (legacy
// `value` = a loopback site-root); the NEW one is the reviewed component on the plan's config (releaseAnchor); only loopback
// substitutions (rpcs, delegates, no DHT/IPNI).
//
//   node --test test/cutover-fork.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, createWriteStream } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Quorum, viem } from "../lib/chain.mjs";
import { plan, status, rollback } from "../cutover/cutover.mjs";
import { ANCHOR_ABI } from "../lib/anchor-build.mjs";
import { ANCHOR, PUBLISHER_WASM, REPO, TOOL } from "../lib/paths.mjs";

const ROOT = TOOL;
const WASM = PUBLISHER_WASM;
const ANCHOR_TOOL = join(ANCHOR, "scripts/anchor-release.mjs");
const LOGS = join(ROOT, "logs/fork");
const WORK = mkdtempSync(join(tmpdir(), "cutover-fork-"));
const CWASM = join(WORK, "p.cwasm");
// the OLD code is the production component itself: ipns-publisher 1.0.5, fetched by its catalog CID and verified
const OLD_CWASM = join(WORK, "old-1.0.5.cwasm");
const OLD_GATEWAY = process.env.OLD_COMPONENT_GATEWAY ?? "https://ipfs.enclave.host";
const PROD = JSON.parse(readFileSync(join(ROOT, "cutover/production-cutover.json"), "utf8"));
const OWNER = PROD.owner;
const SEED = randomBytes(32).toString("hex");
const API_KEY = randomBytes(16).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
const ctx = { gas: {} };

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
function daemon(name, cmd, args, env = {}) {
  mkdirSync(LOGS, { recursive: true });
  const log = createWriteStream(join(LOGS, `${name}.log`), { flags: "a" });
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.pipe(log); p.stderr.pipe(log);
  procs.add(p); p.on("exit", () => procs.delete(p));
  return p;
}
async function waitFor(label, fn, ms = 30_000, every = 300) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(every); }
  throw new Error(`timed out: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})`);
}
async function rpc(method, params = []) {
  const r = await (await fetch(ctx.fork, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
/** Send an unsigned plan transaction as the impersonated owner; returns the receipt (or null when `lose` is set). */
async function sendAsOwner(u, { lose = false } = {}) {
  const hash = await rpc("eth_sendTransaction", [{ from: u.from, to: u.to, data: u.data, value: u.value, gas: u.gas, nonce: u.nonce,
    maxFeePerGas: u.maxFeePerGas, maxPriorityFeePerGas: u.maxPriorityFeePerGas, type: "0x2" }]);
  if (lose) return { hash };
  const r = await waitFor(`receipt ${hash}`, () => rpc("eth_getTransactionReceipt", [hash]), 20_000);
  await confirmed(r);
  return r;
}
/** Status reads at (quorum-th head - 6 confirmations): wait until a receipt's block is that deep. */
async function confirmed(receipt) {
  const n = Number(BigInt(receipt.blockNumber));
  await waitFor(`6 confirmations of block ${n}`, async () => Number(BigInt(await rpc("eth_blockNumber"))) >= n + 7, 30_000, 500);
}
const gasOf = (r) => Number(BigInt(r.gasUsed));

function makeProxy(upstream) {
  const p = { mode: "ok" };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (p.mode === "down") return req.socket.destroy();
    const up = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
    const text = await up.text();
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
  });
  return new Promise((r) => p.server.listen(0, "127.0.0.1", () => r(Object.assign(p, { url: `http://127.0.0.1:${p.server.address().port}` }))));
}

// the old code's mutable `value` source (production: https://ipfs.enclave.host/site-root)
function siteRoot() {
  const s = { value: "" };
  s.server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(s.value + "\n"));
  return new Promise((r) => s.server.listen(0, "127.0.0.1", () => r(Object.assign(s, { url: `http://127.0.0.1:${s.server.address().port}/site-root` }))));
}
// a second gateway that holds the release only once "mirrored"
// `partial`: the gateway holds the valid root block (a ?format=raw request is served faithfully) but MISSES a child:
// its CAR export drops the last non-root block, as a half-finished mirror would
function dropLastBlock(car) {
  let i = 0;
  const varint = () => { let n = 0, mul = 1, b; do { b = car[i++]; n += (b & 127) * mul; mul *= 128; } while (b & 128); return n; };
  const hlen = varint(); i += hlen;
  const starts = [];
  while (i < car.length) { const at = i, len = varint(); starts.push([at, i + len]); i += len; }
  assert.ok(starts.length >= 2, "a CAR with children");
  const [at, end] = starts[starts.length - 1];
  return Buffer.concat([car.subarray(0, at), car.subarray(end)]);
}
function mirror(upstream) {
  const m = { has: new Set(), partial: new Set() };
  m.server = http.createServer(async (req, res) => {
    const cid = (req.url.match(/^\/ipfs\/([a-z0-9]+)/) ?? [])[1];
    if (!cid || !(m.has.has(cid) || m.partial.has(cid))) return res.writeHead(404).end("not mirrored");
    const up = await fetch(upstream + req.url, { headers: { accept: req.headers.accept ?? "*/*" } });
    let b = Buffer.from(await up.arrayBuffer());
    if (!m.has.has(cid) && /format=car/.test(req.url)) b = dropLastBlock(b);
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" }).end(b);
  });
  return new Promise((r) => m.server.listen(0, "127.0.0.1", () => r(Object.assign(m, { url: `http://127.0.0.1:${m.server.address().port}` }))));
}

/** The real component: `config` is the ENCLAVE_CONFIG object; `$IPNS_ED25519_SK`/`$API_KEY` resolve from env. */
async function publisher(name, config, { port, dataDir, old = false }) {
  port ??= await freePort();
  const args = ["run", "-Scli", "-Stcp", "-Sinherit-network", "-Sallow-ip-name-lookup", "--env", `ENCLAVE_PORTS=http:8000=${port}`,
    "--env", `IPNSPUB_CONFIG=${JSON.stringify(config)}`, "--env", `IPNS_ED25519_SK=${SEED}`, "--env", `API_KEY=${API_KEY}`];
  if (dataDir) args.push("--dir", `${dataDir}::/data`);
  args.push("--allow-precompiled", old ? OLD_CWASM : CWASM);
  const proc = daemon(name, "wasmtime", args);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${name} up`, async () => (await fetch(`${base}/healthz`)).ok, 20_000);
  return { port, base, proc, status: async () => (await fetch(`${base}/api/status`)).json(),
    publish: async () => (await fetch(`${base}/publish`, { method: "POST", headers: { "x-api-key": API_KEY } })).status,
    stop: async () => { proc.kill("SIGKILL"); await waitFor(`${name} exit`, () => proc.exitCode !== null || proc.signalCode !== null, 5000); } };
}
// what the network sees: the record kubo (the delegated-routing stand-in) holds
async function kuboRecord() {
  const r = await fetch(`${ctx.kuboGw}/routing/v1/ipns/${ctx.name}`, { headers: { accept: "application/vnd.ipfs.ipns-record" } });
  if (r.status !== 200) return null;
  const j = JSON.parse(sh("ipfs", ["--api", ctx.kuboApi, "name", "inspect", "--enc=json", "--dump=false", "--verify", ctx.name], { input: Buffer.from(await r.arrayBuffer()), stdio: ["pipe", "pipe", "pipe"] }));
  assert.equal(j.Validation.Valid, true);
  return { seq: Number(j.Entry.Sequence), value: j.Entry.Value };
}
// asynchronous on purpose: the mirror gateway lives in this process, so a synchronous child would deadlock it
function delegatePublish(cid) {
  return new Promise((resolve) => execFile("node", [ANCHOR_TOOL, "publish", "--rpc", ctx.fork, "--contract", ctx.plan.anchor.address, "--cid", cid,
    "--keystore", ctx.keystore, "--password-file", ctx.passwordFile, "--gateway", ctx.kuboGw, "--gateway", ctx.mirror.url, "--min-gateways", "2"],
    { encoding: "utf8" }, (e, out, err) => {
      let parsed = null; try { parsed = JSON.parse(out); } catch {}
      resolve({ code: e ? e.code : 0, out: parsed, err });
    }));
}
async function ownerCast(sig, ...a) {
  const r = JSON.parse(sh("cast", ["send", "--json", "--unlocked", "--from", OWNER, "--rpc-url", ctx.fork, ctx.plan.anchor.address, sig, ...a]));
  await confirmed(r);
  return r;
}

// the plan's NEW config with only loopback substitutions; the OLD config likewise
function newPublisherConfig() {
  const c = structuredClone(ctx.plan.publisher.newConfig);
  c.releaseAnchor.rpcs = ctx.proxies.map((p) => p.url);
  c.releaseAnchor.pollSecs = 10;            // the minimum, so the test does not wait 120 s per release
  c.delegates = [ctx.kuboGw];
  c.dht = false;
  delete c.ipni;                             // no announcements to cid.contact from a test
  return c;
}
function oldPublisherConfig() {
  const c = JSON.parse(ctx.oldEnvelope).config;
  c.value = ctx.site.url;
  c.delegates = [ctx.kuboGw];
  c.dht = false;
  delete c.ipni;
  return c;
}

before(async () => {
  rmSync(LOGS, { recursive: true, force: true });
  execFileSync("wasmtime", ["compile", WASM, "-o", CWASM]);
  {
    const { artifactIdentity } = await import(join(REPO, "sdk/storage/unixfs.mjs"));
    const file = process.env.IPNS_PUBLISHER_OLD_WASM ?? join(WORK, "old-1.0.5.wasm");
    if (!process.env.IPNS_PUBLISHER_OLD_WASM) {
      const r = await fetch(`${OLD_GATEWAY}/ipfs/${PROD.expect.versionCid}`, { signal: AbortSignal.timeout(60_000) });
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    const cid = artifactIdentity(new Uint8Array(readFileSync(file))).cid;
    assert.equal(cid, PROD.expect.versionCid, "the old component is byte-for-byte the catalog's 1.0.5");
    ctx.oldWasmSha256 = execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0];
    execFileSync("wasmtime", ["compile", file, "-o", OLD_CWASM]);
  }
  // a fresh agreed block of Base (the owner-chosen profile), and a fork of it
  const q = new Quorum({ rpcs: PROD.rpcs, chainId: 8453, quorum: 2, confirmations: 6 });
  ctx.forkBlock = await q.block();
  q.close();
  const port = await freePort();
  ctx.fork = `http://127.0.0.1:${port}`;
  daemon("anvil-fork", "anvil", ["--fork-url", "https://mainnet.base.org", "--fork-block-number", String(ctx.forkBlock.number), "--port", String(port), "--block-time", "1"]);
  await waitFor("fork", () => rpc("eth_chainId"), 60_000, 500);
  const forkHash = (await rpc("eth_getBlockByNumber", ["0x" + ctx.forkBlock.number.toString(16), false])).hash;
  assert.equal(forkHash, ctx.forkBlock.hash, "the fork is at the agreed Base block");
  await rpc("anvil_impersonateAccount", [OWNER]);
  // the production envelope as the forked ledger holds it (env references only; the plan re-checks its commitment)
  {
    const { ABI } = await import("../lib/production.mjs");
    const raw = await rpc("eth_call", [{ to: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b", data: viem.encodeFunctionData({ abi: ABI.ledger, functionName: "get", args: [PROD.deployment] }) }, "latest"]);
    ctx.oldEnvelope = viem.decodeFunctionResult({ abi: ABI.ledger, functionName: "get", data: raw }).configCid;
  }
  ctx.proxies = [await makeProxy(ctx.fork), await makeProxy(ctx.fork), await makeProxy(ctx.fork)];
  // local kubo: delegated routing + gateway
  const env = { ...process.env, IPFS_PATH: join(WORK, "kubo") };
  sh("ipfs", ["init", "--profile=test"], { env });
  const [api, gw] = [await freePort(), await freePort()];
  sh("ipfs", ["config", "Addresses.API", `/ip4/127.0.0.1/tcp/${api}`], { env });
  sh("ipfs", ["config", "Addresses.Gateway", `/ip4/127.0.0.1/tcp/${gw}`], { env });
  sh("ipfs", ["config", "--json", "Addresses.Swarm", "[]"], { env });
  daemon("kubo", "ipfs", ["daemon", "--offline"], { IPFS_PATH: env.IPFS_PATH });
  ctx.kuboApi = `/ip4/127.0.0.1/tcp/${api}`;
  ctx.kuboGw = `http://127.0.0.1:${gw}`;
  await waitFor("kubo", () => sh("ipfs", ["--api", ctx.kuboApi, "id"]).length > 0, 30_000, 500);
  ctx.cid = {};
  for (const r of ["A", "B", "C", "D"]) {
    const dir = join(WORK, `site-${r}`); mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), `release ${r}\n`);
    ctx.cid[r] = sh("ipfs", ["--api", ctx.kuboApi, "add", "-r", "-Q", "--cid-version=1", dir]);
  }
  ctx.mirror = await mirror(ctx.kuboGw);
  ctx.site = await siteRoot();
  ctx.site.value = `/ipfs/${ctx.cid.A}`;
  ctx.name = sh("wasmtime", ["run", "--allow-precompiled", CWASM, "id", SEED]).match(/ipns-name: (\S+)/)[1];
  // the production sequence floor, reproduced: a record at 1026 for release A, as the network holds today
  const rec = execFileSync("wasmtime", ["run", "--allow-precompiled", CWASM, "mkrecord", SEED, `/ipfs/${ctx.cid.A}`, "+604800", "1026", "300000000000"]);
  ctx.oldRecord = rec;
  const put = await fetch(`${ctx.kuboGw}/routing/v1/ipns/${ctx.name}`, { method: "PUT", headers: { "content-type": "application/vnd.ipfs.ipns-record" }, body: rec });
  assert.equal(put.status, 200);
  // the CI delegate: a fresh keystore (its key never on a command line)
  mkdirSync(join(WORK, "ks"));
  const pw = randomBytes(16).toString("hex");
  ctx.passwordFile = join(WORK, "pw"); writeFileSync(ctx.passwordFile, pw);
  const w = JSON.parse(sh("cast", ["wallet", "new", join(WORK, "ks"), "--unsafe-password", pw, "--json"]))[0];
  ctx.keystore = w.path; ctx.delegate = w.address;
  ctx.data = join(WORK, "data"); mkdirSync(ctx.data);
});

after(async () => {
  for (const p of procs) p.kill("SIGKILL");
  ctx.proxies?.forEach((p) => p.server.close());
  ctx.mirror?.server.close(); ctx.site?.server.close();
  await sleep(300);
  rmSync(WORK, { recursive: true, force: true });
});

function cutoverConfig(extra = {}) {
  const c = structuredClone(PROD);
  Object.assign(c, { rpcs: ctx.proxies.map((p) => p.url), name: ctx.name, publisherUrl: ctx.old.base,
    recordSources: [ctx.old.base, ctx.kuboGw], gateways: [ctx.kuboGw, ctx.mirror.url], minGateways: 2 });
  c.anchor.initialCid = ctx.cid.A;
  c.release.wasm = WASM;
  c.publisher.rpcs = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"]; // the production value, kept
  Object.assign(c, extra);
  const file = join(WORK, `cutover-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(c, null, 2));
  return file;
}

test("the old publisher on the production config shape holds the production sequence floor", async () => {
  ctx.old = await publisher("old-1", oldPublisherConfig(), { dataDir: ctx.data, old: true });
  await waitFor("old publisher re-signs 1026", async () => { const s = await ctx.old.status(); return s.publishedAt > 0 && s.sequence === 1026; });
  assert.deepEqual(await kuboRecord(), { seq: 1026, value: `/ipfs/${ctx.cid.A}` });
});

test("plan: agreed reads of the forked production record; unavailable providers refuse", async () => {
  ctx.proxies[1].mode = ctx.proxies[2].mode = "down";
  await assert.rejects(plan({ config: cutoverConfig(), out: join(WORK, "plan-x"), delegate: ctx.delegate }), /only 1 of the required 2 endpoints/);
  ctx.proxies[2].mode = "ok"; // one provider down still reaches the quorum
  ctx.planDir = join(WORK, "plan");
  ctx.plan = await plan({ config: cutoverConfig(), out: ctx.planDir, delegate: ctx.delegate });
  ctx.proxies[1].mode = "ok";
  const pre = Object.fromEntries(ctx.plan.preconditions.map((x) => [x.check, x.ok]));
  assert.equal(pre[`deployment envelope commitment is ${PROD.expect.envelopeSha256}`], true);
  assert.equal(pre[`deployment runs ${PROD.expect.appRef}`], true);
  assert.equal(ctx.plan.ipns.maxObservedSequence, 1026);
  assert.equal(ctx.plan.publisher.mappedFirstSequence, 1_000_001);
  assert.equal(ctx.plan.preconditions.find((x) => x.blocking === "activation").ok, false, "release A is not mirrored yet");
  assert.equal(JSON.parse(ctx.plan.publisher.newEnvelope).config.value, undefined, "value removed");
  assert.deepEqual(Object.keys(JSON.parse(ctx.plan.publisher.newEnvelope)), Object.keys(JSON.parse(ctx.plan.publisher.oldEnvelope)), "other namespaces kept in order");
  // a moved precondition stops the plan
  const bad = JSON.parse(readFileSync(cutoverConfig(), "utf8")); bad.expect.envelopeSha256 = "00".repeat(32);
  const badFile = join(WORK, "bad.json"); writeFileSync(badFile, JSON.stringify(bad));
  await assert.rejects(plan({ config: badFile, out: join(WORK, "plan-y"), delegate: ctx.delegate }), /envelope commitment/);
});

test("deploy: a lost receipt and repeated runs re-derive the same state, never a second contract", async () => {
  const s1 = await status(join(ctx.planDir, "plan.json"), { recordSources: [ctx.old.base, ctx.kuboGw] });
  assert.equal(s1.next.step, "deploy-anchor");
  assert.equal(s1.cliPending[0].step, "publish-version");
  const again = await status(join(ctx.planDir, "plan.json"));
  assert.equal(again.next.unsigned.data, s1.next.unsigned.data, "a repeated status emits the identical transaction");
  assert.equal(again.next.unsigned.nonce, s1.next.unsigned.nonce);
  const lost = await sendAsOwner(s1.next.unsigned, { lose: true }); // the receipt is "lost"
  const mined = await waitFor("the deploy is mined", () => rpc("eth_getTransactionReceipt", [lost.hash]));
  ctx.gas.deployAnchor = gasOf(mined);
  // mined but not yet at the agreed depth: status emits NO transaction (its simulation at the latest block reverts,
  // and the latest block shows the anchor), and says to wait rather than re-sign
  const unconfirmed = await status(join(ctx.planDir, "plan.json"));
  assert.equal(unconfirmed.steps.find((s) => s.id === "deploy-anchor").state, "confirming");
  assert.equal(unconfirmed.next, null);
  await confirmed(mined);
  const s2 = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s2.steps.find((s) => s.id === "deploy-anchor").state, "done", "found by reading the CREATE2 address");
  assert.equal(s2.next.step, "set-delegate");
  assert.equal(Number(s2.next.unsigned.nonce), Number(s1.next.unsigned.nonce) + 1);
  // re-sending the lost transaction (fresh nonce) cannot create a second anchor: CREATE2 collides and reverts
  const replay = await sendAsOwner({ ...s1.next.unsigned, nonce: s2.next.unsigned.nonce });
  assert.equal(replay.status, "0x0");
  const code = await rpc("eth_getCode", [ctx.plan.anchor.address, "latest"]);
  assert.equal(viem.keccak256(code), ctx.plan.anchor.codeHash);
});

test("delegate: bounded appointment, funding, and an owner pin or revoke re-opens the step", async () => {
  let s = await status(join(ctx.planDir, "plan.json"));
  let r = await sendAsOwner(s.next.unsigned);
  ctx.gas.setDelegate = gasOf(r);
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "set-delegate").state, "done");
  assert.equal(s.next.step, "fund-delegate");
  r = await sendAsOwner(s.next.unsigned);
  ctx.gas.fund = gasOf(r);
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "fund-delegate").state, "done");
  // the owner's pin clears the delegate: the plan shows the appointment pending again, with the reason
  assert.equal((await ownerCast("pin(string)", ctx.cid.A)).status, "0x1");
  s = await status(join(ctx.planDir, "plan.json"));
  const sd = s.steps.find((x) => x.id === "set-delegate");
  assert.equal(sd.state, "pending");
  assert.match(sd.detail, /no delegate/);
  await sendAsOwner(s.next.unsigned);
  // an explicit revoke, likewise
  assert.equal((await ownerCast("setDelegate(address,uint64)", viem.zeroAddress, "0")).status, "0x1");
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "set-delegate").state, "pending");
  await sendAsOwner(s.next.unsigned);
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "set-delegate").state, "done");
});

test("activation: waits for the catalog version, refuses incomplete mirroring, then one multicall", async () => {
  let s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "activate").state, "waiting");
  // the CLI's catalog step, as the owner (the app's publisher): publishVersion with the 1.0.5 template's resources
  const t = ctx.plan.release.template;
  const cat = ctx.plan.pins.appCatalog.address;
  const pubAbi = viem.parseAbi(["function publishVersion(string slug, string name, string description, string version, string cid, uint32[4] res, string ports, string config, uint256 feePerSec6) returns (bytes32, uint256)"]);
  const data = viem.encodeFunctionData({ abi: pubAbi, functionName: "publishVersion", args: ["ipns-publisher", "IPNS publisher", "ipns-publisher", ctx.plan.release.version,
    ctx.plan.release.cid, [t.vramMb, t.gpuGflops, t.memMb, t.cpuGflops], t.ports, t.config, 0n] });
  const pr = await sendAsOwner({ from: OWNER, to: cat, data, value: "0x0", gas: "0x200000" });
  assert.equal(pr.status, "0x1", "the catalog accepts the owner's version");
  s = await status(join(ctx.planDir, "plan.json"));
  const pv = s.steps.find((x) => x.id === "publish-version");
  assert.equal(pv.state, "done", JSON.stringify(pv));
  assert.equal(pv.index, 6);
  const act = s.steps.find((x) => x.id === "activate");
  assert.equal(act.state, "blocked");
  assert.match(act.detail, /incomplete mirroring/);
  // a gateway with the valid ROOT block but a missing child is not a complete copy: still blocked
  ctx.mirror.partial.add(ctx.cid.A);
  const rawRoot = await fetch(`${ctx.mirror.url}/ipfs/${ctx.cid.A}?format=raw`, { headers: { accept: "application/vnd.ipld.raw" } });
  assert.equal(rawRoot.status, 200, "the partial mirror serves the root block");
  s = await status(join(ctx.planDir, "plan.json"));
  const partial = s.steps.find((x) => x.id === "activate");
  assert.equal(partial.state, "blocked", "a root block without its children does not count");
  assert.match(partial.detail, /complete DAG/);
  ctx.mirror.partial.delete(ctx.cid.A);
  ctx.mirror.has.add(ctx.cid.A);
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.next.step, "activate");
  const r = await sendAsOwner(s.next.unsigned);
  assert.equal(r.status, "0x1");
  ctx.gas.activate = gasOf(r);
  s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "activate").state, "done");
  // the ledger now holds exactly the plan's envelope
  const q = new Quorum({ rpcs: ctx.proxies.map((p) => p.url), chainId: 8453 });
  await q.block();
  const { ABI } = await import("../lib/production.mjs");
  const d = await q.read(ctx.plan.pins.deployments.address, ABI.ledger, "get", [PROD.deployment]);
  assert.equal(d.appRef, `catalog://${ctx.plan.production.appId}/6`);
  assert.equal(d.configCid, ctx.plan.publisher.newEnvelope);
});

test("verify: the restarted publisher follows the anchor at sequenceOffset + seq", async () => {
  // the host restarts the app in place (same deployment, endpoint and /data) on the new ENCLAVE_CONFIG
  await ctx.old.stop();
  ctx.pub = await publisher("new-1", newPublisherConfig(), { port: ctx.old.port, dataDir: ctx.data });
  const st = (await (async () => { const q = new Quorum({ rpcs: [ctx.fork, ctx.proxies[0].url], chainId: 8453 }); await q.block(); return q.read(ctx.plan.anchor.address, ANCHOR_ABI, "state"); })());
  const mapped = 1_000_000 + Number(st[2]); // seq 3 after the test's pin
  await waitFor("anchor-mapped record at kubo", async () => (await kuboRecord())?.seq === mapped, 40_000, 500);
  const s = await waitFor("status verify done", async () => { const x = await status(join(ctx.planDir, "plan.json")); return x.complete ? x : null; }, 30_000, 1000);
  assert.equal(s.steps.find((x) => x.id === "verify-publisher").state, "done");
  const ps = await ctx.pub.status();
  assert.equal(ps.authorityMode, "release-anchor");
  assert.equal(ps.anchor.authority.agreeing, 3);
  ctx.mapped = mapped;
});

test("an unattended release by the delegate needs both mirrors, then the publisher follows", async () => {
  let r = await delegatePublish(ctx.cid.B);
  assert.equal(r.code, 3, "release B is on one gateway only: refused");
  // the root block alone at the second gateway is refused too: the delegate tool verifies the whole CAR
  ctx.mirror.partial.add(ctx.cid.B);
  r = await delegatePublish(ctx.cid.B);
  assert.equal(r.code, 3, `a root-only copy admitted: ${JSON.stringify(r.out)}`);
  assert.equal(r.out.checks.find(([h]) => h === new URL(ctx.mirror.url).host)[1] === "ok", false);
  ctx.mirror.partial.delete(ctx.cid.B);
  ctx.mirror.has.add(ctx.cid.B);
  r = await delegatePublish(ctx.cid.B);
  assert.equal(r.code, 0, `${r.err} ${JSON.stringify(r.out)}`);
  ctx.gas.publishRelease = gasOf(await rpc("eth_getTransactionReceipt", [r.out.tx]));
  await waitFor("release B followed", async () => (await kuboRecord())?.seq === ctx.mapped + 1, 40_000, 500);
  assert.equal((await kuboRecord()).value, `/ipfs/${ctx.cid.B}`);
  const site = await waitFor("gateway serves B", async () => { const x = await fetch(`${ctx.kuboGw}/ipns/${ctx.name}/index.html`); return x.ok && (await x.text()).trim() === "release B"; }, 20_000, 500);
  assert.ok(site);
});

test("a duplicate old publisher of the same key outranks the anchor: detected, then recovered past", async () => {
  // a stale replay of the pre-cutover record changes nothing (lower sequence)
  await fetch(`${ctx.kuboGw}/routing/v1/ipns/${ctx.name}`, { method: "PUT", headers: { "content-type": "application/vnd.ipfs.ipns-record" }, body: ctx.oldRecord });
  assert.equal((await kuboRecord()).seq, ctx.mapped + 1);
  // the old code, still holding the key somewhere, recovers the anchor's record and signs max+1 with its own value
  const dup = await publisher("old-duplicate", oldPublisherConfig(), { old: true });
  await waitFor("the duplicate signs above the anchor", async () => (await kuboRecord())?.seq === ctx.mapped + 2, 30_000);
  assert.equal((await kuboRecord()).value, `/ipfs/${ctx.cid.A}`);
  const s = await status(join(ctx.planDir, "plan.json"));
  const v = s.steps.find((x) => x.id === "verify-publisher");
  assert.equal(v.state, "blocked");
  assert.match(v.detail, /ANOTHER HOLDER OF THE IPNS KEY/);
  // the anchor publisher refuses to sign below it
  assert.equal(await ctx.pub.publish(), 202);
  await waitFor("anchor publisher refuses", async () => /exists above/.test((await ctx.pub.status()).lastError ?? ""), 30_000);
  // recovery: stop the other holder, then releases past its sequence (C reaches equal: refused; D passes it)
  await dup.stop();
  ctx.mirror.has.add(ctx.cid.C); ctx.mirror.has.add(ctx.cid.D);
  assert.equal((await delegatePublish(ctx.cid.C)).code, 0);
  await ctx.pub.publish();
  await waitFor("equal sequence with another value refused", async () => /already carries a different value/.test((await ctx.pub.status()).lastError ?? ""), 30_000);
  assert.equal((await delegatePublish(ctx.cid.D)).code, 0);
  await waitFor("past the duplicate", async () => (await kuboRecord())?.seq === ctx.mapped + 3, 40_000, 500);
  assert.equal((await kuboRecord()).value, `/ipfs/${ctx.cid.D}`);
  const s2 = await waitFor("verify done again", async () => { const x = await status(join(ctx.planDir, "plan.json")); return x.complete ? x : null; }, 30_000, 1000);
  assert.ok(s2.complete);
});

test("rollback: one multicall restores the old record; the old code then outranks the anchor's records", async () => {
  const r = await rollback(join(ctx.planDir, "plan.json"));
  assert.equal(r.state, "pending");
  assert.equal((await sendAsOwner(r.next.unsigned)).status, "0x1");
  assert.equal((await rollback(join(ctx.planDir, "plan.json"))).state, "done", "a repeated rollback is a no-op");
  const s = await status(join(ctx.planDir, "plan.json"));
  assert.equal(s.steps.find((x) => x.id === "activate").state, "pending", "the cutover can be resumed from here");
  await ctx.pub.stop();
  ctx.site.value = `/ipfs/${ctx.cid.C}`;
  ctx.old = await publisher("old-after-rollback", oldPublisherConfig(), { port: ctx.pub.port, dataDir: ctx.data, old: true });
  await waitFor("old code back in charge", async () => (await kuboRecord())?.seq === ctx.mapped + 4, 30_000);
  assert.equal((await kuboRecord()).value, `/ipfs/${ctx.cid.C}`);
  // record the fork-measured gas for the production plan's estimates
  writeFileSync(join(ROOT, "snapshots/fork-gas.json"), JSON.stringify({ measuredAt: { forkBlock: ctx.forkBlock.number, forkHash: ctx.forkBlock.hash }, gas: ctx.gas,
    oldComponent: { cid: PROD.expect.versionCid, sha256: ctx.oldWasmSha256 } }, null, 2) + "\n");
  assert.ok(ctx.gas.deployAnchor > 0 && ctx.gas.activate > 0 && ctx.gas.publishRelease > 0);
});
