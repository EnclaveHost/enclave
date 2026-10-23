// The enclave CLI's independent mode (docs/network/independent-cli.md), end to end: the real CLI binary against real
// contracts on anvil (the ledger, catalog, pinned session factory, and the DEPLOYED schema-4 registry built from its exact
// historical source), through three scriptable RPC proxies. Every CLI process runs under a network guard that refuses and
// logs any connection that is not loopback, and a stand-in Enclave API that would answer records every hit: the tests
// require both to stay empty.
//
//   run: node --test test/cli-independent.test.mjs     (needs anvil, openssl and the Foundry build)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, startManagement, openSession, compileRegistrySchema4, KEYS, PUBLIC_MANAGEMENT } from "./helpers/cli-independent-rig.mjs";
import { REGISTRY_SCHEMA4_SOURCE, validateRpcOrigins, loadIndependentTrust } from "../cli/independent.mjs";
import { splitCborMetadata, solcCborMetadata } from "./helpers/solc-metadata.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY || path.join(REPO, "cli", "enclave.mjs");   // the staged bundle can be tested in place of the source
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const BOOK = "0x" + "ab".repeat(20);   // a mutable address book that must never be read
const skip = haveTools();
// node:test reports a test as "# SKIP" for ANY present skip option (even null), so the option is only set when the
// tools are really missing; every test is bounded so a stuck resource fails the test instead of holding the run.
const T = skip ? { skip, timeout: 120000 } : { timeout: 120000 };
let routeEnv = {};
let r, tmp, pinsFile, pins5File, netLog, sessionDir, session;

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-independent-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  pins5File = path.join(tmp, "pins-schema5.json");
  fs.writeFileSync(pins5File, JSON.stringify({ ...r.pins, contracts: { ...r.pins.contracts, registry: r.addresses.registry5.toLowerCase() } }));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// The CLI reads at a CONFIRMED block (--confirmations 1 here): anything the rig just wrote is mined over first, as time would.
async function cli(args, opts = {}) { await r.mine(); await r.mine(); return run(args, opts); }
function run(args, { key = KEYS.owner, extra = {}, independent = true, pins = pinsFile } = {}) {
  const base = independent ? ["--independent", "--contract-pins", pins, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1", "--yes"] : [];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessionDir,
      ...(key ? { ENCLAVE_KEY: key } : {}), ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: BOOK,
      NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort), ...routeEnv, ...extra } });
    let out = "", err = "";
    // a CLI process that does not finish in time is killed and reported, never left holding the run
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 90 s]"; p.kill("SIGKILL"); }, 90000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => clearTimeout(killer) || resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
  });
}
const sends = () => r.rpcLog.filter((x) => x.method === "eth_sendRawTransaction").length;
function noEnclave() {
  assert.deepEqual(r.apiHits, [], "the stand-in Enclave API was called");
  assert.equal(fs.readFileSync(netLog, "utf8"), "", "a non-loopback or Enclave connection was attempted");
  assert.equal(r.rpcLog.filter((x) => x.to === BOOK).length, 0, "the mutable address book was read");
}
const ledgerGet = (id) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
const reset = () => { for (const k of Object.keys(r.rpcModes)) delete r.rpcModes[k]; };

