// cli/host-independent-lifecycle.mjs: an independent host's init/build/install/run/check/referral, end to end against
// real local tools: the real fetchRuntime and release verifier (HTTP replica fixture), viem + QuorumChain against two
// JSON-RPC fixture servers, the real supervisor.js startup rules, and the host's own wallet-policy resolution.
// Nothing here touches a live chain, a real wallet, SSH or production. Each test is small and serial.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, parseAbi, decodeFunctionData, encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hostLifecycle, verdict, directOnlyEnvProblems, supervisorEnv, loadPlan, planTrust, REFERRAL_ONCHAIN_MISSING } from "../cli/host-independent-lifecycle.mjs";
import { REGISTRY_SCHEMA4_ABI } from "../cli/independent.mjs";
import { encodeProfile, profileDigest, contractPinsFromProfile } from "../network/authority-profile.mjs";
import { hostAdmissionPolicyHash } from "../network/host-admission-policy.mjs";
import { packageCID } from "../sdk/bootstrap/package.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = path.join(REPO, "contracts/deployments/network-profile-base.json");
const PROFILE_DIGEST = "sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8";
const REAL = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
const ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64);
const sha = (b) => createHash("sha256").update(b).digest("hex");

function scratch(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "host-lifecycle-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
async function cli(argv, opts = {}) {
  const out = [], err = [];
  const code = await hostLifecycle(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env: { HOME: "/nonexistent", ...opts.env }, ...opts.deps });
  return { code, out: out.join("\n"), err: err.join("\n"), all: out.concat(err).join("\n") };
}
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((ok) => { s.closeAllConnections?.(); s.close(ok); })));
function initArgs(dir, { rpcs = ["https://rpc-a.example", "https://rpc-b.example"], gateways = ["http://203.0.113.5:8189"], extra = [] } = {}) {
  return ["init", "--dir", dir, "--profile", PROFILE, "--profile-digest", PROFILE_DIGEST, "--rpc", rpcs.join(","), "--public-url", "https://host.example.org",
    "--repo", "example/enclave", "--release-id", "a".repeat(64), "--gateways", gateways.join(","), "--guest-mem-mib", "4096", "--guest-cpus", "2",
    "--supervisor-port", "1", ...extra];
}
const secretsOf = (dir) => [fs.readFileSync(path.join(dir, "operator.key"), "utf8").trim(), fs.readFileSync(path.join(dir, "supervisor.secret"), "utf8").trim()];
const noSecrets = (text, dir) => { for (const s of secretsOf(dir)) { assert(!text.includes(s), "a secret was printed"); assert(!text.includes(s.replace(/^0x/, ""))); } };
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
function rewritePlan(dir, fn) { const f = path.join(dir, "host-plan.json"), p = JSON.parse(fs.readFileSync(f, "utf8")); fn(p); fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n"); }

// ---- init ----------------------------------------------------------------------------------------------------------------
test("init refuses inputs that are not explicit, verified and independent", async (t) => {
  const d = scratch(t), dir = path.join(d, "h");
  const refusals = [
    [["init", "--dir", dir, "--rpc", "https://a.example,https://b.example"], /name the authorities/],
    [initArgs(dir).map((a) => a === PROFILE_DIGEST ? "sha256:" + "0".repeat(64) : a), /digest/i],
    [initArgs(dir, { rpcs: ["https://a.example"] }), /2 to 8 explicit RPC/],
    [initArgs(dir, { rpcs: ["https://a.example", "https://a.example/other"] }), /one vote/],
    [initArgs(dir, { rpcs: ["http://rpc.example", "https://b.example"] }), /./],
    [initArgs(dir).map((a) => a === "https://host.example.org" ? "https://myhost.enclave.host" : a), /Enclave relay name/],
    [initArgs(dir).map((a) => a === "https://host.example.org" ? "http://host.example.org" : a), /https/],
    [initArgs(dir).map((a) => a === "a".repeat(64) ? "abc" : a), /release pin/],
    [initArgs(dir, { gateways: ["http://replica.example:8189"] }), /literal IP/],
    [initArgs(dir, { gateways: ["https://replica.example/ipfs"] }), /give the origin/],
    [initArgs(dir, { extra: ["--guest-cpus", "0"] }), /guestCpus/],
    [initArgs(dir, { extra: ["--referral", "bad code!"] }), /referral/],
    [initArgs(dir, { extra: ["--attestation-url", "https://attest.example.org"] }), /loopback/],
  ];
  for (const [argv, re] of refusals) {
    const r = await cli(argv);
    assert.equal(r.code, 1, argv.join(" ")); assert.match(r.err, re);
  }
  // contract pins name no host-ownership authority: a wallet policy needs the reviewed profile
  const pins = path.join(d, "pins.json");
  fs.writeFileSync(pins, JSON.stringify(contractPinsFromProfile(REAL)));
  const viaPins = initArgs(dir, { extra: ["--policy-dir", path.join(d, "pol")] }).filter((a, i, all) => ![PROFILE, PROFILE_DIGEST].includes(a) && !["--profile", "--profile-digest"].includes(a));
  const r = await cli([...viaPins, "--contract-pins", pins]);
  assert.equal(r.code, 1); assert.match(r.err, /walletPolicy needs a reviewed profile/);
  assert(!fs.existsSync(dir), "a refused init wrote nothing");
  const dry = await cli([...initArgs(dir), "--dry-run"]);
  assert.equal(dry.code, 0); assert.match(dry.out, /dry run: nothing written/); assert(!fs.existsSync(dir));
});

test("init mints private keys with private modes, prints none, and never overwrites", async (t) => {
  const dir = path.join(scratch(t), "h");
  const r = await cli(initArgs(dir, { extra: ["--referral", "friend-1", "--price-cpu", "0.05"] }));
  assert.equal(r.code, 0, r.err);
  assert.equal(mode(dir), "700");
  for (const f of ["host-plan.json", "operator.key", "supervisor.secret"]) assert.equal(mode(path.join(dir, f)), "600", f);
  const [key] = secretsOf(dir), address = privateKeyToAccount(key).address;
  assert.match(r.out, new RegExp(address)); noSecrets(r.all, dir);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "host-plan.json"), "utf8"));
  assert.equal(plan.format, "enclave-independent-host/v1");
  assert(!JSON.stringify(plan).includes(key.slice(2)), "the plan carries no secret");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "contract-pins.json"))).contracts.registry, REAL.contracts.registry.address);
  // an existing plan is never silently replaced; --replace-plan rewrites the plan and keeps every key
  const again = await cli(initArgs(dir, { extra: ["--guest-cpus", "4"] }));
  assert.equal(again.code, 1); assert.match(again.err, /already set up/);
  const re = await cli([...initArgs(dir, { extra: ["--guest-cpus", "4"] }), "--replace-plan"]);
  assert.equal(re.code, 0, re.err); assert.match(re.out, /changed: guestd, selling, referral/);
  assert.equal(secretsOf(dir)[0], key, "the operator key survives a plan change");
  assert.equal(loadPlan(dir).guestd.guestCpus, 4);
  // a key file that is not private is refused, not used
  fs.chmodSync(path.join(dir, "operator.key"), 0o644);
  const loose = await cli(["install", "--dir", dir, "--apply", "--unit-dir", path.join(dir, "u")]);
  assert.equal(loose.code, 1); assert.match(loose.err, /mode 644/);
});

