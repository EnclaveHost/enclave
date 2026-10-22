// End-to-end: the real ipns-publisher wasm component (wasmtime) reading a real ReleaseAnchor (anvil, deployed from
// out/) through JSON-RPC fault proxies, publishing to a real kubo (offline) whose gateway serves the site. The
// "Enclave" origins are unreachable throughout: one RPC endpoint that accepts and never answers, one delegate whose
// port is closed. Disposable keys only: a random IPNS seed per run, anvil's unlocked dev account as the owner, a
// fresh keystore as the delegate. Nothing leaves loopback.
//
//   node --test test/anchor-e2e.test.mjs      (needs: anvil, cast, ipfs, wasmtime; forge build; the release wasm)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, createWriteStream } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedRuntime, forbiddenOpcodes, keccakHex } from "../scripts/expected-codehash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// IPNS_PUBLISHER_WASM, else the workspace sibling (work/enclave-apps), else the repository layout's sibling checkout
// (<repo>/tools/ipns-release-anchor -> <repo>/../enclave-apps)
const WASM = process.env.IPNS_PUBLISHER_WASM ?? [join(ROOT, "../enclave-apps"), join(ROOT, "../../../enclave-apps")]
  .map((d) => join(d, "ipns-publisher/target/wasm32-wasip2/release/ipns-publisher.wasm")).find((f) => existsSync(f))
  ?? join(ROOT, "../enclave-apps/ipns-publisher/target/wasm32-wasip2/release/ipns-publisher.wasm");
const LOGS = join(ROOT, "logs/e2e");
const WORK = mkdtempSync(join(tmpdir(), "anchor-e2e-"));
const CWASM = join(WORK, "ipns-publisher.cwasm"); // compiled once, so each start does not run cranelift again
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil's unlocked dev account 0 (no key used here)
const SEED = randomBytes(32).toString("hex"); // throwaway IPNS key, never printed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
const ctx = {};

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function daemon(name, cmd, args, env = {}) {
  mkdirSync(LOGS, { recursive: true });
  const log = createWriteStream(join(LOGS, `${name}.log`), { flags: "a" });
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.pipe(log);
  p.stderr.pipe(log);
  procs.add(p);
  p.on("exit", () => procs.delete(p));
  return p;
}

async function waitFor(label, fn, timeoutMs = 30_000, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// ---- JSON-RPC fault proxies --------------------------------------------------------------------------------------

function makeProxy(name, upstream) {
  const p = { name, mode: "ok", replay: null, frozenHead: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (p.mode === "down") return req.socket.destroy();
    const body = JSON.parse(Buffer.concat(chunks));
    const reply = (obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }).end(s);
    };
    if (p.mode === "replay") {
      // a previously valid, internally consistent chain view, answered verbatim (only the id is the new one)
      const r = p.replay?.[body.method];
      return r === undefined ? req.socket.destroy() : reply({ jsonrpc: "2.0", id: body.id, result: r });
    }
    if (p.mode === "stale-head" && body.method === "eth_blockNumber") {
      // withhold every block after an old head; everything else is answered honestly (old blocks stay canonical)
      return reply({ jsonrpc: "2.0", id: body.id, result: "0x" + p.frozenHead.toString(16) });
    }
    const up = await (await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (p.mode === "lie" && body.method === "eth_call" && typeof up.result === "string") {
      // claim a much higher seq: a well-formed but false anchor state
      const w = 2 + 2 * 64;
      const seq = BigInt("0x" + up.result.slice(w, w + 64)) + 100n;
      up.result = up.result.slice(0, w) + seq.toString(16).padStart(64, "0") + up.result.slice(w + 64);
    }
    reply(up);
  });
  return new Promise((resolve) => p.server.listen(0, "127.0.0.1", () => resolve(Object.assign(p, { url: `http://127.0.0.1:${p.server.address().port}/` }))));
}

// ---- the publisher -----------------------------------------------------------------------------------------------