test("the registry under test is the deployed schema-4 executable: the published (history-rewritten) fixture is tied to the pinned original, and compiles to the deployed runtime once the deployed CBOR metadata replaces its own", T, () => {
  const src = fs.readFileSync(path.join(REPO, "test/fixtures/registry-schema4/EnclaveRegistry.sol"));
  const prov = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/registry-schema4/PROVENANCE.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/source-verification-base.json"), "utf8"));
  // the published bytes are exactly the recorded rewritten copy; its original is exactly the manifest's pinned build source
  assert.equal(createHash("sha256").update(src).digest("hex"), prov.published.sha256);
  assert.equal(createHash("sha1").update(`blob ${src.length}\0`).update(src).digest("hex"), prov.published.gitBlob);
  const pin = manifest.builds["registry-schema4"];
  assert.deepEqual([prov.original.commit, prov.original.gitBlob, prov.original.sha256], [pin.commit, pin.sources["EnclaveRegistry.sol"].gitBlob, pin.sources["EnclaveRegistry.sol"].sha256]);
  assert.deepEqual([REGISTRY_SCHEMA4_SOURCE.commit, REGISTRY_SCHEMA4_SOURCE.gitBlob, REGISTRY_SCHEMA4_SOURCE.sha256], [pin.commit, pin.sources["EnclaveRegistry.sol"].gitBlob, pin.sources["EnclaveRegistry.sol"].sha256]);
  assert.notEqual(prov.published.sha256, pin.sources["EnclaveRegistry.sol"].sha256, "the published file is NOT the deployed source text; it is its comment-only rewrite");
  // no immutables: the published file's executable bytes + the DEPLOYED metadata (its published hash, the pinned compiler)
  // ARE the live registry's runtime, byte for byte; the published text's own metadata differs (it hashes other comments)
  const { runtime } = compileRegistrySchema4();
  const { code, tail } = splitCborMetadata(runtime);
  const deployedTail = solcCborMetadata(manifest.contracts.registry.metadataIpfs, manifest.compiler.version);
  assert.equal(code.length + deployedTail.length, manifest.contracts.registry.runtimeBytes);
  assert.equal(keccak256(`0x${Buffer.concat([code, deployedTail]).toString("hex")}`), manifest.contracts.registry.codeHash);
  assert.equal(manifest.contracts.registry.codeHash, "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518");
  assert.notEqual(tail.toString("hex"), deployedTail.toString("hex"));
  assert.notEqual(keccak256(runtime), manifest.contracts.registry.codeHash, "the rewritten text alone does not claim the deployed bytecode");
});