// ---- build -----------------------------------------------------------------------------------------------------------------
// The release fixture of test/pinned-host-runtime.test.mjs, served over real HTTP by raw CID.
async function releaseFixture(t, d) {
  const iso = path.join(d, "isolation"), release = path.join(d, "release-src");
  fs.mkdirSync(path.join(iso, "m4"), { recursive: true }); fs.mkdirSync(path.join(release, "template", "rt"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "isolation/m4/release-manifest.py"), path.join(iso, "m4/release-manifest.py"));
  for (const f of ["kernel", "firmware.fd", "template/init", "template/front", "template/rt/wasmtime", "template/rt/runtime.json"]) fs.writeFileSync(path.join(release, f), "fixture " + f);
  fs.writeFileSync(path.join(iso, "m4/verifying-firmware.txt"), sha(Buffer.from("fixture firmware.fd")) + " test-only firmware\n");
  execFileSync("python3", [path.join(iso, "m4/release-manifest.py"), "write", release, "--cmdline", "console=ttyS0"]);
  const manifest = fs.readFileSync(path.join(release, "release.json")), id = sha(manifest);
  const objects = new Map([[packageCID(id), manifest]]);
  for (const [name, { sha256 }] of Object.entries(JSON.parse(manifest).files)) objects.set(packageCID(sha256), fs.readFileSync(path.join(release, name)));
  const server = http.createServer((req, res) => { const b = objects.get(req.url.split("/").at(-1)); res.writeHead(b ? 200 : 404); res.end(b || ""); });
  const port = await listen(server); t.after(() => closeAll([server]));
  return { iso, id, origin: `http://127.0.0.1:${port}` };
}