let pubCount = 0;
async function startPublisher({ anchor, value, dataDir, sequenceOffset = 10 }) {
  const port = await freePort();
  const cfg = {
    ipnsKey: SEED,
    lifetimeSecs: 3600,
    republishSecs: 60,
    ttlSecs: 1, // kubo's name cache follows the record TTL; keep it short so the gateway follows each release
    dht: false,
    // the Enclave delegate origin is down (closed port); kubo is the public storage / routing that stays up
    delegates: [ctx.enclaveOrigin, ctx.kuboGw],
  };
  if (value !== undefined) cfg.value = value;
  if (anchor) {
    cfg.releaseAnchor = {
      chainId: 31337, contract: ctx.contract, codeHash: ctx.codeHash,
      // three independent providers plus the Enclave-run endpoint, which hangs
      rpcs: [...ctx.proxies.map((p) => p.url), ctx.enclaveRpc],
      quorum: 2, confirmations: 2, maxBlockAgeSecs: 10, authorityTtlSecs: 40, pollSecs: 10,
      sequenceOffset, rpcTimeoutSecs: 2,
    };
  }
  const args = ["run", "-Scli", "-Stcp", "-Sinherit-network", "-Sallow-ip-name-lookup",
    "--env", `ENCLAVE_PORTS=http:8000=${port}`, "--env", `IPNSPUB_CONFIG=${JSON.stringify(cfg)}`];
  if (dataDir) args.push("--dir", `${dataDir}::/data`);
  args.push("--allow-precompiled", CWASM);
  const n = ++pubCount;
  const proc = daemon(`publisher-${n}`, "wasmtime", args);
  const base = `http://127.0.0.1:${port}`;
  const pub = {
    n, base, proc,
    status: async () => (await fetch(`${base}/api/status`)).json(),
    publish: async () => (await fetch(`${base}/publish`, { method: "POST" })).status,
    record: async () => fetch(`${base}/routing/v1/ipns/${ctx.name}`),
    stop: async () => {
      proc.kill("SIGKILL");
      await waitFor(`publisher ${n} exit`, () => proc.exitCode !== null || proc.signalCode !== null, 5000);
    },
    log: () => readFileSync(join(LOGS, `publisher-${n}.log`), "utf8"),
  };
  await waitFor(`publisher ${n} up`, async () => (await fetch(`${base}/healthz`)).ok, 20_000);
  return pub;
}

/** Wait until the publisher has decided at least `n` more anchor rounds than `from`. */
async function rounds(pub, from, n = 1, timeoutMs = 30_000) {
  return waitFor(`publisher ${pub.n}: ${n} more anchor rounds`, async () => {
    const s = await pub.status();
    return s.anchor.roundsOk + s.anchor.roundsFailed >= from + n && s.queuedTasks === 0 ? s : null;
  }, timeoutMs);
}
const decided = (s) => s.anchor.roundsOk + s.anchor.roundsFailed;

// ---- kubo: the record the network sees, and the site it resolves to -----------------------------------------------

async function kuboRecord() {
  const r = await fetch(`${ctx.kuboGw}/routing/v1/ipns/${ctx.name}`, { headers: { accept: "application/vnd.ipfs.ipns-record" } });
  if (r.status !== 200) return null;
  const bytes = Buffer.from(await r.arrayBuffer());
  const out = JSON.parse(sh("ipfs", ["--api", ctx.kuboApi, "name", "inspect", "--enc=json", "--dump=false", "--verify", ctx.name], { input: bytes, stdio: ["pipe", "pipe", "pipe"] }));
  assert.equal(out.Validation?.Valid, true, "kubo verifies the record signature");
  const e = out.Entry;
  return { seq: Number(e.Sequence), value: e.Value, validity: Date.parse(e.Validity) / 1000, ttlNs: Number(e.TTL) };
}