test("trust inputs: explicit, distinct RPC origins and a reviewed profile only with its digest", T, () => {
  assert.throws(() => validateRpcOrigins(["https://a.example"]), /2 to 8/);
  assert.throws(() => validateRpcOrigins(["http://rpc.example", "https://b.example"]), /must be HTTPS/);
  assert.throws(() => validateRpcOrigins(["https://a.example/x", "https://a.example/y"]), /distinct hosts/);
  assert.throws(() => validateRpcOrigins(["https://u:p@a.example", "https://b.example"]), /credentials/);
  assert.equal(validateRpcOrigins(["http://127.0.0.1:1", "http://127.0.0.1:2"]).length, 2);
  const profile = path.join(REPO, "contracts/deployments/network-profile-base.json");
  assert.throws(() => loadIndependentTrust({ profileFile: profile, rpcs: r.rpcs }), /--profile-digest/);
  assert.throws(() => loadIndependentTrust({ profileFile: profile, profileDigest: "sha256:" + "0".repeat(64), rpcs: r.rpcs }), /digest mismatch/);
  const t = loadIndependentTrust({ profileFile: profile, profileDigest: "sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8", rpcs: r.rpcs });
  assert.equal(t.pins.registry, "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac");
  assert.equal(t.usdc.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.throws(() => loadIndependentTrust({ profileFile: profile, profileDigest: t.digest, rpcs: r.rpcs, contractPins: r.pins.contracts }), /differs from the reviewed profile/);
});

test("a wrong profile digest is refused before any RPC request", T, async () => {
  const before = r.rpcLog.length;
  const x = await cli(["ls", "--profile", path.join(REPO, "contracts/deployments/network-profile-base.json"), "--profile-digest", "sha256:" + "1".repeat(64),
    "--rpc", r.rpcs.join(",")], { independent: false });
  assert.equal(x.code, 1); assert.match(x.err, /digest mismatch/);
  assert.equal(r.rpcLog.length, before);
  noEnclave();
});

test("ls: the wallet's records at one agreed block; an empty answer and a failed read are different", T, async () => {
  const a = r.createdId(await r.create(KEYS.owner)), b = r.createdId(await r.create(KEYS.owner));
  const theirs = r.createdId(await r.create(KEYS.other));
  const x = await cli(["ls", "--json"]);
  assert.equal(x.code, 0, x.err);
  assert.deepEqual(x.json.deployments.map((d) => d.id).sort(), [a, b].sort());
  assert.ok(!x.json.deployments.some((d) => d.id === theirs));
  assert.ok(x.json.agreeing >= 2 && x.json.quorum === 2 && /^0x[0-9a-f]{64}$/.test(x.json.blockHash));
  assert.equal(x.json.deployments.every((d) => d.status === "unfunded"), true);
  const empty = await cli(["ls", "--owner", "0x" + "12".repeat(20), "--json"]);
  assert.equal(empty.code, 0, empty.err); assert.deepEqual(empty.json.deployments, []);
  for (const i of [0, 1, 2]) r.rpcModes[i] = "down";
  const down = await cli(["ls"]);
  reset();
  assert.equal(down.code, 1); assert.match(down.err, /chain quorum unavailable: 0 of 3/);
  assert.doesNotMatch(down.out, /\(none\)/);
  noEnclave();
});

test("quorum: one lying, dead or wrong-chain RPC is outvoted; with too few honest peers the read is refused", T, async () => {
  const mine = (await cli(["ls", "--json"])).json.deployments.map((d) => d.id).sort();
  for (const mode of ["lie", "down", "wrongchain"]) {
    r.rpcModes[0] = mode;
    const x = await cli(["ls", "--json"]);
    assert.equal(x.code, 0, `${mode}: ${x.err}`);
    assert.deepEqual(x.json.deployments.map((d) => d.id).sort(), mine, mode);
    reset();
  }
  r.rpcModes[0] = "lie";
  const strict = await cli(["ls", "--quorum", "3"]);
  assert.equal(strict.code, 1); assert.match(strict.err, /no 3 RPCs agreed|different answers/);
  r.rpcModes[1] = "down";
  const two = await cli(["ls"]);
  assert.equal(two.code, 1); assert.match(two.err, /no 2 RPCs agreed|quorum unavailable/);
  reset();
  r.rpcModes[0] = "wrongchain";
  const chain3 = await cli(["ls", "--quorum", "3"]);
  reset();
  assert.equal(chain3.code, 1); assert.match(chain3.err, /quorum unavailable: 2 of 3/); assert.match(chain3.err, /wrong chain/);
  noEnclave();
});

test("hosts and pricing come from the deployed schema-4 registry; schema 5 and relay/capability options are refused", T, async () => {
  const h = await cli(["hosts", "--json"]);
  assert.equal(h.code, 0, h.err);
  assert.equal(h.json.registrySchema, 4);
  assert.equal(h.json.hosts.length, 1);
  assert.equal(h.json.hosts[0].id, r.runner); assert.equal(h.json.hosts[0].endpoint, r.endpoint);
  assert.equal(h.json.hosts[0].operator, r.operator.toLowerCase());
  const p = await cli(["pricing", "--json"]);
  assert.equal(p.code, 0, p.err); assert.equal(p.json.cheapestNodePerSec6, "1000"); assert.equal(p.json.cheapestCardPerSec6, null);
  for (const flag of [["--relays"], ["--caps"], ["--region", "eu"]]) {
    const x = await cli(["hosts", ...flag]);
    assert.equal(x.code, 1); assert.match(x.err, /schema 4.*registerRelay/);
  }
  const five = await cli(["hosts"], { pins: pins5File });
  assert.equal(five.code, 1); assert.match(five.err, /reports schema 5/);
  // availability reads hosts' signed capacity records, bound to the reviewed registry CODE: explicit pins carry no code hash
  const avail = await cli(["availability"]);
  assert.equal(avail.code, 1); assert.match(avail.err, /reviewed registry code: run it with --profile/);
  noEnclave();
});

test("deploy, fund, rate-cap, stop and resume: preconditions agreed, one signature each, receipts confirmed by quorum", T, async () => {
  const s0 = sends();
  const d = await cli(["deploy", "hello:1", "--cpu", "0.1", "--gpu", "0", "--prepare-only", "--json"]);
  assert.equal(d.code, 0, d.err + d.out);
  const id = d.out.match(/created (0x[0-9a-f]{64})/)[1];
  let rec = await ledgerGet(id);
  assert.equal(rec.owner, privateKeyToAccount(KEYS.owner).address);
  assert.equal(rec.appRef, r.appRef);
  assert.equal(sends() - s0, 3, "one signed transaction, broadcast once to each of the three RPCs");
  // the ceiling came from the cheapest live registry host: $0.001/s per node x 10% = 100 USDC-6dp/s
  const cap = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "capOf", args: [id] });
  assert.equal(cap, 100n);
  const f = await cli(["fund", id, "--usdc", "1", "--json"]);
  assert.equal(f.code, 0, f.err); assert.equal(f.json.balance6, "1000000");
  const rc = await cli(["rate-cap", id, "0.72", "--json"]);
  assert.equal(rc.code, 0, rc.err);
  assert.equal(await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "capOf", args: [id] }), 200n);
  const st = await cli(["stop", id, "--json"]);
  assert.equal(st.code, 0, st.err); assert.equal(st.json.status, "stopped");
  assert.equal((await ledgerGet(id)).active, false);
  const re = await cli(["resume", id]);
  assert.equal(re.code, 0, re.err);
  assert.equal((await ledgerGet(id)).active, true);
  noEnclave();
});

