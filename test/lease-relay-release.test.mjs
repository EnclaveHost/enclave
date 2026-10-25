// The standalone lease relay RELEASE (scripts/build-lease-relay-release.mjs, network/lease-relay-check.mjs,
// relay/systemd/enclave-lease-relay.service; docs/network/lease-relay-release.md), run as it would be installed:
// releases/<sha256>/ + a `current` symlink, `node --preserve-symlinks-main current/lease-relay.mjs` with every setting in
// the environment exactly as the unit's EnvironmentFile gives it, the key in an owner-only file, and TWO https RPC
// providers (local TLS proxies, trusted through NODE_EXTRA_CA_CERTS, in front of a local anvil running the live rev-16d
// ledger, schema-4 registry, reserve and executor). A zero-ETH host's claim, renewal and release go through the
// artifact; its memory is sampled from /proc while it serves them and a burst of bad requests. No network beyond loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = { skip: !haveAnvil && "needs anvil and forge", timeout: 240_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
let W, dir, rel, artifactSha, env, ca, proxies = [], recordBytes;
const build = (out) => JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-release.mjs"), out], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").at(-1));

// two independent https "providers" in front of anvil (TLS terminated with a test CA the child trusts)
async function tlsProxy(target) {
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const up = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  proxies.push(server);
  return `https://127.0.0.1:${server.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const keyFile = (key, mode = 0o600) => { const f = path.join(dir, `relay-${Math.random().toString(16).slice(2)}.key`); fs.writeFileSync(f, key + "\n", { mode }); fs.chmodSync(f, mode); return f; };
const check = (e) => spawnSync(process.execPath, [path.join(rel, "current/lease-relay-check.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, ...e }, timeout: 15_000 });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-relay-release-"));
  // the release, built twice from this repository: byte-identical
  const a = build(path.join(dir, "build-a")), b = build(path.join(dir, "build-b"));
  assert.deepEqual(a.artifact, b.artifact, "the build is reproducible");
  artifactSha = a.artifact.sha256;
  console.log(`# lease relay artifact ${a.artifact.bytes} bytes sha256:${artifactSha} (${a.inputs} inputs); check ${a.check.sha256}`);
  if (process.env.LEASE_RELAY_EXPECT_SHA256) assert.equal(artifactSha, process.env.LEASE_RELAY_EXPECT_SHA256, "the reviewed artifact is reproduced from this tree");
  rel = path.join(dir, "opt");
  fs.mkdirSync(path.join(rel, "releases"), { recursive: true });
  fs.cpSync(path.join(dir, "build-a"), path.join(rel, "releases", artifactSha), { recursive: true });
  fs.symlinkSync(path.join("releases", artifactSha), path.join(rel, "current"));
  if (!haveAnvil) return;
  W = await startWorld();
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=lease-relay-test-ca"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "leaf.key"), "-out", path.join(dir, "leaf.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "leaf.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-CAcreateserial", "-out", path.join(dir, "leaf.pem"), "-days", "2", "-extfile", path.join(dir, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(dir, "ca.pem");
  const rpcs = [await tlsProxy(W.rpcUrl), await tlsProxy(W.rpcUrl)];
  recordBytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  fs.writeFileSync(path.join(dir, "deployment.json"), recordBytes);
  env = { LEASE_RELAY_RECORD: path.join(dir, "deployment.json"), LEASE_RELAY_DIGEST: "sha256:" + sha(recordBytes), LEASE_RELAY_RPCS: rpcs.join(","),
    LEASE_RELAY_QUORUM: "2", LEASE_RELAY_MAX_FLOAT_ETH: "0.02", LEASE_RELAY_MIN_FLOAT_ETH: "0.001", LEASE_RELAY_LISTEN: `127.0.0.1:${await freePort()}`,
    LEASE_RELAY_ARTIFACT_SHA256: artifactSha, LEASE_RELAY_STATE: path.join(dir, "relay-send.json") };
});
after(() => { for (const p of proxies) { p.closeAllConnections?.(); p.close(); } W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test("the release directory holds exactly the manifest's files and the manifest's inputs are this tree's files", () => {
  const m = JSON.parse(fs.readFileSync(path.join(rel, "current/manifest.json"), "utf8"));
  assert.equal(m.format, "enclave-lease-relay-release/v1"); assert.equal(m.entry, "network/lease-relay-service.mjs");
  assert.deepEqual(fs.readdirSync(path.join(rel, "current")).sort(), ["lease-relay-check.mjs", "lease-relay.mjs", "manifest.json"]);
  assert.equal(sha(fs.readFileSync(path.join(rel, "current/lease-relay.mjs"))), m.artifact.sha256);
  assert.equal(sha(fs.readFileSync(path.join(rel, "current/lease-relay-check.mjs"))), sha(fs.readFileSync(path.join(REPO, "network/lease-relay-check.mjs"))));
  for (const [f, h] of Object.entries(m.inputs)) assert.equal(sha(fs.readFileSync(path.join(REPO, f))), h, f);
  assert.ok(Object.keys(m.inputs).includes("network/lease-relay-service.mjs") && Object.keys(m.inputs).some((f) => f.startsWith("node_modules/viem/")));
});

test("the configuration check passes only with every setting explicit and valid, and reads no key", T, async () => {
  const k = generatePrivateKey(), kf = keyFile(k);
  const ok = check({ ...env, LEASE_RELAY_KEY_FILE: kf });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /lease relay configuration ok: .*2 RPCs \(quorum 2\), float 0\.001\.\.0\.02 ETH/);
  const unreadable = keyFile("not even a key"); fs.chmodSync(unreadable, 0o200);   // owner-write-only: a check that READ it would fail
  const w = check({ ...env, LEASE_RELAY_KEY_FILE: unreadable });
  assert.equal(w.status, 0, `a check that opened the key would fail here: ${w.stderr}`);
  const rpcs = env.LEASE_RELAY_RPCS.split(",");
  for (const [why, over, want] of [
    ...["LEASE_RELAY_RECORD", "LEASE_RELAY_DIGEST", "LEASE_RELAY_RPCS", "LEASE_RELAY_QUORUM", "LEASE_RELAY_MAX_FLOAT_ETH", "LEASE_RELAY_MIN_FLOAT_ETH", "LEASE_RELAY_LISTEN", "LEASE_RELAY_KEY_FILE", "LEASE_RELAY_ARTIFACT_SHA256", "LEASE_RELAY_STATE"]
      .map((k2) => [`no ${k2}`, { [k2]: "" }, new RegExp(`${k2} is not set \\(there is no default\\)`)]),
    ["wrong digest", { LEASE_RELAY_DIGEST: "sha256:" + "0".repeat(64) }, /not the reviewed sha256:0000/],
    ["one RPC", { LEASE_RELAY_RPCS: rpcs[0], LEASE_RELAY_QUORUM: "1" }, /2\.\.16 independent providers/],
    ["plain http RPC", { LEASE_RELAY_RPCS: `${rpcs[0]},${W.rpcUrl}` }, /must be https/],
    ["the same provider twice", { LEASE_RELAY_RPCS: `${rpcs[0]},${rpcs[0]}` }, /appears twice/],
    ["no majority", { LEASE_RELAY_RPCS: `${rpcs[0]},${rpcs[1]},https://127.0.0.2:1`, LEASE_RELAY_QUORUM: "1" }, /strict majority/],
    ["min not below max", { LEASE_RELAY_MIN_FLOAT_ETH: "0.02" }, /must be below/],
    ["relative state file", { LEASE_RELAY_STATE: "relay-send.json" }, /must be an absolute path/],
    ["state file in no directory", { LEASE_RELAY_STATE: path.join(dir, "absent", "relay-send.json") }, /LEASE_RELAY_STATE directory .*ENOENT/],
    ["zero float", { LEASE_RELAY_MAX_FLOAT_ETH: "0" }, /positive decimal/],
    ["public listener", { LEASE_RELAY_LISTEN: "0.0.0.0:8545" }, /127\.0\.0\.1:PORT/],
    ["no port", { LEASE_RELAY_LISTEN: "127.0.0.1:0" }, /explicit port/],
    ["group-readable key", { LEASE_RELAY_KEY_FILE: keyFile(k, 0o640) }, /owner only/],
    ["another artifact", { LEASE_RELAY_ARTIFACT_SHA256: "f".repeat(64) }, /not the reviewed f{12}/]]) {
    const r = check({ ...env, LEASE_RELAY_KEY_FILE: kf, ...over });
    assert.equal(r.status, 1, why); assert.match(r.stderr, want, why);
  }
});

test("the configuration check reads the send record: exactly {} or one {nonce, raw, hash}; anything else fails clearly", T, async () => {
  const k = generatePrivateKey(), kf = keyFile(k), acct = privateKeyToAccount(k);
  const raw = await acct.signTransaction({ chainId: 8453, type: "eip1559", nonce: 7, to: acct.address, value: 0n, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  const hash = keccak256(raw);
  const at = (text) => { const f = path.join(dir, `state-${createHash("sha256").update(String(text) + Math.random()).digest("hex").slice(0, 8)}.json`); fs.writeFileSync(f, text); return f; };
  const empty = check({ ...env, LEASE_RELAY_KEY_FILE: kf, LEASE_RELAY_STATE: at("{}") });
  assert.equal(empty.status, 0, empty.stderr); assert.doesNotMatch(empty.stdout, /unresolved send/);
  const pending = check({ ...env, LEASE_RELAY_KEY_FILE: kf, LEASE_RELAY_STATE: at(JSON.stringify({ nonce: 7, raw, hash })) });
  assert.equal(pending.status, 0, pending.stderr); assert.match(pending.stdout, new RegExp(`unresolved send ${hash.slice(0, 18)}\\.\\.\\. at nonce 7 \\(re-broadcast before any new one\\)`));
  const accepted = [];
  for (const [what, text] of [["null", "null"], ["an array", "[]"], ["a string", '"x"'], ["a nonce only", '{"nonce":123}'], ["an empty raw", '{"raw":""}'],
    ["an arbitrary object", '{"foo":1}'], ["raw without hash", JSON.stringify({ nonce: 7, raw })], ["no nonce", JSON.stringify({ raw, hash })],
    ["a string nonce", JSON.stringify({ nonce: "7", raw, hash })], ["an extra field", JSON.stringify({ nonce: 7, raw, hash, note: 1 })], ["a short hash", JSON.stringify({ nonce: 7, raw, hash: hash.slice(0, 20) })],
    ["an empty file", ""], ["not JSON", "{not json"]]) {
    const r = check({ ...env, LEASE_RELAY_KEY_FILE: kf, LEASE_RELAY_STATE: at(text) });
    if (r.status !== 1) accepted.push(`${what}: ACCEPTED (${r.stdout.trim().slice(0, 60)}...)`);
    else if (!/is not a relay send record .*settle it by hand/.test(r.stderr)) accepted.push(`${what}: refused unclearly: ${r.stderr.trim().slice(0, 120)}`);
  }
  assert.deepEqual(accepted, [], "every malformed record fails the check, clearly");
  // the unit keeps the record in a StateDirectory of its own (DynamicUser chowns it recursively): never a key's directory
  const unit = fs.readFileSync(path.join(REPO, "relay/systemd/enclave-lease-relay.service"), "utf8");
  assert.match(unit, /^StateDirectory=enclave-lease-relay-state$/m);
  assert.match(unit, /^Environment=LEASE_RELAY_STATE=%S\/enclave-lease-relay-state\/relay-send\.json$/m);
});

// The unit's credential handling (2026-10-21, both relays): systemd presented LoadCredential 0440 and the strict owner-only
// check refused it. The unit's FIRST ExecStartPre copies it 0600 into the service's own runtime directory, and the env
// names the copy. Executed here as the unit states it (%d, %t substituted), on a fixture key presented 0440.
test("the unit copies a 0440 credential 0600 into its private runtime directory, before the check, and the check accepts only the copy", T, async () => {
  const unit = fs.readFileSync(path.join(REPO, "relay/systemd/enclave-lease-relay.service"), "utf8");
  const one = (re) => { const m = unit.match(re); assert.ok(m, String(re)); return m; };
  one(/^LoadCredential=relay-key:\S+$/m);
  one(/^RuntimeDirectory=enclave-lease-relay-credentials$/m); one(/^RuntimeDirectoryMode=0700$/m);
  const keyEnv = one(/^Environment=LEASE_RELAY_KEY_FILE=(%t\/enclave-lease-relay-credentials\/relay\.key)$/m)[1];
  const pre = [...unit.matchAll(/^ExecStartPre=(.+)$/gm)].map((m) => m[1]);
  assert.equal(pre.length, 2);
  assert.equal(pre[0], `/usr/bin/install -m 0600 %d/relay-key ${keyEnv}`, "the copy runs FIRST, to exactly the file the env names");
  assert.match(pre[1], /lease-relay-check\.mjs$/, "then the configuration check");
  assert.doesNotMatch(unit, /^Environment=LEASE_RELAY_KEY_FILE=%d\//m, "the service is never pointed at the 0440 credential itself");
  // run the unit's own install line
  const creds = path.join(dir, "credentials"), run = path.join(dir, "run");
  fs.mkdirSync(creds, { recursive: true }); fs.mkdirSync(path.join(run, "enclave-lease-relay-credentials"), { recursive: true, mode: 0o700 });
  const k = generatePrivateKey();
  fs.writeFileSync(path.join(creds, "relay-key"), k + "\n"); fs.chmodSync(path.join(creds, "relay-key"), 0o440);
  const sub = (x) => x.replaceAll("%d", creds).replaceAll("%t", run);
  const [bin, ...argv] = sub(pre[0]).split(" ");
  execFileSync(bin, argv);
  const copy = sub(keyEnv);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(path.join(creds, "relay-key"))), "an exact copy");
  assert.equal(fs.statSync(path.join(creds, "relay-key")).mode & 0o777, 0o440, "the credential itself is unchanged");
  const raw = check({ ...env, LEASE_RELAY_KEY_FILE: path.join(creds, "relay-key") });
  assert.equal(raw.status, 1); assert.match(raw.stderr, /mode 440: it must be readable by its owner only/, "the 0440 credential itself is refused (the failure seen live)");
  const ok = check({ ...env, LEASE_RELAY_KEY_FILE: copy });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /lease relay configuration ok/);
});

// the node flags exactly as the unit's ExecStart runs the artifact (so the measured memory is the deployed process's);
// LEASE_RELAY_MEASURE_NODE_ARGS (measurement runs only) replaces them to compare a candidate flag set
const UNIT_NODE_ARGS = (() => {
  const m = /^ExecStart=\/usr\/bin\/node((?: --[^\s]+)*) \/opt\/enclave-lease-relay\/current\/lease-relay\.mjs$/m.exec(fs.readFileSync(path.join(REPO, "relay/systemd/enclave-lease-relay.service"), "utf8"));
  if (!m) throw new Error("the unit's ExecStart is not /usr/bin/node [--flags] /opt/enclave-lease-relay/current/lease-relay.mjs");
  return m[1].trim().split(/\s+/).filter(Boolean);
})();
const MEASURE_ARGS = process.env.LEASE_RELAY_MEASURE_NODE_ARGS ? process.env.LEASE_RELAY_MEASURE_NODE_ARGS.split(/\s+/).filter(Boolean) : UNIT_NODE_ARGS;
function serve(extraEnv = {}, args = MEASURE_ARGS) {
  const child = spawn(process.execPath, [...args, path.join(rel, "current/lease-relay.mjs")], { cwd: path.join(rel, "current"),
    env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: ca, ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", peak = 0, rss = 0;
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  const sampler = setInterval(() => { try { const s = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
    rss = Number(/VmRSS:\s+(\d+)/.exec(s)?.[1] || 0); peak = Math.max(peak, Number(/VmHWM:\s+(\d+)/.exec(s)?.[1] || 0)); } catch {} }, 25);
  const exited = new Promise((ok) => child.once("exit", (code, signal) => { clearInterval(sampler); ok({ code, signal }); }));
  const url = new Promise((ok, no) => { const t = setInterval(() => { const m = /\[relay\] serving .* on (http:\/\/127\.0\.0\.1:\d+);/.exec(out); if (m) { clearInterval(t); ok(m[1]); } }, 20);
    exited.then((e) => { clearInterval(t); no(Object.assign(new Error(`relay exited ${JSON.stringify(e)} before serving: ${out}`), { exit: e, out })); }); });
  return { child, url, exited, log: () => out, memory: () => ({ rssKiB: rss, peakKiB: peak }) };
}

test("through the symlinked release the artifact starts only with --preserve-symlinks-main (the unit's ExecStart)", T, async () => {
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address, 10n ** 16n);
  const plain = serve({ LEASE_RELAY_KEY_FILE: keyFile(k) }, []);
  const e = await plain.url.then(() => null, (err) => err.exit);
  assert.deepEqual(e, { code: 0, signal: null }, "without the flag its entry guard does not match: it exits without serving");
  assert.doesNotMatch(plain.log(), /serving/);
});

// The artifact runs on the real clock, so the chain is NOT warped while it relays (renewal timing is covered in-process by
// test/lease-relay-service.test.mjs and test/lease-executor-e2e.test.mjs); the last test warps it to show the freshness guard.
test("the installed artifact relays a zero-ETH host's claim and release; bounded under bad requests; measured memory", T, async () => {
  const k = generatePrivateKey(), payee = privateKeyToAccount(k).address;
  await W.fund(payee, 10n ** 16n);
  const relay = serve({ LEASE_RELAY_KEY_FILE: keyFile(k) });
  try {
    const url = await relay.url;
    const info = await (await fetch(`${url}/v1/info`)).json();
    assert.equal(info.payee, payee); assert.equal(info.reserve, W.addr.reserve);
    const owner = await W.owner(), id = await W.create(owner);
    await W.enable(owner, id);
    const op = await W.operator("https://lease-relay-release.test");
    const host = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
      relays: [url], allowLoopbackHttp: true, confirmations: 0 });
    const c = await host.claim(id, op.enclaveId);
    assert.equal((await W.row(id)).runnerOperator, op.address);
    await W.write(owner.key, W.addr.ledger, W.A.ledger.abi, "setActive", [id, false]);
    const x = await host.release(id);
    assert.equal((await W.row(id)).runnerOperator, "0x0000000000000000000000000000000000000000");
    for (const tx of [c, x]) assert.equal(tx.receipt.status, "success");
    assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the host never held ETH");
    assert.deepEqual(JSON.parse(fs.readFileSync(env.LEASE_RELAY_STATE, "utf8")), {}, "both sends resolved: the durable record holds no unresolved send");
    const left = await W.pc.getBalance({ address: payee });
    assert.ok(left > 0n && left <= 2n * 10n ** 16n, `the relay key stays within its float: ${left}`);
    // bad requests: oversized, malformed, wrong method, concurrent - every one answered with a refusal, none sent
    const bad = await Promise.all(Array.from({ length: 48 }, (_, i) => fetch(`${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" },
      body: i % 3 === 0 ? "x".repeat(8192) : i % 3 === 1 ? "{not json" : JSON.stringify({ op: "claim", id: "0x00" }) }).then((res) => res.status, () => 0)));
    assert.ok(bad.every((s) => [400, 413, 422, 503].includes(s)), `refused: ${[...new Set(bad)]}`);
    console.log(`# bad-request answers: ${[...new Set(bad)].sort().join(",")} (413 oversize, 400 malformed, 422 refused, 503 over the concurrency bound)`);
    assert.equal((await (await fetch(`${url}/v1/info`)).json()).payee, payee, "still serving after the burst");
    assert.equal(await W.pc.getBalance({ address: payee }), left, "no bad request cost the relay gas");
    const m = relay.memory();
    console.log(`# lease relay memory (node ${MEASURE_ARGS.join(" ")}): peak RSS ${(m.peakKiB / 1024).toFixed(1)} MiB, RSS after the run ${(m.rssKiB / 1024).toFixed(1)} MiB (claim + release + ${bad.length} refused requests)`);
    // the unit's MemoryMax must leave at least 2x the measured peak (startup, two operations and a refusal burst)
    const unitMax = /^MemoryMax=(\d+)M$/m.exec(fs.readFileSync(path.join(REPO, "relay/systemd/enclave-lease-relay.service"), "utf8"));
    assert.ok(unitMax, "the unit sets MemoryMax in MiB");
    assert.ok(m.peakKiB > 0 && 2 * m.peakKiB <= Number(unitMax[1]) * 1024, `peak RSS ${m.peakKiB} KiB vs MemoryMax=${unitMax[1]}M`);
  } finally {
    relay.child.kill("SIGTERM");
    const e = await relay.exited;
    assert.ok(e.signal === "SIGTERM" || e.code !== null, "stops on SIGTERM");
  }
});

test("the artifact's own CLI refuses a key above its float cap before relaying anything", T, async () => {
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address, 10n ** 18n);
  const relay = serve({ LEASE_RELAY_KEY_FILE: keyFile(k) });
  const e = await relay.url.then(() => assert.fail("served"), (err) => err);
  assert.deepEqual(e.exit, { code: 1, signal: null }); assert.match(e.out, /not started: relay key 0x[0-9a-fA-F]{40} holds 1(\.0+)? ETH, above its 0\.02 ETH float cap/);
});

test("the artifact's own CLI refuses to start without the durable send record (LEASE_RELAY_STATE)", T, async () => {
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address, 10n ** 16n);
  const relay = serve({ LEASE_RELAY_KEY_FILE: keyFile(k), LEASE_RELAY_STATE: "" });
  const e = await relay.url.then(() => assert.fail("served"), (err) => err);
  assert.deepEqual(e.exit, { code: 1, signal: null }); assert.match(e.out, /not started: LEASE_RELAY_STATE is not set/);
});

// Last: it moves the chain two hours past the wall clock. A host whose own clock agrees with that chain asks the relay;
// the relay, on the real clock, refuses before sending anything.
test("the artifact refuses to relay against a chain head ahead of its own clock", T, async () => {
  const k = generatePrivateKey(), payee = privateKeyToAccount(k).address;
  await W.fund(payee, 10n ** 16n);
  const relay = serve({ LEASE_RELAY_KEY_FILE: keyFile(k) });
  try {
    const url = await relay.url;
    const owner = await W.owner(), id = await W.create(owner);
    await W.enable(owner, id);
    const op = await W.operator("https://lease-relay-release-ahead.test");   // the registry holds one operator per endpoint
    const ahead = BigInt(Math.floor(Date.now() / 1000) + 7200);
    await W.warpTo(ahead);
    const skew = Number(ahead) * 1000 - Date.now();
    const host = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
      relays: [url], allowLoopbackHttp: true, confirmations: 0, now: () => Date.now() + skew });
    const before = await W.pc.getBalance({ address: payee });
    await assert.rejects(host.claim(id, op.enclaveId), /stale or ahead of the local clock/);
    assert.equal(await W.pc.getBalance({ address: payee }), before, "the refused claim cost the relay nothing");
    assert.equal((await W.row(id)).runnerOperator, "0x0000000000000000000000000000000000000000");
  } finally {
    relay.child.kill("SIGTERM"); await relay.exited;
  }
});