/** What the public gateway serves for the name (waits out its name cache for the expected release). */
async function site(expected) {
  let got;
  await waitFor(`gateway serves ${expected}`, async () => {
    const r = await fetch(`${ctx.kuboGw}/ipns/${ctx.name}/index.html`);
    got = r.status === 200 ? (await r.text()).trim() : `HTTP ${r.status}`;
    return got === expected;
  }, 15_000, 500).catch(() => {});
  return got;
}

function delegatePublish(cid, extra = []) {
  try {
    return { code: 0, out: JSON.parse(sh("node", [join(ROOT, "scripts/anchor-release.mjs"), "publish", "--rpc", ctx.anvil, "--contract", ctx.contract,
      "--cid", cid, "--keystore", ctx.keystore, "--password-file", ctx.passwordFile, "--gateway", ctx.kuboGw, ...extra])) };
  } catch (e) {
    return { code: e.status, out: e.stdout ? JSON.parse(e.stdout) : null, err: String(e.stderr) };
  }
}

function owner(sig, ...a) {
  return JSON.parse(sh("cast", ["send", "--json", "--unlocked", "--from", OWNER, "--rpc-url", ctx.anvil, ctx.contract, sig, ...a]));
}

// ---- setup -------------------------------------------------------------------------------------------------------