test("build fetches and verifies the pinned release from the named replica, and builds nothing it cannot verify", async (t) => {
  const d = scratch(t), dir = path.join(d, "h"), rel = await releaseFixture(t, d);
  const args = initArgs(dir, { gateways: [rel.origin] }).map((a) => a === "a".repeat(64) ? rel.id : a);
  assert.equal((await cli([...args, "--isolation", rel.iso])).code, 0);
  const dry = await cli(["build", "--dir", dir, "--dry-run"]);
  assert.equal(dry.code, 0); assert.match(dry.out, /would fetch/); assert.match(dry.out, /go build -trimpath/); assert.match(dry.out, /-gen-key/);
  assert(!fs.existsSync(path.join(dir, `release-${rel.id}`)));
  const b = await cli(["build", "--dir", dir, "--only", "release"]);
  assert.equal(b.code, 0, b.err); assert.match(b.out, /fetched and verified: 6 files/);
  assert.match((await cli(["build", "--dir", dir, "--only", "release"])).out, /present: .*manifest matches the pin/);
  const deep = async () => JSON.parse((await cli(["check", "--dir", dir, "--deep", "--json"])).out).rows.find((r) => r.item === "release");
  assert.equal((await deep()).status, "ready");
  fs.writeFileSync(path.join(dir, `release-${rel.id}`, "kernel"), "tampered");
  const bad = await deep(); assert.equal(bad.status, "failed"); assert.match(bad.detail, /verify/);
  // collateral needs the SEV host itself: the exact commands are printed, nothing is pretended
  const c = await cli(["build", "--dir", dir, "--only", "collateral"]);
  assert.equal(c.code, 0); assert.match(c.out, /NEEDS THIS SEV HOST/); assert.match(c.out, /host-collateral\.mjs prepare --statement/);
  // the pairing key is made only by guestd itself
  const noGuestd = await cli(["build", "--dir", dir, "--only", "pair-key"]);
  assert.equal(noGuestd.code, 1); assert.match(noGuestd.err, /build guestd first/);
  // stand-in for the built guestd binary, implementing only its documented -gen-key contract (new file, 0600, 64 hex)
  fs.mkdirSync(path.join(dir, "bin")); fs.writeFileSync(path.join(dir, "bin", "guestd"),
    `#!${process.execPath}\nconst fs=require("fs");if(process.argv[2]!=="-gen-key")process.exit(2);fs.writeFileSync(process.argv[3],require("crypto").randomBytes(32).toString("hex")+"\\n",{flag:"wx",mode:0o600});\n`, { mode: 0o700 });
  const pk = await cli(["build", "--dir", dir, "--only", "pair-key"]);
  assert.equal(pk.code, 0, pk.err); assert.equal(mode(path.join(dir, "pair.key")), "600");
  const keyBefore = fs.readFileSync(path.join(dir, "pair.key"), "utf8");
  assert.match((await cli(["build", "--dir", dir, "--only", "pair-key"])).out, /present/);
  assert.equal(fs.readFileSync(path.join(dir, "pair.key"), "utf8"), keyBefore, "never regenerated");
  assert(!pk.all.includes(keyBefore.trim()));
});

