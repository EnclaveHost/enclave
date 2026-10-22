// REAL user-service fixture on this machine's own user manager (systemd --user), ephemeral and loopback-only:
//   1. the frozen release's host role runs as a TRANSIENT user unit (systemd-run --user, unique name, --collect) with
//      EXACTLY the [Service] settings of units/enclave-host-relay-eu.service.in (MemoryMax=512M, TasksMax=64, the sandbox
//      options), on a fixture chain (anvil) with an ephemeral fixture key placed as a MOVED key: it answers /v1/info as
//      that key, keeps the moved key and journal, and the KERNEL enforces the limits (the unit's cgroup memory.max,
//      memory.swap.max and pids.max are read back);
//   2. a probe: does a per-user unit's IPAddressAllow/IPAddressDeny actually filter? A transient loopback listener with
//      IPAddressDeny=any IPAddressAllow=127.0.0.2/32 is connected from 127.0.0.2 and 127.0.0.3. The observed answer decides
//      whether the fixed forwarder is needed (it is, if the denied peer gets through), and is recorded in evidence.
// No existing unit is touched, no unit file is written, nothing listens on :8549 or a non-loopback address; both units
// are stopped and collected. Fixture keys only. Platform policy is EXPLICITLY off for the fixture role (its real gate is
// exercised by main's lease-relay-host-policy.test.mjs pointed at the frozen copy, in the same job).
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), WS = path.resolve(HERE, ".."), MAIN = path.resolve(WS, "../enclave");
const run = promisify(execFile);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const { startWorld, haveAnvil } = await import(pathToFileURL(path.join(MAIN, "test/helpers/lease-gas-world.mjs")).href);
const { privateKeyToAccount, generatePrivateKey } = await import(pathToFileURL(path.join(MAIN, "node_modules/viem/_esm/accounts/index.js")).href);
const userManager = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" });
const skip = !haveAnvil ? "needs anvil" : !/^(running|degraded)/.test(userManager.stdout || "") ? `no usable user manager (${(userManager.stdout || userManager.stderr).trim()})` : false;
const TAR = (() => { const d = path.join(WS, "release"); const t = fs.readdirSync(d).filter((f) => /^[0-9a-f]{64}\.tar$/.test(f)); return t.length === 1 ? path.join(d, t[0]) : null; })();
const ID = TAR && path.basename(TAR, ".tar");
const FIX = fs.mkdtempSync(path.join(WS, ".fixture-"));            // on disk, under $HOME (PrivateTmp hides /tmp from the unit)
const tag = randomBytes(4).toString("hex");
const UNIT = `eu-relay-fixture-${tag}.service`, PROBE = `eu-relay-ipprobe-${tag}.service`;
const servers = [], evidence = { at: new Date().toISOString(), units: [UNIT, PROBE] };
let W, rel, key, addr, port, ca;