before(async () => {
  assert.ok(existsSync(WASM), `build the component first: ${WASM}`);
  rmSync(LOGS, { recursive: true, force: true });
  sh("wasmtime", ["compile", WASM, "-o", CWASM]);
  // chain
  const anvilPort = await freePort();
  ctx.anvil = `http://127.0.0.1:${anvilPort}`;
  daemon("anvil", "anvil", ["--port", String(anvilPort), "--block-time", "1"]);
  await waitFor("anvil", () => rpc(ctx.anvil, "eth_chainId"));
  // storage: an offline kubo, its gateway doubling as the delegated-routing endpoint
  const ipfsPath = join(WORK, "kubo");
  const env = { ...process.env, IPFS_PATH: ipfsPath };
  sh("ipfs", ["init", "--profile=test"], { env });
  const [api, gw] = [await freePort(), await freePort()];
  sh("ipfs", ["config", "Addresses.API", `/ip4/127.0.0.1/tcp/${api}`], { env });
  sh("ipfs", ["config", "Addresses.Gateway", `/ip4/127.0.0.1/tcp/${gw}`], { env });
  sh("ipfs", ["config", "--json", "Addresses.Swarm", "[]"], { env });
  daemon("kubo", "ipfs", ["daemon", "--offline"], { IPFS_PATH: ipfsPath });
  ctx.kuboApi = `/ip4/127.0.0.1/tcp/${api}`;
  ctx.kuboGw = `http://127.0.0.1:${gw}`;
  await waitFor("kubo", () => sh("ipfs", ["--api", ctx.kuboApi, "id"]).length > 0, 30_000, 500);
  // three site releases
  ctx.cid = {};
  for (const r of ["A", "B", "C", "D"]) {
    const dir = join(WORK, `site-${r}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), `release ${r}\n`);
    ctx.cid[r] = sh("ipfs", ["--api", ctx.kuboApi, "add", "-r", "-Q", "--cid-version=1", dir]);
  }
  ctx.notStored = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"; // well-formed, never added
  // the name and its anchor nameHash, from the component itself
  const id = sh("wasmtime", ["run", "--allow-precompiled", CWASM, "id", SEED]);
  ctx.name = id.match(/ipns-name: (\S+)/)[1];
  ctx.nameHash = id.match(/anchor-name-hash: (0x[0-9a-f]{64})/)[1];
  // deploy the reviewed build
  const art = JSON.parse(readFileSync(join(ROOT, "out/ReleaseAnchor.sol/ReleaseAnchor.json"), "utf8"));
  const ctor = sh("cast", ["abi-encode", "constructor(address,bytes32,string)", OWNER, ctx.nameHash, ctx.cid.A]).slice(2);
  const rc = JSON.parse(sh("cast", ["send", "--json", "--unlocked", "--from", OWNER, "--rpc-url", ctx.anvil, "--create", art.bytecode.object + ctor]));
  assert.equal(rc.status, "0x1");
  ctx.contract = rc.contractAddress;
  // the delegate: a fresh keystore (its key never on a command line), funded for gas, appointed for 30 days
  const ks = join(WORK, "keystore");
  mkdirSync(ks);
  ctx.passwordFile = join(WORK, "pw");
  const pw = randomBytes(16).toString("hex"); // disposable; `cast wallet new` takes it only as an argument
  writeFileSync(ctx.passwordFile, pw);
  const w = JSON.parse(sh("cast", ["wallet", "new", ks, "--unsafe-password", pw, "--json"]))[0];
  ctx.keystore = w.path;
  ctx.delegate = w.address;
  sh("cast", ["send", "--unlocked", "--from", OWNER, "--rpc-url", ctx.anvil, ctx.delegate, "--value", "1ether"]);
  const now = Number(BigInt((await rpc(ctx.anvil, "eth_getBlockByNumber", ["latest", false])).timestamp));
  assert.equal(owner("setDelegate(address,uint64)", ctx.delegate, String(now + 30 * 86400)).status, "0x1");
  // the unreachable Enclave origins: an RPC that accepts and never answers, a delegate on a closed port
  ctx.hang = net.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((r) => ctx.hang.once("listening", r));
  ctx.enclaveRpc = `http://127.0.0.1:${ctx.hang.address().port}/`;
  ctx.enclaveOrigin = `http://127.0.0.1:${await freePort()}`;
  ctx.proxies = [await makeProxy("p1", ctx.anvil), await makeProxy("p2", ctx.anvil), await makeProxy("p3", ctx.anvil)];
});

after(async () => {
  for (const p of procs) p.kill("SIGKILL");
  ctx.proxies?.forEach((p) => p.server.close());
  ctx.hang?.close();
  await sleep(300);
  rmSync(WORK, { recursive: true, force: true });
});

// ---- tests -------------------------------------------------------------------------------------------------------

test("the deployed runtime is the reviewed build with nameHash filled in; no call, create or selfdestruct", () => {
  const onchain = sh("cast", ["code", "--rpc-url", ctx.anvil, ctx.contract]);
  const exp = expectedRuntime(ctx.nameHash);
  assert.equal(onchain, "0x" + exp.runtime.toString("hex"));
  ctx.codeHash = keccakHex(exp.runtime);
  assert.equal(ctx.codeHash, sh("cast", ["keccak", onchain]));
  assert.deepEqual(forbiddenOpcodes(exp.runtime), []);
  const st = sh("cast", ["call", "--rpc-url", ctx.anvil, ctx.contract, "state()(bytes32,bytes32,uint64,string,address,address,uint64,bool,address)"]).split("\n");
  assert.equal(st[0], sh("cast", ["keccak", "enclave.ipns-release-anchor.v1"]), "schema");
  assert.equal(st[1], ctx.nameHash);
  assert.equal(st[2], "1");
  assert.equal(JSON.parse(st[3]), ctx.cid.A);
});

test("legacy fixed value is unchanged; config conflicts and a too-low sequenceOffset publish nothing", async () => {
  ctx.data = join(WORK, "data-1");
  mkdirSync(ctx.data);
  // legacy: value B at seq 0, then value C at seq 1 (recovered + 1), exactly as before
  let p = await startPublisher({ value: `/ipfs/${ctx.cid.B}`, dataDir: ctx.data });
  await waitFor("legacy seq 0 at kubo", async () => (await kuboRecord())?.seq === 0);
  assert.equal((await p.status()).authorityMode, "fixed-value");
  await p.stop();
  p = await startPublisher({ value: `/ipfs/${ctx.cid.C}`, dataDir: ctx.data });
  await waitFor("legacy seq 1 at kubo", async () => (await kuboRecord())?.seq === 1);
  assert.equal(await site("release C"), "release C");
  await p.stop();
  // both value and releaseAnchor: a config error, never a fallback to either
  p = await startPublisher({ value: `/ipfs/${ctx.cid.D}`, anchor: true, dataDir: ctx.data });
  await sleep(3000);
  let s = await p.status();
  assert.match(s.configError, /either `value` or `releaseAnchor`/);
  assert.equal(s.publishedAt, 0);
  assert.equal((await p.record()).status, 503);
  assert.equal(await p.publish(), 503);
  await p.stop();
  // anchor seq 1 + offset 0 = 1, but sequence 1 already carries value C: refused (cutover rule)
  p = await startPublisher({ anchor: true, dataDir: ctx.data, sequenceOffset: 0 });
  s = await rounds(p, 0);
  assert.equal(s.anchor.roundsOk, 1, JSON.stringify(s.anchor));
  await waitFor("cutover refusal", async () => /already carries a different value/.test((await p.status()).lastError ?? ""));
  assert.equal((await kuboRecord()).seq, 1);
  await p.stop();
  // offset 10: sequence 11 for the anchor's release A
  ctx.main = await startPublisher({ anchor: true, dataDir: ctx.data });
  await waitFor("anchor seq 11 at kubo", async () => (await kuboRecord())?.seq === 11);
  assert.equal(await site("release A"), "release A");
  s = await ctx.main.status();
  assert.equal(s.authorityMode, "release-anchor");
  assert.equal(s.anchor.authority.seq, 1);
  assert.equal(s.anchor.authority.agreeing, 3);
  assert.ok(s.validUntil <= s.anchor.authority.until, "EOL capped by the authority");
});

test("a delegate release is picked up unattended while the Enclave origins are unavailable", async () => {
  // the availability gate: a CID that no gateway holds is not published
  const miss = delegatePublish(ctx.notStored);
  assert.equal(miss.code, 3, miss.err);
  assert.equal(miss.out.published, false);
  const r = delegatePublish(ctx.cid.B);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.seq, 2);
  // no POST /publish: the poll alone picks it up
  await waitFor("unattended pickup: seq 12", async () => (await kuboRecord())?.seq === 12, 40_000, 500);
  assert.equal(await site("release B"), "release B");
  const s = await ctx.main.status();
  const ep = Object.fromEntries(s.anchor.endpoints.map((e) => [e.id, e.outcome]));
  const enclaveRpcId = new URL(ctx.enclaveRpc).host;
  assert.match(ep[enclaveRpcId], /timeout|deadline/, "the Enclave RPC hung and was bounded");
  assert.equal(s.anchor.endpoints.filter((e) => e.outcome === "ok").length, 3);
  const d = Object.fromEntries(s.delegates.map((x) => [x.url, x.outcome]));
  assert.notEqual(d[ctx.enclaveOrigin], "ok", "the Enclave delegate origin is down");
  assert.equal(d[ctx.kuboGw], "ok");
  // capture exactly what an honest endpoint answers now (anchor seq 2, release B): soon an outdated view
  const head = Number(BigInt(await rpc(ctx.anvil, "eth_blockNumber")));
  const block = await rpc(ctx.anvil, "eth_getBlockByNumber", ["0x" + (head - 2).toString(16), false]);
  const at = { blockHash: block.hash, requireCanonical: true };
  ctx.captured = {
    eth_chainId: await rpc(ctx.anvil, "eth_chainId"),
    eth_blockNumber: "0x" + head.toString(16),
    eth_getBlockByNumber: block,
    eth_getCode: await rpc(ctx.anvil, "eth_getCode", [ctx.contract, at]),
    eth_call: await rpc(ctx.anvil, "eth_call", [{ to: ctx.contract, data: "0xc19d93fb" }, at]),
  };
  ctx.capturedHead = head;
  assert.equal(JSON.parse(sh("node", [join(ROOT, "scripts/anchor-release.mjs"), "state", "--rpc", ctx.anvil, "--contract", ctx.contract])).seq, 2);
});

test("one lying endpoint is outvoted; a liar plus a down endpoint cannot move the name", async () => {
  ctx.proxies[1].mode = "lie";
  const r = delegatePublish(ctx.cid.C);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.seq, 3);
  await waitFor("seq 13 despite the liar", async () => (await kuboRecord())?.seq === 13, 40_000, 500);
  let s = await ctx.main.status();
  assert.equal(s.anchor.endpoints[1].outcome, "returned a different anchor state");
  assert.equal(await site("release C"), "release C");
  // honest p1 alone (p2 lies, p3 down, the Enclave RPC hangs): no quorum, the owner's pin is not yet observed
  ctx.proxies[2].mode = "down";
  assert.equal(owner("pin(string)", ctx.cid.A).status, "0x1"); // anchor seq 4
  const from = decided(await ctx.main.status());
  assert.equal(await ctx.main.publish(), 202);
  s = await rounds(ctx.main, from);
  assert.match(s.anchor.lastError, /no 2 endpoints returned the same anchor state/);
  assert.equal(s.anchor.authority.seq, 3, "the authority is the last quorum read, not the liar's");
  assert.equal((await kuboRecord()).seq, 13);
  ctx.proxies[1].mode = "ok";
  ctx.proxies[2].mode = "ok";
  assert.equal(await ctx.main.publish(), 202);
  await waitFor("the owner's pin at seq 14", async () => (await kuboRecord())?.seq === 14, 30_000);
  assert.equal(await site("release A"), "release A");
  // the pin also revoked the delegate: its next release reverts with NotAuthorized() until re-appointed
  const refused = delegatePublish(ctx.cid.B);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /0xea8e4eb5/);
  const now = Number(BigInt((await rpc(ctx.anvil, "eth_getBlockByNumber", ["latest", false])).timestamp));
  assert.equal(owner("setDelegate(address,uint64)", ctx.delegate, String(now + 30 * 86400)).status, "0x1");
});