// ---- install / run -----------------------------------------------------------------------------------------------------
test("install prints redacted units by default, applies them privately, and refuses to replace a different file", async (t) => {
  const d = scratch(t), dir = path.join(d, "h"), units = path.join(d, "units");
  assert.equal((await cli(initArgs(dir, { extra: ["--policy-dir", path.join(d, "policies"), "--payout", "0x" + "12".repeat(20)] }))).code, 0);
  const dry = await cli(["install", "--dir", dir, "--unit-dir", units]);
  assert.equal(dry.code, 0, dry.err); noSecrets(dry.all, dir);
  assert.match(dry.out, /REGISTRY_PRIVATE_KEY_FILE='[^']*\/operator\.key'/); assert(!/REGISTRY_PRIVATE_KEY=/.test(dry.out));
  assert.match(dry.out, /BASE_RPCS='https:\/\/rpc-a\.example,https:\/\/rpc-b\.example'/);
  assert.match(dry.out, /ENCLAVE_HOST_OWNERSHIP='0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea'/);
  assert.match(dry.out, /-gateway "\[\\"http:\/\/203\.0\.113\.5:8189\\"\]"/);
  assert(!/enclave\.host/.test(dry.out), "no Enclave origin anywhere in the units or environment");
  assert(!fs.existsSync(units) && !fs.existsSync(path.join(dir, "supervisor.env")), "dry run writes nothing");
  const ap = await cli(["install", "--dir", dir, "--unit-dir", units, "--apply"]);
  assert.equal(ap.code, 0, ap.err); noSecrets(ap.all, dir);
  const env = path.join(dir, "supervisor.env");
  assert.equal(mode(env), "600");
  assert(!fs.readFileSync(env, "utf8").includes(secretsOf(dir)[0].slice(2)), "the operator key stays in operator.key");
  assert(fs.readFileSync(env, "utf8").includes(`SECRET='${secretsOf(dir)[1]}'`));
  assert.deepEqual(fs.readdirSync(units).sort(), ["enclave-independent-host-guestd.service", "enclave-independent-host-supervisor.service"]);
  assert.equal((await cli(["install", "--dir", dir, "--unit-dir", units, "--apply"])).code, 0, "re-applying identical files is a no-op");
  const originalEnv = fs.readFileSync(env, "utf8");
  const installed = async () => {
    const result = await cli(["check", "--dir", dir, "--unit-dir", units, "--json"]);
    noSecrets(result.all, dir);
    return JSON.parse(result.out).rows.find((r) => r.item === "installed units");
  };
  assert.equal((await installed()).status, "ready");
  fs.writeFileSync(env, originalEnv.replace("SECRETS_API=\n", "SECRETS_API='https://old-relay.example'\n"));
  assert.equal(mode(env), "600");
  assert.equal((await installed()).status, "failed", "private but stale relay configuration is not ready");
  fs.writeFileSync(env, originalEnv.replace(secretsOf(dir)[1], "ff".repeat(32)));
  assert.equal((await installed()).status, "failed", "another supervisor secret is not ready");
  fs.writeFileSync(env, originalEnv);
  fs.appendFileSync(path.join(units, "enclave-independent-host-guestd.service"), "# operator edit\n");
  const clash = await cli(["install", "--dir", dir, "--unit-dir", units, "--apply"]);
  assert.equal(clash.code, 1); assert.match(clash.err, /refusing to replace/);
  assert.match(fs.readFileSync(path.join(units, "enclave-independent-host-guestd.service"), "utf8"), /# operator edit/);
  const row = JSON.parse((await cli(["check", "--dir", dir, "--unit-dir", units, "--json"])).out).rows.find((r) => r.item === "installed units");
  assert.equal(row.status, "failed"); assert.match(row.detail, /DIFFERS/);
  const run = await cli(["run", "--dir", dir, "--component", "supervisor", "--dry-run"]);
  assert.equal(run.code, 0); noSecrets(run.all, dir); assert.match(run.out, /SECRET='<redacted>'/); assert.match(run.out, /ISOLATION_DIRECT_ONLY=1/);
  const g = await cli(["run", "--dir", dir, "--component", "guestd", "--dry-run"]);
  assert.match(g.out, /GUESTD_ENABLE=1/); assert.match(g.out, /-direct-bootstrap/); assert.match(g.out, /-gateway '\["http:\/\/203\.0\.113\.5:8189"\]'/);
});

test("run reports a non-executable guestd and removes its signal handlers", async (t) => {
  const dir = path.join(scratch(t), "h");
  assert.equal((await cli(initArgs(dir))).code, 0);
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/guestd"), "not executable", { mode: 0o600 });
  const before = ["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s));
  const result = await cli(["run", "--dir", dir, "--component", "guestd"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /EACCES/);
  assert.deepEqual(["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s)), before);
  noSecrets(result.all, dir);
});

test("a configured attestation URL alone does not prove a measured supervisor", async (t) => {
  const dir = path.join(scratch(t), "h");
  assert.equal((await cli(initArgs(dir, { extra: ["--attestation-url", "http://127.0.0.1:1/attestation"] }))).code, 0);
  const result = await cli(["check", "--dir", dir, "--json"]);
  const row = JSON.parse(result.out).rows.find((r) => r.item === "control attestation");
  assert.equal(row.status, "unknown");
  assert.equal(row.required, true);
  assert.match(row.detail, /has not verified/);
  noSecrets(result.all, dir);
});

test("the real supervisor accepts the derived environment, and refuses it with the rule the tool mirrors", async (t) => {
  const d = scratch(t), dir = path.join(d, "h");
  assert.equal((await cli(initArgs(dir))).code, 0);
  const plan = loadPlan(dir), ctx = planTrust(plan);
  const env = supervisorEnv(dir, { ...plan, supervisor: { ...plan.supervisor, port: 0 } }, ctx, { operatorKey: "0x" + "11".repeat(32), secret: "ab".repeat(32) });
  assert.equal(env.REGISTRY_PRIVATE_KEY_FILE, path.join(dir, "operator.key")); assert.equal(env.REGISTRY_PRIVATE_KEY, undefined);
  assert.deepEqual(directOnlyEnvProblems(env), []);
  const start = (e) => new Promise((ok) => {
    const c = spawn(process.execPath, ["--max-old-space-size=160", path.join(REPO, "supervisor.js")], { cwd: REPO, env: { PATH: process.env.PATH, HOME: d, ...e }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; const stop = setTimeout(() => c.kill("SIGKILL"), 20000);
    for (const s of [c.stdout, c.stderr]) s.on("data", (b) => { log += b; if (/\[direct\] direct-only host control/.test(log)) c.kill("SIGTERM"); });
    c.on("exit", (code) => { clearTimeout(stop); ok({ code, log }); });
  });
  const good = await start(env);
  assert.match(good.log, /\[direct\] direct-only host control/); assert(!/refused|REGISTRY_PRIVATE_KEY_FILE must/.test(good.log));
  fs.chmodSync(path.join(dir, "operator.key"), 0o644);
  const loose = await start(env);
  assert.equal(loose.code, 1); assert.match(loose.log, /FATAL: REGISTRY_PRIVATE_KEY_FILE must be this user's regular 0600 file/);
  fs.chmodSync(path.join(dir, "operator.key"), 0o600);
  const { SECRETS_API: _, ...unset } = env;
  assert.deepEqual(directOnlyEnvProblems(unset), ["SECRETS_API must be set and empty"]);
  const bad = await start(unset);
  assert.equal(bad.code, 2); assert.match(bad.log, /ISOLATION_DIRECT_ONLY refused: SECRETS_API must be empty/);
});

// ---- chain fixture: two JSON-RPC servers answering from one state ---------------------------------------------------------
const OWN_ABI = parseAbi(["function registry() view returns (address)", "function authority(bytes32) view returns (address owner,address pendingOwner,uint64 revision,bytes32 policyHash)"]);
const ABI = [...REGISTRY_SCHEMA4_ABI, ...OWN_ABI];
const CODE = { registry: "0x60016001", deployments: "0x60026002", appCatalog: "0x60036003", hostOwnership: "0x60046004" };
function entry(over = {}) {
  return { endpoint: "", repo: "", measurement: ZERO32, operator: ZERO, registeredAt: 0n, lastSeen: 0n, active: false, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: ZERO, payoutWallet: ZERO, ...over };
}
async function chainFixture(t, state) {
  const block = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1n, { size: 32 })), timestamp: toHex(Math.floor(Date.now() / 1000)),
    transactions: [], uncles: [], gasLimit: "0x1c9c380", gasUsed: "0x0", logsBloom: "0x" + "0".repeat(512), miner: ZERO, nonce: "0x0000000000000000", size: "0x1", difficulty: "0x0",
    extraData: "0x", sha3Uncles: ZERO32, stateRoot: ZERO32, transactionsRoot: ZERO32, receiptsRoot: ZERO32, mixHash: ZERO32, baseFeePerGas: "0x1", totalDifficulty: "0x0" });
  const answer = ({ method, params }) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return toHex(100n);
    if (method === "eth_getBlockByNumber") return block(BigInt(params[0]));
    if (method === "eth_getCode") return state.code[params[0].toLowerCase()] ?? "0x";
    if (method === "eth_getBalance") return toHex(state.balance[params[0].toLowerCase()] ?? 0n);
    if (method === "eth_call") {
      const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data ?? params[0].input });
      return encodeFunctionResult({ abi: ABI, functionName, result: state.call(params[0].to.toLowerCase(), functionName, args) });
    }
    throw new Error("unsupported " + method);
  };
  const servers = [0, 1].map(() => http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
      const one = (m) => { try { return { jsonrpc: "2.0", id: m.id, result: answer(m) }; } catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e.message } }; } };
      const m = JSON.parse(body); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)));
    });
  }));
  const ports = await Promise.all(servers.map(listen)); t.after(() => closeAll(servers));
  return ports.map((p) => `http://127.0.0.1:${p}`);
}
/** A reviewed-profile fixture: the real Base profile with code hashes for the fixture contracts' code. */
function fixtureProfile(d) {
  const p = structuredClone(REAL);
  for (const [k, code] of Object.entries(CODE)) p.contracts[k].codeHash = keccak256(code);
  const bytes = encodeProfile(p), file = path.join(d, "profile.json"); fs.writeFileSync(file, bytes);
  return { file, digest: profileDigest(bytes) };
}

