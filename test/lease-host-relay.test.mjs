// A host's OWN lease relay (windows/installer/install-lease-relay.ps1; ENCLAVE_LEASE_GAS_LOCAL_RELAY): the actual
// Windows chain module, with a ZERO-ETH operator, claims, renews and releases an app-funded deployment through the
// relay running on its own machine - the reviewed release artifact (scripts/build-lease-relay-release.mjs) started as a
// separate process exactly as its run loop starts it - while every OTHER configured relay is unreachable (standing in for
// all shared-provider relays being down). Each operation's gas is paid by that relay and reimbursed from the app's
// reserve in the same transaction (LeaseGasPaid to the relay). Local anvil behind https RPC proxies; fixture keys only.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startWorld, haveAnvil, DEPLOYER } from "./helpers/lease-gas-world.mjs";
import { loadLeaseGasConfig } from "../network/lease-gas-runtime.mjs";
import { validateLocalRelayUrl } from "../client/lease-executor-client.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(hostUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const UNREACHABLE = "https://192.0.2.1";   // TEST-NET-1: never answers
let W, dir, rel, ca, relayEnv, relayProc, relayUrl, relayAddr, op, owner, chain, hostEnv;
const savedEnv = { ...process.env };
const servers = [];

async function tlsProxy(target) {
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const up = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(chunks)); }); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); servers.push(server);
  return `https://127.0.0.1:${server.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
/** the relay as its run loop starts it: `node <release dir>\lease-relay.mjs`, settings from the environment */
function startRelay() {
  const child = spawn(process.execPath, [path.join(rel, "lease-relay.mjs")], { cwd: rel, env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: ca, ...relayEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  const exited = new Promise((ok) => child.once("exit", (code, signal) => ok({ code, signal })));
  const url = new Promise((ok, no) => { const t = setInterval(() => { const m = /\[relay\] serving .* on (http:\/\/127\.0\.0\.1:\d+);/.exec(out); if (m) { clearInterval(t); ok(m[1]); } }, 20);
    exited.then((e) => { clearInterval(t); no(new Error(`relay exited ${JSON.stringify(e)} before serving: ${out}`)); }); });
  return { child, url, exited, log: () => out };
}
async function loadHost(settings) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(key)) delete process.env[key];
  Object.assign(process.env, settings, { BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key });
  const c = await import(hostUrl + "?host-relay=" + Math.random());
  c.loadOperator(); c.setLeaseJournal(path.join(dir, `journal-${Math.random()}.json`));
  c.addresses.deployments = W.addr.ledger; c.addresses.registry = W.addr.registry;
  return c;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-host-relay-"));
  // the reviewed release, as install-lease-relay.ps1 installs it: releases\<sha>\ with the manifest's three files
  const out = path.join(dir, "build");
  const built = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-release.mjs"), out], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").at(-1));
  rel = path.join(dir, "Enclave", "lease-relay", "releases", built.artifact.sha256);
  fs.mkdirSync(rel, { recursive: true }); for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(rel, f));
  if (!haveAnvil) return;
  W = await startWorld();
  await W.write(DEPLOYER, W.addr.ledger, W.A.ledger.abi, "setLeaseSec", [120n]);   // a renewal window reached on the real clock
  for (const [args] of [[["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=host-relay-test-ca"]],
    [["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "leaf.key"), "-out", path.join(dir, "leaf.csr"), "-subj", "/CN=127.0.0.1"]]])
    execFileSync("openssl", args, { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "leaf.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-CAcreateserial", "-out", path.join(dir, "leaf.pem"), "-days", "2", "-extfile", path.join(dir, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(dir, "ca.pem");
  const rpcs = [await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl)];
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  const record = path.join(dir, "deployment.json"); fs.writeFileSync(record, bytes);
  const digest = "sha256:" + sha(bytes);
  // the host's relay key: generated the way the installer does (node crypto, secp256k1), funded with a small float
  const key = "0x" + Buffer.from((await import("node:crypto")).generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");
  const keyFile = path.join(dir, "relay.key"); fs.writeFileSync(keyFile, key.slice(2) + "\n", { mode: 0o600 });
  relayAddr = privateKeyToAccount(key).address;
  await W.fund(relayAddr, 10n ** 16n);
  const port = await freePort();
  relayEnv = { LEASE_RELAY_RECORD: record, LEASE_RELAY_DIGEST: digest, LEASE_RELAY_RPCS: rpcs.join(","), LEASE_RELAY_QUORUM: "2",
    LEASE_RELAY_MAX_FLOAT_ETH: "0.02", LEASE_RELAY_MIN_FLOAT_ETH: "0.001", LEASE_RELAY_LISTEN: `127.0.0.1:${port}`, LEASE_RELAY_KEY_FILE: keyFile,
    LEASE_RELAY_STATE: path.join(dir, "relay-send.json"), LEASE_RELAY_ARTIFACT_SHA256: built.artifact.sha256 };
  relayProc = startRelay(); relayUrl = await relayProc.url;
  op = await W.operator("https://host-relay.test");
  owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  hostEnv = { ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl,
    ENCLAVE_LEASE_GAS_LOCAL_RELAY: relayUrl, ENCLAVE_LEASE_GAS_RELAYS: UNREACHABLE };
  chain = await loadHost(hostEnv);
});
after(async () => {
  try { relayProc?.child.kill("SIGTERM"); await relayProc?.exited; } catch {}
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  W?.stop(); hooks.deregister();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("the local relay setting is loopback-only, explicit, and the host's own relay comes FIRST; remote relays become optional", () => {
  for (const ok of ["http://127.0.0.1:8549", "http://[::1]:8549", "https://127.0.0.1:8549"]) assert.equal(validateLocalRelayUrl(ok), new URL(ok).origin);
  for (const bad of ["http://localhost:8549", "http://127.0.0.1", "http://10.0.0.2:8549", "https://relay.example", "http://127.0.0.1:8549/v1", "http://u:p@127.0.0.1:8549", "ftp://127.0.0.1:21"])
    assert.throws(() => validateLocalRelayUrl(bad), /local relay/, bad);
  if (!haveAnvil) return;
  const base = { ENCLAVE_LEASE_GAS_FILE: hostEnv.ENCLAVE_LEASE_GAS_FILE, ENCLAVE_LEASE_GAS_DIGEST: hostEnv.ENCLAVE_LEASE_GAS_DIGEST, ENCLAVE_LEASE_GAS_RPCS: "https://a.example,https://b.example" };
  const bind = { chain: { id: 8453 }, ledger: W.addr.ledger, registry: W.addr.registry };
  const only = loadLeaseGasConfig({ env: { ...base, ENCLAVE_LEASE_GAS_LOCAL_RELAY: "http://127.0.0.1:8549" }, ...bind });
  assert.deepEqual([...only.localRelays], ["http://127.0.0.1:8549"]); assert.deepEqual([...only.relays], []);
  const both = loadLeaseGasConfig({ env: { ...base, LEASE_GAS_LOCAL_RELAY: "http://127.0.0.1:8549", ENCLAVE_LEASE_GAS_RELAYS: "https://relay-b.example" }, ...bind });
  assert.deepEqual([[...both.localRelays], [...both.relays]], [["http://127.0.0.1:8549"], ["https://relay-b.example"]]);
  assert.throws(() => loadLeaseGasConfig({ env: { ...base, ENCLAVE_LEASE_GAS_LOCAL_RELAY: "http://10.1.2.3:8549" }, ...bind }), /local relay/);
  assert.throws(() => loadLeaseGasConfig({ env: base, ...bind }), /require ENCLAVE_LEASE_GAS_RELAYS/, "neither: refused, never operator-paid");
  assert.throws(() => loadLeaseGasConfig({ env: { ENCLAVE_LEASE_GAS_LOCAL_RELAY: "http://127.0.0.1:8549" }, ...bind }), /require ENCLAVE_LEASE_GAS_FILE/, "a local relay alone is a PARTIAL configuration");
});

test("a ZERO-ETH host claims, renews and releases through its OWN relay (the release artifact), with every other relay unreachable", T, async () => {
  const info = await (await fetch(`${relayUrl}/v1/info`)).json();
  assert.equal(info.payee, relayAddr); assert.equal(info.reserve, W.addr.reserve);
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } });
  const from = await W.pc.getBlockNumber();
  const float0 = await W.pc.getBalance({ address: relayAddr });
  await chain.claimDeployment(id, op.enclaveId);
  const row = await W.row(id);
  assert.equal(row.runnerOperator, op.address);
  // into the owner's renew window on the REAL clock (no warp: the relay's own freshness guard runs on the wall clock)
  const waitMs = Number(row.leaseUntil) * 1000 - 55_000 - Date.now();
  if (waitMs > 0) await new Promise((ok) => setTimeout(ok, waitMs));
  await W.rpc("evm_mine", []);
  await chain.renewDeployment(id);
  assert.ok((await W.row(id)).leaseUntil > row.leaseUntil, "renewed");
  await chain.releaseDeployment(id);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the host never held ETH");
  const paid = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from });
  assert.deepEqual(paid.map((e) => Number(e.args.kind)), [1, 2, 3], "claim, renew, release - each paid by the app's reserve");
  assert.ok(paid.every((e) => e.args.payee === relayAddr), "to THIS host's relay");
  const float1 = await W.pc.getBalance({ address: relayAddr });
  console.log(`# host relay float ${float0} -> ${float1} wei across claim+renew+release (reimbursed in each transaction)`);
  assert.ok(float1 >= float0 * 99n / 100n, "the float is reimbursed, not spent (within 1%)");
  assert.match(relayProc.log(), /serving reserve/);
});

test("the host relay restarts on its own send record and key: same payee, nothing unresolved, serving again", T, async () => {
  relayProc.child.kill("SIGTERM"); await relayProc.exited;
  assert.deepEqual(JSON.parse(fs.readFileSync(relayEnv.LEASE_RELAY_STATE, "utf8")), {}, "every send resolved before the stop");
  relayProc = startRelay();
  const url = await relayProc.url;
  assert.equal(url, relayUrl, "the same loopback origin the host's setting names");
  assert.equal((await (await fetch(`${url}/v1/info`)).json()).payee, relayAddr);
});