test("partition: cached authority signs only until block time + authorityTtlSecs, then signing stops", async () => {
  ctx.proxies.forEach((p) => (p.mode = "down"));
  let s = await ctx.main.status();
  const until = s.anchor.authority.until;
  assert.equal(until, s.anchor.authority.blockTimestamp + 40);
  const rec = await kuboRecord();
  assert.ok(rec.validity <= until, `record EOL ${rec.validity} <= authority bound ${until}`);
  assert.ok(rec.ttlNs <= 40e9);
  // keep asking; every round fails; once the bound is near, the due re-sign is refused
  await waitFor("signing stops", async () => {
    await ctx.main.publish();
    return /authority expired/.test((await ctx.main.status()).lastError ?? "");
  }, 70_000, 2000);
  s = await ctx.main.status();
  assert.ok(Date.now() / 1000 + 10 >= until, "refused only at the bound");
  assert.ok(s.validUntil <= until, "no record outlives the authority");
  assert.ok(s.anchor.roundsFailed >= 2);
  assert.equal((await kuboRecord()).seq, 14);
  // heal: a fresh quorum read re-signs the same release at the same sequence with a new bound
  ctx.proxies.forEach((p) => (p.mode = "ok"));
  assert.equal(await ctx.main.publish(), 202);
  await waitFor("re-signed after healing", async () => {
    const t = await ctx.main.status();
    return t.lastError === null && t.validUntil > until && t.sequence === 14;
  }, 30_000);
  await ctx.main.stop();
});