test("status: the record, its lease and the runner's schema-4 registry entry at one block", T, async () => {
  const id = r.createdId(await r.create(KEYS.owner));
  assert.equal((await cli(["fund", id, "--usdc", "1"])).code, 0);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await r.mine(); await r.mine();
  const x = await cli(["status", id, "--json"]);
  assert.equal(x.code, 0, x.err);
  assert.equal(x.json.status, "claimed");
  assert.equal(x.json.lease.runner, r.runner);
  assert.equal(x.json.runnerHost.endpoint, r.endpoint);
  assert.equal(x.json.runnerHost.operatorMatches, true);
  assert.ok(x.json.agreeing >= 2);
  const missing = await cli(["status", "0x" + "77".repeat(32)]);
  assert.equal(missing.code, 1); assert.match(missing.err, /no deployment .* on the pinned ledger/);
  noEnclave();
});

test("whoami, apps, resize and refund work from the quorum alone", T, async () => {
  const w = await cli(["whoami", "--json"]);
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json.address, privateKeyToAccount(KEYS.owner).address);
  assert.ok(BigInt(w.json.usdc6) > 0n); assert.equal(w.json.running, null);
  const a = await cli(["apps", "--json"]);
  assert.equal(a.code, 0, a.err); assert.match(a.out, /"slug": "hello"/);
  const id = r.createdId(await r.create(KEYS.owner));
  assert.equal((await cli(["fund", id, "--usdc", "1"])).code, 0);
  const rz = await cli(["resize", id, "--cpu", "0.2", "--gpu", "0", "--json"]);
  assert.equal(rz.code, 0, rz.err + rz.out);
  assert.match(rz.out, /share floors are not checked here/);
  assert.equal(Number((await ledgerGet(id)).cpuMilli), 200);
  assert.equal(rz.json?.ratePerSec6 ?? JSON.parse(rz.out.slice(rz.out.indexOf("{"))).ratePerSec6, "200");   // 0.2 node at the cheapest live $0.001/s
  const rf = await cli(["refund", id, "--json"]);
  assert.equal(rf.code, 0, rf.err + rf.out);
  const after = await ledgerGet(id);
  assert.equal(after.active, false);
  noEnclave();
});

test("a transaction whose answers are all lost is reported outcome-unknown and never resent", T, async () => {
  const id = r.createdId(await r.create(KEYS.owner));
  for (const i of [0, 1, 2]) r.rpcModes[i] = "blackhole-send";
  const s0 = sends();
  const x = await cli(["stop", id]);
  reset();
  assert.notEqual(x.code, 0);
  assert.match(x.err, /outcome is UNKNOWN/); assert.match(x.err, /Do not resend/);
  assert.equal(sends() - s0, 3, "the same signed bytes went once to each RPC; nothing was re-signed or resent");
  await r.mine(); await r.mine();
  assert.equal((await ledgerGet(id)).active, false, "it did reach the chain: exactly the case that must not be retried");
  noEnclave();
});

test("a record that changed hands is refused before anything is signed", T, async () => {
  const id = r.createdId(await r.create(KEYS.owner));
  const t = await cli(["transfer", id, privateKeyToAccount(KEYS.other).address]);
  assert.equal(t.code, 0, t.err + t.out);
  const s0 = sends();
  const x = await cli(["stop", id]);
  assert.equal(x.code, 1); assert.match(x.err, /owned by .*not this key; nothing was sent/);
  assert.equal(sends(), s0);
  const u = await cli(["rate-cap", id, "1"]);
  assert.equal(u.code, 1); assert.equal(sends(), s0);
  noEnclave();
});