test("check reads registration, gas and the wallet policy through the agreeing quorum; failures are unknown, never ready", async (t) => {
  const d = scratch(t), dir = path.join(d, "h"), policies = path.join(d, "policies"); fs.mkdirSync(policies);
  const reg = REAL.contracts.registry.address, own = REAL.contracts.hostOwnership.address;
  const hostId = keccak256(toHex("https://host.example.org")), owner = "0x" + "77".repeat(20);
  const state = { code: Object.fromEntries(Object.entries(CODE).map(([k, c]) => [REAL.contracts[k].address, c])), balance: {}, entry: entry(), authority: [ZERO, ZERO, 0n, ZERO32],
    call(to, fn, args) {
      if (to === reg && fn === "registrySchema") return 4n;
      if (to === reg && fn === "get") return args[0] === hostId ? this.entry : entry();
      if (to === own && fn === "registry") return reg;
      if (to === own && fn === "authority") return args[0] === hostId ? this.authority : [ZERO, ZERO, 0n, ZERO32];
      throw new Error(`no ${fn} at ${to}`);
    } };
  const rpcs = await chainFixture(t, state), prof = fixtureProfile(d);
  const args = initArgs(dir, { rpcs, extra: ["--policy-dir", policies] }).map((a) => a === PROFILE ? prof.file : a === PROFILE_DIGEST ? prof.digest : a);
  assert.equal((await cli(args)).code, 0);
  const operator = privateKeyToAccount(secretsOf(dir)[0]).address.toLowerCase();
  const rows = async () => { const r = await cli(["check", "--dir", dir, "--unit-dir", path.join(d, "u"), "--json"]); noSecrets(r.all, dir); return [r.code, Object.fromEntries(JSON.parse(r.out).rows.map((x) => [x.item, x]))]; };

  let [code, r] = await rows();
  assert.equal(code, 3);
  assert.equal(r["reviewed code"].status, "ready");
  assert.equal(r.registration.status, "missing"); assert.match(r.registration.detail, /not in the pinned registry/);
  assert.equal(r["operator gas"].status, "missing");
  assert.equal(r["wallet policy"].status, "missing"); assert.match(r["wallet policy"].detail, /refuses every deployment/);
  assert.equal(r["guestd running"].status, "failed"); assert.equal(r["supervisor running"].status, "failed");

  state.entry = entry({ endpoint: "https://host.example.org", operator, active: true, lastSeen: BigInt(Math.floor(Date.now() / 1000) - 30), proofKey: "0x" + "33".repeat(20) });
  state.balance[operator] = 10n ** 15n;
  const policy = { version: 1, chainId: 8453, ownershipContract: own, hostId, requireCatalogApproval: false, denyDeployments: [], denyAppRefs: [] };
  const ph = hostAdmissionPolicyHash(policy);
  state.authority = [owner, ZERO, 1n, ph];
  [, r] = await rows();
  assert.equal(r.registration.status, "ready"); assert.equal(r["proof key"].status, "ready"); assert.equal(r["payout wallet"].status, "missing"); assert.equal(r["payout wallet"].required, false);
  assert.equal(r["operator gas"].status, "ready");
  assert.equal(r["wallet policy"].status, "failed", "a committed policy the host cannot resolve refuses deployments"); assert.match(r["wallet policy"].detail, /refuses deployments/);
  fs.writeFileSync(path.join(policies, `${ph}.json`), JSON.stringify(policy));
  [, r] = await rows();
  assert.equal(r["wallet policy"].status, "ready", r["wallet policy"].detail);
  fs.writeFileSync(path.join(policies, `${ph}.json`), JSON.stringify({ ...policy, requireCatalogApproval: true }));
  [, r] = await rows();
  assert.equal(r["wallet policy"].status, "failed"); assert.match(r["wallet policy"].detail, /mismatch|does not match/);

  state.entry = { ...state.entry, operator: "0x" + "99".repeat(20) };
  [, r] = await rows();
  assert.equal(r.registration.status, "failed"); assert.match(r.registration.detail, /not this host's operator/);

  // reviewed code that is not on chain is a failure, not an outage
  state.code[REAL.contracts.registry.address] = "0x6009";
  [, r] = await rows();
  assert.equal(r["reviewed code"].status, "failed");

  // the RPCs disagree: no quorum is unknown
  const realCall = state.call; let flip = 0;
  state.call = function (to, fn, args) { const v = realCall.call(this, to, fn, args); return fn === "get" && flip++ % 2 ? { ...v, lastSeen: v.lastSeen + 1n } : v; };
  [, r] = await rows();
  assert.equal(r.registration.status, "unknown"); assert.match(r.registration.detail, /agreed|quorum/);
  state.call = realCall;
});

test("an unreachable chain or service is never reported as ready", async (t) => {
  const d = scratch(t), dir = path.join(d, "h");
  assert.equal((await cli(initArgs(dir, { rpcs: ["https://127.0.0.2:1", "https://127.0.0.3:1"] }))).code, 0);
  // something unrelated answering on the supervisor port is not a supervisor
  const other = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"hello":"world"}'); });
  const port = await listen(other); t.after(() => closeAll([other]));
  rewritePlan(dir, (p) => { p.supervisor.port = port; });
  const r = await cli(["check", "--dir", dir, "--json"]);
  const rows = Object.fromEntries(JSON.parse(r.out).rows.map((x) => [x.item, x]));
  for (const k of ["reviewed code", "registration", "operator gas"]) assert.equal(rows[k].status, "unknown", k);
  assert.equal(rows["supervisor running"].status, "failed"); assert.match(rows["supervisor running"].detail, /not a supervisor/);
  assert.equal(rows["control attestation"].status, "missing");
  assert.equal(r.code, 3);
  // the verdict: every required row ready -> 0; any unknown (and nothing missing) -> 4
  const ready = [{ item: "a", status: "ready", required: true }, { item: "b", status: "missing", required: false }];
  assert.equal(verdict(ready).code, 0);
  assert.equal(verdict([...ready, { item: "c", status: "unknown", required: true }]).code, 4);
  assert.equal(verdict([...ready, { item: "c", status: "unknown", required: true }, { item: "d", status: "failed", required: true }]).code, 3);
});