/** the template's [Service] settings, as systemd-run properties (ExecStart*, WorkingDirectory and Type are given separately) */
function templateProps(target) {
  const t = fs.readFileSync(path.join(rel, "units/enclave-host-relay-eu.service.in"), "utf8").replaceAll("@TARGET@", target).replaceAll("@RELEASE@", ID);
  const svc = t.split(/^\[Service\]$/m)[1].split(/^\[/m)[0];
  return svc.split("\n").filter((l) => /^[A-Z][A-Za-z]+=/.test(l) && !/^(ExecStart|ExecStartPre|WorkingDirectory|Type)=/.test(l));
}
async function tlsProxy() {
  const s = https.createServer({ key: fs.readFileSync(path.join(FIX, "leaf.key")), cert: fs.readFileSync(path.join(FIX, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const up = http.request(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(chunks)); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s);
  return `https://127.0.0.1:${s.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const show = async (unit, props) => Object.fromEntries((await run("systemctl", ["--user", "show", unit, ...props.flatMap((p) => ["-p", p])])).stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const stopUnit = async (unit) => { await run("systemctl", ["--user", "stop", unit]).catch(() => {}); await run("systemctl", ["--user", "reset-failed", unit]).catch(() => {}); };

before(async () => {
  if (skip || !TAR) return;
  const d = path.join(FIX, "rel"); fs.mkdirSync(d);
  execFileSync("tar", ["-xf", TAR, "-C", d, "--no-same-owner"]); rel = path.join(d, ID);
  execFileSync("find", [rel, "-type", "d", "-exec", "chmod", "0700", "{}", "+"]); execFileSync("find", [rel, "-type", "f", "-exec", "chmod", "0600", "{}", "+"]);
  W = await startWorld();
  for (const args of [["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(FIX, "ca.key"), "-out", path.join(FIX, "ca.pem"), "-days", "2", "-subj", "/CN=eu-user-fixture-ca"],
    ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(FIX, "leaf.key"), "-out", path.join(FIX, "leaf.csr"), "-subj", "/CN=127.0.0.1"]]) execFileSync("openssl", args, { stdio: "ignore" });
  fs.writeFileSync(path.join(FIX, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(FIX, "leaf.csr"), "-CA", path.join(FIX, "ca.pem"), "-CAkey", path.join(FIX, "ca.key"), "-CAcreateserial", "-out", path.join(FIX, "leaf.pem"), "-days", "2", "-extfile", path.join(FIX, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(FIX, "ca.pem");
});
after(async () => {
  await stopUnit(UNIT); await stopUnit(PROBE);
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  W?.stop();
  fs.mkdirSync(path.join(WS, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(WS, "evidence/user-unit-fixture.json"), JSON.stringify(evidence, null, 1) + "\n");
  fs.rmSync(FIX, { recursive: true, force: true });
});

test("the frozen role as a transient USER unit with the template's exact settings: serves the moved key, keeps its files, kernel-enforced limits", { skip, timeout: 240_000 }, async () => {
  assert.ok(TAR, "the frozen release archive");
  const v = spawnSync(process.execPath, [path.join(rel, "verify-release.mjs")], { encoding: "utf8" }); assert.equal(v.status, 0, v.stdout);
  // the target layout the unit expects, with an ephemeral fixture key placed as the MOVED key and its journal
  const target = path.join(FIX, "target"), st = path.join(target, "state"), dir = path.join(st, "lease-relay");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(target, "etc"), { mode: 0o700 });
  key = generatePrivateKey(); addr = privateKeyToAccount(key).address;
  fs.writeFileSync(path.join(dir, "relay.key"), key.slice(2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "relay.address"), addr + "\n", { mode: 0o600 });
  const journal = JSON.stringify({}); fs.writeFileSync(path.join(dir, "relay-send.json"), journal, { mode: 0o600 });
  await W.fund(addr, 10n ** 16n);
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453, ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  const rec = path.join(target, "etc/lease-gas-deployment.json"); fs.writeFileSync(rec, bytes, { mode: 0o600 });
  const M = JSON.parse(fs.readFileSync(path.join(rel, "RELEASE.json"), "utf8"));
  port = await freePort();
  const cfg = path.join(target, "etc/host-relay.json");
  fs.writeFileSync(cfg, JSON.stringify({ format: "enclave-host-relay/v1", host: { endpoint: "https://api.enclave.host/t/metal0", publicEndpoints: [] }, platformHostPolicy: "off",
    packagesDir: path.join(rel, "packages"), stateRoot: st,
    relay: { package: M.relayPackage.pin, heapMiB: 128, port, bind: "127.0.0.1", record: rec, digest: "sha256:" + sha(bytes), rpc: [await tlsProxy(), await tlsProxy()], quorum: 2, maxFloatEth: "0.02", minFloatEth: "0.001", extraCaFile: ca } }), { mode: 0o600 });
  const keySha = sha(fs.readFileSync(path.join(dir, "relay.key")));
  const props = templateProps(target);
  evidence.properties = props;
  const cli = path.join(rel, "app/network/host-services/lease-relay-host.mjs");
  // `check` first, as the unit's ExecStartPre does
  const c = await run("/usr/bin/node", [cli, "check", cfg]); assert.equal(JSON.parse(c.stdout).payee, addr);
  await run("systemd-run", ["--user", `--unit=${UNIT}`, "--collect", "--quiet", "--property=Type=simple", `--working-directory=${st}`, ...props.map((p) => `--property=${p}`), "/usr/bin/node", cli, "run", cfg]);
  let info = null; const end = Date.now() + 90_000;
  while (!info) {
    try { const r = await fetch(`http://127.0.0.1:${port}/v1/info`); if (r.ok) info = await r.json(); } catch {}
    if (!info) { if (Date.now() > end) { const j = await run("journalctl", ["--user", "-u", UNIT, "--no-pager", "-n", "40"]).catch((e) => ({ stdout: String(e) })); assert.fail(`the fixture unit did not serve:\n${j.stdout}`); } await new Promise((ok) => setTimeout(ok, 300)); }
  }
  assert.equal(info.payee, addr, "it serves as the MOVED key"); assert.deepEqual([info.chainId, info.reserve, info.executor], [8453, W.addr.reserve, W.addr.executor]);
  const s = await show(UNIT, ["ActiveState", "MemoryMax", "MemorySwapMax", "TasksMax", "NoNewPrivileges", "ProtectSystem", "ProtectHome", "PrivateTmp", "UMask", "Restart", "ControlGroup", "RestrictAddressFamilies"]);
  evidence.show = s;
  assert.deepEqual([s.ActiveState, s.MemoryMax, s.MemorySwapMax, s.TasksMax, s.NoNewPrivileges, s.ProtectSystem, s.ProtectHome, s.PrivateTmp, s.Restart],
    ["active", String(512 * 1024 * 1024), "0", "64", "yes", "strict", "read-only", "yes", "on-failure"]);
  const cg = path.join("/sys/fs/cgroup", s.ControlGroup);
  const kernel = Object.fromEntries(["memory.max", "memory.swap.max", "pids.max"].map((f) => [f, fs.readFileSync(path.join(cg, f), "utf8").trim()]));
  evidence.cgroup = { path: s.ControlGroup, ...kernel };
  assert.deepEqual(kernel, { "memory.max": String(512 * 1024 * 1024), "memory.swap.max": "0", "pids.max": "64" }, "the kernel enforces the unit's limits");
  // the sandbox holds: the unit sees /home read-only except its state (its own process writes nothing elsewhere)
  assert.equal(sha(fs.readFileSync(path.join(dir, "relay.key"))), keySha, "the moved key is kept byte for byte");
  assert.equal(fs.readFileSync(path.join(dir, "relay-send.json"), "utf8"), journal, "the moved journal is the one in use");
  await stopUnit(UNIT);
  assert.equal((await show(UNIT, ["ActiveState"])).ActiveState, "inactive");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/info`), undefined, "nothing serves after the stop");
  evidence.role = { servedPayee: info.payee, stopped: true };
});

test("probe: a per-USER unit's IPAddressAllow/IPAddressDeny - enforced or not, as observed (decides the fixed forwarder)", { skip, timeout: 60_000 }, async () => {
  const p = await freePort();
  const lan = fs.readFileSync(path.join(rel, "units/enclave-host-relay-eu-lan.service.in"), "utf8");
  // the template must not CLAIM an IP restriction the user manager does not enforce; the forwarder enforces the peer itself
  assert.doesNotMatch(lan.split("\n").filter((l) => !l.startsWith("#")).join("\n"), /IPAddress(Allow|Deny)=/, "no unverified IP access list in the user unit");
  try {
    await run("systemd-run", ["--user", `--unit=${PROBE}`, "--collect", "--quiet", "--property=IPAddressDeny=any", "--property=IPAddressAllow=127.0.0.2/32", "--property=RuntimeMaxSec=45",
      "/usr/bin/node", "-e", `require("net").createServer((c)=>c.end("hi")).listen(${p},"127.0.0.1")`]);
  } catch (e) {
    evidence.ipProbe = { enforced: false, startRefused: String(e.stderr || e.message).slice(0, 400) };
    console.log(`# per-user IPAddressDeny: the user manager refused the unit (${evidence.ipProbe.startRefused.trim()})`);
    return;
  }
  const tryFrom = (from) => new Promise((ok) => { const c = net.connect({ host: "127.0.0.1", port: p, localAddress: from }); let got = ""; c.on("data", (b) => { got += b; });
    c.on("error", () => ok({ connected: false, got })); c.on("close", () => ok({ connected: true, got })); setTimeout(() => { c.destroy(); ok({ connected: false, got, timeout: true }); }, 3000); });
  let allowed = { got: "" }; const end = Date.now() + 15_000;
  while (allowed.got !== "hi" && Date.now() < end) { allowed = await tryFrom("127.0.0.2"); if (allowed.got !== "hi") await new Promise((ok) => setTimeout(ok, 300)); }
  assert.equal(allowed.got, "hi", "the probe listener serves the allowed peer");
  const denied = await tryFrom("127.0.0.3");
  const s = await show(PROBE, ["IPAddressDeny", "IPAddressAllow", "ActiveState"]);
  evidence.ipProbe = { allowed, denied, show: s, enforced: denied.got !== "hi" };
  await stopUnit(PROBE);
  console.log(`# per-user IPAddressDeny enforced: ${evidence.ipProbe.enforced} (denied peer got ${JSON.stringify(denied.got)})`);
});
