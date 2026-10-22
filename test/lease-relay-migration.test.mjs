// Moving an EXISTING funded lease relay key onto a Windows host as that host's OWN loopback relay: the migration guarantees,
// on CURRENT main (no activated-baseline hash, no old bundle). What runs here:
//   - the node agent's chain module windows/node/chain.mjs and its lease-gas runtime bundle, as they are in this tree (a
//     test-only transport adapter, helpers/windows-lease-runtime-fixture.mjs, wraps the REAL bundle: loopback RPCs, short
//     timeouts);
//   - every relay is the release artifact built from this tree (scripts/build-lease-relay-release.mjs), started as its run
//     loop starts it;
//   - the migration gate is the bundled check (scripts/build-lease-relay-migration-check.mjs) run as a separate process;
//   - the node's settings are the migration's lease-gas-config.cmd files, read by the config check with the real bundle.
// Proven: the moved key keeps its payee; its unresolved send (a broadcast lost in the mempool) travels with it and is
// re-broadcast as the SAME bytes before any new send; the gate refuses an absent journal, another key's record, a consumed
// nonce and a source that still serves the key; the host relays through its OWN relay first, falls back to the configured
// alternate, contacts nothing else and never spends operator ETH.
// Local anvil (chain 8453) behind https RPC proxies; fixture keys only. "source" stands for the old machine's relay,
// "eu-central" for the approved alternate, "target" for the same key moved to the Windows host.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startWorld, haveAnvil, DEPLOYER } from "./helpers/lease-gas-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(REPO, "test/fixtures/local-relay-migration");
const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const newFixture = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(hostUrl) && specifier === "./lease-gas-runtime.bundle.mjs")
    return { url: newFixture, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const T = { skip: !haveAnvil && "needs anvil", timeout: 600_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
let W, dir, rel, mc, ca, record, digest, op, owner, K, E, source, eu, target, srcDir, tgtDir, euDir, tgtPort;
const savedEnv = { ...process.env };
const servers = [], procs = [];

async function tlsProxy(target, { swallowSends = () => false } = {}) {
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const body = Buffer.concat(chunks);
      let msg = null; try { msg = JSON.parse(body); } catch {}
      // a broadcast LOST in the mempool: the provider answers its hash and never forwards it
      if (msg && !Array.isArray(msg) && msg.method === "eth_sendRawTransaction" && swallowSends()) {
        res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: keccak256(msg.params[0]) }));
      }
      const up = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(body); }); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); servers.push(server);
  return `https://127.0.0.1:${server.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const relayEnvOf = (d, rpcs, port) => ({ LEASE_RELAY_RECORD: record, LEASE_RELAY_DIGEST: digest, LEASE_RELAY_RPCS: rpcs.join(","), LEASE_RELAY_QUORUM: "2",
  LEASE_RELAY_MAX_FLOAT_ETH: "0.02", LEASE_RELAY_MIN_FLOAT_ETH: "0.001", LEASE_RELAY_LISTEN: `127.0.0.1:${port}`, LEASE_RELAY_KEY_FILE: path.join(d, "relay.key"),
  LEASE_RELAY_STATE: path.join(d, "relay-send.json"), LEASE_RELAY_ARTIFACT_SHA256: JSON.parse(fs.readFileSync(path.join(rel, "manifest.json"), "utf8")).artifact.sha256 });
/** a relay as its run loop starts it: `node <release>\lease-relay.mjs` with its settings in the environment */
function startRelay(env) {
  const child = spawn(process.execPath, [path.join(rel, "lease-relay.mjs")], { cwd: rel, env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: ca, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(child);
  let out = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  const exited = new Promise((ok) => child.once("exit", (code, signal) => ok({ code, signal })));
  const url = new Promise((ok, no) => { const t = setInterval(() => { const m = /\[relay\] serving .* on (http:\/\/127\.0\.0\.1:\d+);/.exec(out); if (m) { clearInterval(t); ok(m[1]); } }, 20);
    exited.then((e) => { clearInterval(t); no(new Error(`relay exited ${JSON.stringify(e)} before serving: ${out}`)); }); });
  return { child, url, exited, log: () => out, stop: async () => { child.kill("SIGTERM"); await exited; } };
}
const relayCheck = (env) => spawnSync(process.execPath, [path.join(rel, "lease-relay-check.mjs")], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
/** the migration gate, bundled, as the stage runs it (exit 0 = reconciled). ASYNC: the https RPC proxies live in this
 *  process, so a synchronous child would block them and time out */
function migrationCheck(env) {
  return new Promise((ok) => {
    const c = spawn(process.execPath, [path.join(mc, "lease-relay-migration-check.mjs")], { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: ca, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; c.stdout.on("data", (b) => { out += b; }); c.stderr.on("data", (b) => { err += b; });
    const t = setTimeout(() => c.kill("SIGKILL"), 120_000);
    c.on("exit", (code) => { clearTimeout(t); let j = null; try { j = JSON.parse(out.trim().split("\n").at(-1)); } catch {} ok({ code, out: j, text: out + err }); });
  });
}
async function loadHost(settings) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(key)) delete process.env[key];
  Object.assign(process.env, settings, { BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key });
  const c = await import(`${hostUrl}?host=${Math.random()}`);
  c.loadOperator(); c.setLeaseJournal(path.join(dir, `journal-${Math.random()}.json`));
  c.addresses.deployments = W.addr.ledger; c.addresses.registry = W.addr.registry;
  return c;
}
const hostEnv = (o) => ({ ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl, ...o });
async function newDeployment() {
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } });
  return id;
}
async function paidTo(id, from) {
  const ev = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from });
  return ev.map((e) => ({ kind: Number(e.args.kind), payee: e.args.payee }));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-relay-migration-"));
  const out = path.join(dir, "build");
  const built = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-release.mjs"), out], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").at(-1));
  rel = path.join(dir, "Enclave", "lease-relay", "releases", built.artifact.sha256);
  fs.mkdirSync(rel, { recursive: true }); for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(rel, f));
  mc = path.join(dir, "migration-check");
  execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-migration-check.mjs"), mc], { encoding: "utf8", timeout: 120_000 });
  if (!haveAnvil) return;
  W = await startWorld();
  for (const args of [["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=relay-migration-test-ca"],
    ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "leaf.key"), "-out", path.join(dir, "leaf.csr"), "-subj", "/CN=127.0.0.1"]])
    execFileSync("openssl", args, { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "leaf.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-CAcreateserial", "-out", path.join(dir, "leaf.pem"), "-days", "2", "-extfile", path.join(dir, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(dir, "ca.pem");
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  record = path.join(dir, "deployment.json"); fs.writeFileSync(record, bytes); digest = "sha256:" + sha(bytes);
  // two funded relay keys (fixture keys): K = the key that MOVES (us-west), E = the approved secondary (eu-central)
  K = { key: generatePrivateKey() }; K.address = privateKeyToAccount(K.key).address;
  E = { key: generatePrivateKey() }; E.address = privateKeyToAccount(E.key).address;
  for (const x of [K, E]) await W.fund(x.address, 10n ** 16n);
  srcDir = path.join(dir, "do-us-west"); euDir = path.join(dir, "do-eu-central"); tgtDir = path.join(dir, "ProgramData", "Enclave", "lease-relay");
  for (const [d, x] of [[srcDir, K], [euDir, E]]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "relay.key"), x.key.slice(2) + "\n", { mode: 0o600 }); }
  W.swallow = false;
  const srcRpcs = [await tlsProxy(W.rpcUrl, { swallowSends: () => W.swallow }), await tlsProxy(W.rpcUrl, { swallowSends: () => W.swallow }), await tlsProxy(W.rpcUrl, { swallowSends: () => W.swallow })];
  W.rpcs = [await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl)];
  source = startRelay(relayEnvOf(srcDir, srcRpcs, await freePort())); source.at = await source.url;
  eu = startRelay(relayEnvOf(euDir, W.rpcs, await freePort())); eu.at = await eu.url;
  op = await W.operator("https://minipc.relay-migration.test");
  owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
});
after(async () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  W?.stop(); hooks.deregister();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("the chain module's four lease-gas imports are exported by this tree's self-contained runtime bundle", () => {
  const chainSrc = fs.readFileSync(path.join(REPO, "windows/node/chain.mjs"), "utf8");
  const imported = /import \{([^}]+)\} from "\.\/lease-gas-runtime\.bundle\.mjs"/.exec(chainSrc)[1].split(",").map((s) => s.trim()).sort();
  for (const n of ["configuredLeaseSender", "leaseGasConfigured", "loadLeaseGasConfig", "openReleaseJournal"]) assert.ok(imported.includes(n), n);
  const exported = /export\{([^}]+)\};/.exec(fs.readFileSync(path.join(REPO, "windows/node/lease-gas-runtime.bundle.mjs"), "utf8"))[1].split(",").map((s) => s.trim().split(" as ")[1]);
  for (const n of imported) assert.ok(exported.includes(n), n);
  const deps = [...fs.readFileSync(path.join(REPO, "windows/node/lease-gas-runtime.bundle.mjs"), "utf8").matchAll(/from"([^"]+)"/g)].map((m) => m[1]).filter((d) => !d.startsWith("node:") && !d.startsWith(","));
  assert.deepEqual(deps, [], "node builtins only");
});

test("the migration's node settings load in the runtime bundle as local-first + the alternate; the previous ones as before; tampering refuses", () => {
  const check = (bundle, cfg, extra = []) => { const r = spawnSync(process.execPath, [path.join(REPO, "windows/installer/lease-gas-config-check.mjs"), "--bundle", path.join(REPO, bundle), "--config", cfg, ...extra], { encoding: "utf8" });
    return { code: r.status, out: JSON.parse(r.stdout.trim()) }; };
  // the staged files, with only the record path pointed at the reviewed record's local copy (same digest)
  const local = (name, edit = (s) => s) => { const f = path.join(os.tmpdir(), `lrm-${Math.random()}.cmd`);
    fs.writeFileSync(f, edit(fs.readFileSync(path.join(FIX, name), "utf8").replaceAll("C:\\ProgramData\\Enclave\\lease-gas\\deployment.json", path.join(FIX, "deployment.json")))); return f; };
  assert.equal(sha(fs.readFileSync(path.join(FIX, "lease-gas-config.before.cmd"))), "9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e");
  assert.equal(sha(fs.readFileSync(path.join(FIX, "deployment.json"))), "1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089");
  const n = check("windows/node/lease-gas-runtime.bundle.mjs", local("lease-gas-config.cmd"), ["--expect-local", "http://127.0.0.1:8549", "--expect-relays", "https://134.209.248.172"]);
  assert.equal(n.code, 0, JSON.stringify(n.out)); assert.equal(n.out.quorum, 2); assert.equal(n.out.rpcs, 3); assert.equal(n.out.reserve, "0x12A3f873041Dec436DaA0085B766a399A6fA3639");
  const prev = check("windows/node/lease-gas-runtime.bundle.mjs", local("lease-gas-config.before.cmd"), ["--expect-local", "none", "--expect-relays", "https://134.199.235.187,https://134.209.248.172"]);
  assert.equal(prev.code, 0, JSON.stringify(prev.out));
  for (const [why, edit] of [["a non-loopback local relay", (s) => s.replaceAll("http://127.0.0.1:8549", "http://10.0.0.5:8549")],
    ["the two names disagree", (s) => s.replace('LEASE_GAS_LOCAL_RELAY=http://127.0.0.1:8549"\r\n@set "LEASE_GAS_RELAYS', 'LEASE_GAS_LOCAL_RELAY=http://127.0.0.1:8550"\r\n@set "LEASE_GAS_RELAYS')],
    ["a wrong digest", (s) => s.replaceAll("sha256:1665c218", "sha256:0665c218")], ["a stray setting", (s) => s + "\r\n@set \"PATH=C:\\x\"\r\n"]]) {
    const r = check("windows/node/lease-gas-runtime.bundle.mjs", local("lease-gas-config.cmd", edit));
    assert.equal(r.code, 1, why);
  }
});

test("before the move: settings naming the source first relay through it; no operator ETH", T, async () => {
  const host = await loadHost(hostEnv({ ENCLAVE_LEASE_GAS_RELAYS: `${source.at},${eu.at}` }));
  const from = await W.pc.getBlockNumber();
  const id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: K.address }], "us-west is first");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

test("the source's unresolved send: a broadcast lost in the mempool leaves {nonce, raw, hash} on the source; the host fails over to eu-central", T, async () => {
  const host = await loadHost(hostEnv({ ENCLAVE_LEASE_GAS_RELAYS: `${source.at},${eu.at}` }));
  const from = await W.pc.getBlockNumber();
  const id = await newDeployment();
  W.swallow = true;
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: E.address }], "the approved secondary served the claim");
  // the source signed and journaled BEFORE broadcasting (durable first), then lost its broadcast
  for (let i = 0; i < 100 && fs.readFileSync(path.join(srcDir, "relay-send.json"), "utf8").trim() === "{}"; i++) await new Promise((ok) => setTimeout(ok, 100));
  // root's step on the source: STOP it (the stop comes before any start elsewhere); its journal stays where it is
  await source.stop(); W.swallow = false;
  const rec = JSON.parse(fs.readFileSync(path.join(srcDir, "relay-send.json"), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["hash", "nonce", "raw"], "an unresolved send is on record");
  assert.equal(await W.pc.getTransactionCount({ address: K.address }), rec.nonce, "never mined: it is still the key's next transaction");
  assert.equal(await W.pc.getTransactionReceipt({ hash: rec.hash }).catch(() => null), null);
  source.pending = rec;
});

test("the migration gate: refuses an absent journal, another key's record, a consumed nonce and a source still serving; passes the moved key", T, async () => {
  assert.ok(source.pending, "the previous test left the source's unresolved send");
  const envFor = (stateFile, o = {}) => ({ LEASE_RELAY_RECORD: record, LEASE_RELAY_DIGEST: digest, LEASE_RELAY_RPCS: W.rpcs.join(","), LEASE_RELAY_QUORUM: "2",
    LEASE_RELAY_STATE: stateFile, LEASE_RELAY_EXPECTED_PAYEE: K.address, LEASE_RELAY_MAX_FLOAT_ETH: "0.02", ...o });
  const scratch = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  let r = await migrationCheck(envFor(path.join(dir, "absent.json")));
  assert.equal(r.code, 1, r.text); assert.match(r.text, /must be carried over/);
  const eSigned = await privateKeyToAccount(E.key).signTransaction({ chainId: 8453, nonce: 0, to: E.address, value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
  r = await migrationCheck(envFor(scratch("other.json", JSON.stringify({ nonce: 0, raw: eSigned, hash: keccak256(eSigned) }))));
  assert.equal(r.code, 1, r.text); assert.match(r.text, /signed by another key/);
  const latest = await W.pc.getTransactionCount({ address: K.address });
  const stale = await privateKeyToAccount(K.key).signTransaction({ chainId: 8453, nonce: latest - 1, to: K.address, value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
  r = await migrationCheck(envFor(scratch("stale.json", JSON.stringify({ nonce: latest - 1, raw: stale, hash: keccak256(stale) }))));
  assert.equal(r.code, 1, r.text); assert.ok(r.out, r.text); assert.match(r.out.problems.join(" "), /consumed by ANOTHER transaction/);
  r = await migrationCheck(envFor(scratch("empty.json", "{}")));
  assert.equal(r.code, 0, r.text); assert.equal(r.out.decision, "nothing pending");
  // root moves the key and the journal (opaque copies; the source keeps its own protected copies for rollback)
  fs.mkdirSync(tgtDir, { recursive: true });
  for (const f of ["relay.key", "relay-send.json"]) fs.copyFileSync(path.join(srcDir, f), path.join(tgtDir, f), fs.constants.COPYFILE_EXCL);
  // exclusivity: a source that still answers as this key refuses (here: a second copy of the source started on its old journal)
  const still = startRelay(relayEnvOf(srcDir, W.rpcs, await freePort())); const stillAt = await still.url;
  r = await migrationCheck(envFor(path.join(tgtDir, "relay-send.json"), { LEASE_RELAY_SOURCE_ORIGIN: stillAt }));
  assert.equal(r.code, 1, r.text); assert.ok(r.out, r.text); assert.match(r.out.problems.join(" "), /STILL SERVES this key/);
  still.child.kill("SIGKILL"); await still.exited;   // killed before it could send anything
  r = await migrationCheck(envFor(path.join(tgtDir, "relay-send.json"), { LEASE_RELAY_SOURCE_ORIGIN: source.at }));
  assert.equal(r.code, 0, r.text);
  assert.match(r.out.decision, /not mined: the relay re-broadcasts these exact bytes/);
  assert.deepEqual(r.out.record, { nonce: source.pending.nonce, hash: source.pending.hash });
  assert.equal(r.out.source.serving, false);
  assert.equal(r.out.payee, K.address);
});

test("the moved key on the target: same payee, the journal's bytes re-broadcast before any new send, local FIRST with the DO relays absent, no operator ETH", T, async (t) => {
  tgtPort = await freePort();   // (the staged settings name 8549; any loopback port is the same code path)
  const env = relayEnvOf(tgtDir, W.rpcs, tgtPort);
  const chk = relayCheck(env);
  assert.equal(chk.status, 0, chk.stderr); assert.match(chk.stdout, new RegExp(`unresolved send ${source.pending.hash.slice(0, 18)}\\.\\.\\. at nonce ${source.pending.nonce}`));
  target = startRelay(env); target.at = await target.url;
  assert.equal(target.at, `http://127.0.0.1:${tgtPort}`);
  const info = await (await fetch(`${target.at}/v1/info`)).json();
  assert.equal(info.payee, K.address, "the same funded payee"); assert.equal(info.reserve, W.addr.reserve);
  // the new settings shape: LOCAL_RELAY first, eu-central the alternate; us-west (DigitalOcean) is not listed. Every HTTP
  // request the host's lease path makes is recorded: with no SERVICE_INDEX the bundle's discovery code (service-index,
  // descriptors, policy carriers) is never reached - only the two configured relays are ever contacted
  const realFetch = globalThis.fetch, fetched = [];
  globalThis.fetch = (url, ...rest) => { fetched.push(new URL(String(url?.url ?? url)).origin); return realFetch(url, ...rest); };
  t.after(() => { globalThis.fetch = realFetch; });
  const host = await loadHost(hostEnv({ ENCLAVE_LEASE_GAS_LOCAL_RELAY: target.at, ENCLAVE_LEASE_GAS_RELAYS: eu.at }));
  // the first request finds the source's unresolved send: the SAME bytes are re-broadcast (never re-signed) and that
  // request is refused RelayBusy, so the host's alternate serves it; the next one is signed by the moved key
  let from = await W.pc.getBlockNumber(), id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: E.address }], "busy re-broadcasting: eu-central served this one");
  const rc = await W.pc.getTransactionReceipt({ hash: source.pending.hash });
  assert.ok(rc, "the source's unresolved send was re-broadcast as the same bytes and mined");
  assert.equal(await W.pc.getTransactionCount({ address: K.address }), source.pending.nonce + 1, "its nonce, and nothing else, was consumed");
  from = await W.pc.getBlockNumber(); id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: K.address }], "the host's own relay, the moved key, first");
  assert.equal(await W.pc.getTransactionCount({ address: K.address }), source.pending.nonce + 2, "then the new send at the next nonce");
  const allowed = new Set([target.at, eu.at, new URL(W.rpcUrl).origin]);   // the two relays and the host's configured RPC
  assert.ok(fetched.includes(target.at) && fetched.every((o) => allowed.has(o)), `only the configured relays and RPC were contacted: ${[...new Set(fetched)].join(", ")}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tgtDir, "relay-send.json"), "utf8")), {}, "nothing unresolved now");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the host never held ETH");
});

test("the local relay down: the approved secondary (eu-central) serves; restarted on its own key and journal it is first again", T, async () => {
  await target.stop();
  const host = await loadHost(hostEnv({ ENCLAVE_LEASE_GAS_LOCAL_RELAY: target.at, ENCLAVE_LEASE_GAS_RELAYS: eu.at }));
  let from = await W.pc.getBlockNumber(), id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: E.address }]);
  const origin = target.at;
  target = startRelay(relayEnvOf(tgtDir, W.rpcs, tgtPort)); target.at = await target.url;
  assert.equal(target.at, origin, "the same loopback origin the settings name");
  from = await W.pc.getBlockNumber(); id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: K.address }]);
  await host.releaseDeployment(id);
  assert.deepEqual((await paidTo(id, from)).map((x) => x.kind), [1, 3], "release relayed too");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

test("settings without a local relay (a rollback of the settings) relay through the configured relays as before; the source is gone: the alternate serves", T, async () => {
  const host = await loadHost(hostEnv({ ENCLAVE_LEASE_GAS_RELAYS: `${source.at},${eu.at}` }));
  const from = await W.pc.getBlockNumber(), id = await newDeployment();
  await host.claimDeployment(id, op.enclaveId);
  assert.deepEqual(await paidTo(id, from), [{ kind: 1, payee: E.address }], "the source is stopped: the alternate");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});