// ---- referral ----------------------------------------------------------------------------------------------------------------
test("referral: optional, operator-signed, verified by anyone against the registry; the missing on-chain interface is named", async (t) => {
  const d = scratch(t), dir = path.join(d, "h"), verifier = path.join(d, "v");
  const reg = REAL.contracts.registry.address, hostId = keccak256(toHex("https://host.example.org"));
  const state = { code: {}, balance: {}, entry: entry(), call(to, fn, args) {
    if (to === reg && fn === "registrySchema") return 4n;
    if (to === reg && fn === "get") return args[0] === hostId ? this.entry : entry();
    throw new Error("no " + fn);
  } };
  const rpcs = await chainFixture(t, state);
  assert.equal((await cli(initArgs(dir, { rpcs }))).code, 0);
  const none = await cli(["referral", "--dir", dir]);
  assert.equal(none.code, 0); assert.match(none.out, /attribution is optional/); assert(!fs.existsSync(path.join(dir, "referral.json")));
  const s = await cli(["referral", "--dir", dir, "friend-1"]);
  assert.equal(s.code, 0, s.err); noSecrets(s.all, dir);
  assert(s.out.includes(REFERRAL_ONCHAIN_MISSING)); assert.match(REFERRAL_ONCHAIN_MISSING, /setReferral\(bytes32 id, string code\)/);
  const file = path.join(dir, "referral.json"), doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc.code, "friend-1"); assert.equal(doc.host, hostId);
  assert.equal((await cli(["referral", "--dir", dir, "other"])).code, 1, "a stated code is not silently replaced");
  // a verifier with their OWN plan (authorities and RPCs), no Enclave service
  assert.equal((await cli(initArgs(verifier, { rpcs }))).code, 0);
  const v = (f) => cli(["referral", "--dir", verifier, "--verify", f]);
  let r = await v(file); assert.equal(r.code, 3); assert.match(r.out, /not registered/);
  state.entry = entry({ endpoint: "https://host.example.org", operator: doc.operator, active: true });
  r = await v(file); assert.equal(r.code, 0, r.all); assert.match(r.out, /verified: the registered operator/);
  const forged = path.join(d, "forged.json"); fs.writeFileSync(forged, JSON.stringify({ ...doc, code: "someone-else" }));
  r = await v(forged); assert.equal(r.code, 3); assert.match(r.out, /NOT VERIFIED: signed by/);
  state.entry = { ...state.entry, operator: "0x" + "99".repeat(20) };
  r = await v(file); assert.equal(r.code, 3); assert.match(r.out, /registered operator is 0x9999/);
});