test("cold restart without /data: no quorum, replayed old responses or withheld blocks sign nothing", async () => {
  // all three providers down: nothing to sign from
  ctx.proxies.forEach((p) => (p.mode = "down"));
  const cold = await startPublisher({ anchor: true });
  let s = await rounds(cold, 0);
  assert.equal(s.durableState, false);
  assert.match(s.anchor.lastError, /only 0 of the required 2 endpoints/);
  // p1 and p2 replay, verbatim, the complete once-valid answers captured at anchor seq 2 (release B)
  ctx.proxies[0].mode = ctx.proxies[1].mode = "replay";
  ctx.proxies[0].replay = ctx.proxies[1].replay = ctx.captured;
  await cold.publish();
  s = await rounds(cold, decided(s));
  assert.match(s.anchor.lastError, /^stale: block \d+ is \d+s old at the end of the round/);
  // p1 and p2 withhold every block after that old head but answer everything else honestly
  ctx.proxies[0].mode = ctx.proxies[1].mode = "stale-head";
  ctx.proxies[0].frozenHead = ctx.proxies[1].frozenHead = ctx.capturedHead;
  await cold.publish();
  s = await rounds(cold, decided(s));
  assert.match(s.anchor.lastError, /^stale: block \d+ is \d+s old at the end of the round/);
  assert.equal(s.anchor.roundsOk, 0);
  assert.equal(s.anchor.authority, null);
  assert.equal(s.publishedAt, 0);
  assert.equal((await cold.record()).status, 503, "nothing signed");
  assert.equal((await kuboRecord()).seq, 14, "the network still has the pin");
  // with the quorum back, the cold publisher learns everything from the chain
  ctx.proxies.forEach((p) => (p.mode = "ok"));
  assert.equal(await cold.publish(), 202);
  await waitFor("cold publisher signs seq 14", async () => {
    const t = await cold.status();
    return t.publishedAt > 0 && t.sequence === 14 ? t : null;
  }, 30_000);
  assert.equal(await site("release A"), "release A");
  await cold.stop();
});