test("hosted-only commands, session relaying and an external signer are refused in independent mode", T, async () => {
  // move is an independent command now (test/cli-independent-move.test.mjs), but only toward a registry host id, never a name
  for (const [args, re] of [[["secrets", "list", "0x" + "11".repeat(32)]], [["move", "0x11111111", "box"], /registry host id.*no host names/]]) {
    const x = await cli(args);
    assert.equal(x.code, 1); assert.match(x.err, re || /not available in independent mode/);
  }
  // sign-in is an independent command now (cli/independent-login.mjs, test/cli-combined-independent.test.mjs): without the
  // frontend the owner reviewed it refuses before anything is made or sent; `account` reports the local state
  const li = await cli(["login"]);
  assert.equal(li.code, 1); assert.match(li.err, /name the frontend you approve sessions on: --frontend/);
  const ac = await cli(["account"]);
  assert.equal(ac.code, 0, ac.err); assert.match(ac.out, /account: none yet/);
  // Intended behaviour: `session new` is a SUPPORTED independent command (the owner signs the grant for the pinned factory;
  // it is exercised end to end in test/cli-independent-sessions.test.mjs). What must refuse is a grant with no owner to
  // sign it, and the subcommands that exist only through the hosted relayer.
  const s0 = r.rpcLog.filter((x) => x.method === "eth_sendRawTransaction").length;
  const nobody = await cli(["session", "new", "--preset", "auth-only"], { key: null });
  assert.equal(nobody.code, 1); assert.match(nobody.err, /name the owner wallet: --owner ADDRESS/);
  assert.doesNotMatch(nobody.err, /hosted sessions relayer/);
  assert.equal(r.rpcLog.filter((x) => x.method === "eth_sendRawTransaction").length, s0, "no grant was signed or sent");
  // resume-wait and top-up-link are watched on chain now (no relayer): each refuses precisely without its inputs
  for (const [sub, re] of [["resume-wait", /./], ["top-up-link", /--amount/]]) {
    const sn = await cli(["session", sub, "x"]);
    assert.equal(sn.code, 1); assert.match(sn.err, re); assert.doesNotMatch(sn.err, /hosted sessions relayer/);
  }
  const sg = await cli(["ls", "--signer", "http://127.0.0.1:1"]);
  assert.equal(sg.code, 1); assert.match(sg.err, /--signer/);
  noEnclave();
});