test("a chain rollback below the high-water is refused, and the refusal survives a restart", async () => {
  const snap = await rpc(ctx.anvil, "evm_snapshot");
  let p = await startPublisher({ anchor: true, dataDir: ctx.data });
  const r = delegatePublish(ctx.cid.D);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.seq, 5);
  await waitFor("seq 15", async () => (await kuboRecord())?.seq === 15, 40_000, 500);
  const hw = (await p.status()).anchor.highWater;
  assert.equal(hw.seq, 5);
  // the chain (as every endpoint now sees it) loses the last blocks: anchor seq back to 4, head below the mark
  assert.equal(await rpc(ctx.anvil, "evm_revert", [snap]), true);
  let from = decided(await p.status());
  await p.publish();
  let s = await rounds(p, from);
  assert.match(s.anchor.lastError, /regression: the quorum's confirmed block \d+ is below the accepted high-water/);
  // anvil's revert also rewinds its clock, so the reverted chain is stale too (refused for that alone); give it
  // current timestamps, as a real reorg would have, so that the next check is the high-water itself
  await rpc(ctx.anvil, "evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
  // once the head passes the mark, the lower seq itself is refused
  await waitFor("head past the high-water", async () => Number(BigInt(await rpc(ctx.anvil, "eth_blockNumber"))) - 2 > hw.block, 60_000, 500);
  from = decided(await p.status());
  await p.publish();
  s = await rounds(p, from);
  assert.match(s.anchor.lastError, /regression: anchor seq 4 is below the accepted high-water 5/);
  assert.equal((await kuboRecord()).seq, 15);
  await p.stop();
  // a restart with the same /data keeps the high-water
  p = await startPublisher({ anchor: true, dataDir: ctx.data });
  s = await rounds(p, 0);
  assert.match(s.anchor.lastError, /seq 4 is below the accepted high-water 5/);
  await p.stop();
  // a cold restart has no high-water, but the network's record (seq 15) is above the anchor's mapped 14
  p = await startPublisher({ anchor: true });
  s = await rounds(p, 0);
  assert.equal(s.anchor.authority.seq, 4);
  await waitFor("refused below the recovered sequence", async () => /exists above the anchor's 14/.test((await p.status()).lastError ?? ""), 20_000);
  assert.equal((await p.status()).publishedAt, 0);
  assert.equal((await kuboRecord()).seq, 15);
  assert.equal(await site("release D"), "release D");
  await p.stop();
});