test("sessions and owner management: inspect on chain, then status, logs, restart, app token, CPU profile and GPU through the signed host endpoint", T, async () => {
  session = await openSession(r, { sessionDir });
  const insp = await cli(["session", "inspect", "--json"]);
  assert.equal(insp.code, 0, insp.err);
  assert.equal(insp.json.state, "live"); assert.equal(insp.json.vault, session.vault.toLowerCase());
  assert.ok(["api.status", "api.logs", "api.restart", "api.appAccess"].every((a) => insp.json.actions.includes(a)));
  // a vault-held production deployment, funded by the wallet (explicitly: a session is active) and claimed by the host
  const id = await session.createViaVault();
  assert.equal((await cli(["fund", id, "--usdc", "1", "--wallet"])).code, 0);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await r.mine(); await r.mine();
  const m = await startManagement(r, { id, dir: tmp });
  // the signed record names a public literal address; only this test maps exactly that address to the local gateway
  assert.equal(m.record.address, PUBLIC_MANAGEMENT.address);
  const routeLog = path.join(tmp, "route.log");
  routeEnv = { ENCLAVE_TEST_ROUTE: m.route, ENCLAVE_TEST_ROUTE_LOG: routeLog };
  const mg = ["--directories", m.directoryOrigin, "--state-dir", path.join(tmp, "mstate")];
  const st = await cli(["status", id, "--host", "--json", ...mg]);
  assert.equal(st.code, 0, st.err); assert.equal(st.json.hostReported.status, "running"); assert.equal(st.json.status, "claimed");
  const logs = await cli(["logs", id, "--tail", "50", ...mg]);
  assert.equal(logs.code, 0, logs.err); assert.match(logs.out, /line two/);
  const rs = await cli(["restart", id, "--json", ...mg]);
  assert.equal(rs.code, 0, rs.err); assert.equal(rs.json.outcome, "succeeded"); assert.equal(m.restarts(), 1);
  const tokFile = path.join(tmp, "app-token");
  const tk = await cli(["app-token", id, "--out", tokFile, "--json", ...mg]);
  assert.equal(tk.code, 0, tk.err); assert.equal(fs.readFileSync(tokFile, "utf8").trim(), "app-origin-token");
  assert.equal(fs.statSync(tokFile).mode & 0o777, 0o600); assert.doesNotMatch(tk.out + tk.err, /app-origin-token/);
  const cp = await cli(["cpu-profile", "start", id, "--seconds", "5", "--json", ...mg]);
  assert.equal(cp.code, 0, cp.err); assert.equal(cp.json.outcome, "succeeded");
  const cg = await cli(["cpu-profile", "get", id, "--out", path.join(tmp, "prof"), "--json", ...mg]);
  assert.equal(cg.code, 0, cg.err); assert.equal(cg.json.bytes, 4);
  // gpu: the CURRENT host of this deployment (from its lease), host-reported capacity only; CPU-only is an answer, not an error
  const gp = await cli(["gpu", id, "--json", ...mg]);
  assert.equal(gp.code, 0, gp.err); assert.equal(gp.json.hostReported, true); assert.equal(gp.json.gpu.capacity.gpuShareFree, 0.5);
  assert.equal(gp.json.runner.toLowerCase(), r.runner.toLowerCase());
  const gh = await cli(["gpu", id, ...mg]);
  assert.equal(gh.code, 0, gh.err); assert.match(gh.out, /gpu free\s+50% \(40 GB vram, 66 SMs\)/); assert.match(gh.out, /not an attestation and not a reservation/);
  m.mode.gpu = "none";
  const cpuOnly = await cli(["gpu", id, ...mg]);
  assert.equal(cpuOnly.code, 0, cpuOnly.err); assert.match(cpuOnly.out, /current host reports no GPU/);
  m.mode.gpu = undefined;
  const noId = await cli(["gpu", ...mg]);
  assert.equal(noId.code, 1); assert.match(noId.err, /usage: enclave gpu <deployment-id>/);
  // host attestation documents are never a pass; app attestation needs the native client's own SNP verification
  const hr = await cli(["attest", id, "--host-report", ...mg]);
  assert.equal(hr.code, 3); assert.match(hr.out, /NOT VERIFIED/);
  const bare = await cli(["attest", id]);
  assert.equal(bare.code, 1); assert.match(bare.err, /--native-profile/);
  const np = path.join(tmp, "native.json");
  fs.writeFileSync(np, JSON.stringify({ version: 1, deploymentId: "0x" + "99".repeat(32) }));
  const nat = await cli(["attest", id, "--native-profile", np]);
  assert.equal(nat.code, 1); assert.match(nat.out + nat.err, /different deployment/);
  // a lost restart answer: exit 4, exactly one restart reached the supervisor, nothing resent
  m.mode.restart = "drop";
  const lost = await cli(["restart", id, ...mg]);
  assert.equal(lost.code, 4, lost.err); assert.match(lost.err, /outcome is unknown/);
  assert.equal(m.restarts(), 2);
  m.mode.restart = undefined;
  // a deployment this session's vault does not hold, then an ended session: refused before the host is contacted
  const theirs = r.createdId(await r.create(KEYS.other));
  const g0 = m.gatewayRequests();
  const foreign = await cli(["status", theirs, "--host", ...mg]);
  assert.equal(foreign.code, 1); assert.match(foreign.err, /not by this session's vault/);
  const foreignGpu = await cli(["gpu", theirs, ...mg]);
  assert.equal(foreignGpu.code, 1); assert.match(foreignGpu.err, /not by this session's vault/);
  await session.ownerOp({ op: "revokeAll", withdraw: false });
  await r.mine(); await r.mine();
  const ended = await cli(["logs", id, ...mg]);
  assert.equal(ended.code, 1); assert.match(ended.err, /is not live/);
  const after = await cli(["session", "inspect", "--json"]);
  assert.equal(after.json.live, false); assert.match(after.json.state, /revoked/);
  assert.equal(m.gatewayRequests(), g0, "no request reached the host gateway after the refusals");
  // every management connection dialed exactly the record's signed public address (then mapped by the test guard)
  const routes = fs.readFileSync(routeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(routes.length >= 10);
  assert.ok(routes.every((x) => x.from === `${PUBLIC_MANAGEMENT.address}:${PUBLIC_MANAGEMENT.port}`));
  routeEnv = {};
  noEnclave();
});

test("hosted mode is unchanged: hosts needs --independent and the independent flags need it too", T, async () => {
  const offline = { ENCLAVE_ADDRESS_BOOK: "", ENCLAVE_RPC: "http://127.0.0.1:1" };
  const h = await cli(["hosts"], { independent: false, extra: offline });
  assert.equal(h.code, 1); assert.match(h.err, /--independent/);
  const q = await cli(["ls", "--quorum", "2"], { independent: false, extra: offline });
  assert.equal(q.code, 1); assert.match(q.err, /add --independent/);
});
