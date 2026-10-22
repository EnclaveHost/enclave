// `enclave --independent move` between two hosts of the SAME operator on the ledger rev-17 CANDIDATE
// (test/fixtures/lease17-candidate.json; work/lease-generation-interface.txt §6), end to end: the real CLI, the real
// management gateways, the ACTUAL supervisor.js as the source, a stand-in target whose claim is a real claim() from the
// same operator key. Same-operator moves need BOTH deploymentsSchema() >= 17 AND guardedReleaseOnly(sourceOperator) at
// ONE agreed block; the opt-in is the operator's own transaction (`host guarded-release on`).
//   1  refused before the opt-in, nothing sent        2  the operator opts in (read back; an unnamed release now reverts)
//   3  the move: releaseLease by the actual supervisor, quorum, the same-key target claims; refund and generations
//   4  an unavailable quorum refuses before anything   5  a reviewed profile whose ledger code differs refuses; the matching
//   6  opt-out: refused again                              profile is accepted
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, toBytes, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, startManagement, startActualHost, openSession, KEYS, PUBLIC_MANAGEMENT } from "./helpers/cli-independent-rig.mjs";
import { anyReleaseTxs, leaseOf } from "./helpers/move-release-rig.mjs";
import { encodeProfile, profileDigest } from "../network/authority-profile.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const SAME_ENDPOINT = "https://same-operator.lease17.test", SAME = keccak256(toBytes(SAME_ENDPOINT));
const SAME_PUBLIC = Object.freeze({ address: "8.8.8.8", port: 8443 });
const TOKEN = "7c".repeat(32);
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, pinsFile, netLog, sessionDir, routeEnv = {}, id, srcHost, src, tgt, mg;
const operator = privateKeyToAccount(KEYS.operator).address;

before(async () => {
  if (skip) return;
  r = await startRig({ ledgerRev: 17 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-move17-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
  // the target: a SECOND registry entry of the SAME operator key
  await r.write(r.wc(KEYS.operator), r.addresses.registry, r.A.registry4.abi, "register", [SAME_ENDPOINT, "independent/host", "0x" + "00".repeat(32), 2000n, 0n,
    "0x0000000000000000000000000000000000000000"]);
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

async function cli(args, { key = KEYS.owner, auth = ["--contract-pins", pinsFile] } = {}) {
  await r.mine(); await r.mine();
  const base = ["--independent", ...auth, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1", "--yes"];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessionDir, ...(key ? { ENCLAVE_KEY: key } : {}),
      ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20), NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog,
      ENCLAVE_TEST_DENY_PORT: String(r.apiPort), ...routeEnv } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 180 s]"; p.kill("SIGKILL"); }, 180000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, all: out + err }); });
  });
}
const noEnclave = () => {
  assert.equal(r.apiHits.length, 0, "the stand-in Enclave API was never called");
  assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");
};
const guarded = (who = operator) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "guardedReleaseOnly", args: [who] });
/** A reviewed profile for THIS chain: the Base profile with every rig contract's address substituted wherever it appears
 *  (so its cross-references stay consistent), and the code hashes of the ledger, registry and factory as given. */
async function rigProfile({ deploymentsCodeHash } = {}) {
  const REAL = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/network-profile-base.json"), "utf8"));
  const map = { deployments: r.addresses.ledger, registry: r.addresses.registry, usdc: r.addresses.usdc, appCatalog: r.addresses.catalog,
    sessionVaultFactory: r.addresses.factory, paymentRouter: r.addresses.router };
  let text = JSON.stringify(REAL);
  for (const [k, a] of Object.entries(map)) text = text.split(REAL.contracts[k].address).join(a.toLowerCase());
  const p = JSON.parse(text);
  const codeHash = async (a) => keccak256(await r.pc.getCode({ address: a }));
  p.contracts.deployments.codeHash = deploymentsCodeHash || await codeHash(r.addresses.ledger);
  p.contracts.deployments.immutable.deploymentsSchema = "17";
  p.contracts.registry.codeHash = await codeHash(r.addresses.registry);
  p.contracts.sessionVaultFactory.codeHash = await codeHash(r.addresses.factory);
  const bytes = encodeProfile(p), file = path.join(tmp, `profile-${Date.now()}.json`);
  fs.writeFileSync(file, bytes);
  return ["--profile", file, "--profile-digest", profileDigest(bytes)];
}

test("1: a same-operator move on rev 17 is refused until the operator opts in; nothing is signed or sent", T, async () => {
  const s = await openSession(r, { sessionDir, actions: ["api.status", "api.restart", "api.placement"] });
  id = await s.createViaVault();
  assert.equal((await cli(["fund", id, "--usdc", "2", "--wallet"])).code, 0);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await r.mine(); await r.mine();
  const d = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
  srcHost = await startActualHost(r, { id, owner: s.vault, dir: fs.mkdtempSync(path.join(tmp, "src-host-")), token: TOKEN, leaseUntil: d.leaseUntil });
  src = await startManagement(r, { id, dir: fs.mkdtempSync(path.join(tmp, "src-")), upstream: srcHost.upstream, upstreamToken: TOKEN, gateway: { recheckMs: 100 } });
  tgt = await startManagement(r, { id, dir: fs.mkdtempSync(path.join(tmp, "tgt-")), host: { runner: SAME, key: KEYS.operator, endpoint: SAME_ENDPOINT },
    address: SAME_PUBLIC, gateway: { recheckMs: 100 } });
  routeEnv = { ENCLAVE_TEST_ROUTE: `${src.route},${tgt.route}` };
  mg = ["--directories", `${src.directoryOrigin},${tgt.directoryOrigin}`, "--state-dir", path.join(tmp, "mstate")];
  assert.equal(await guarded(), false);
  const g0 = src.gatewayRequests() + tgt.gatewayRequests();
  const x = await cli(["move", id, SAME, ...mg]);
  assert.equal(x.code, 1, x.all);
  assert.match(x.err, /is run by the same operator .*This ledger \(deploymentsSchema 17\) can name the lease a release ends, but at block \d+ that operator has not turned on guarded-release-only \(guardedReleaseOnly = false\)/);
  assert.match(x.err, /nothing was sent/);
  assert.equal(src.gatewayRequests() + tgt.gatewayRequests(), g0, "no host was contacted");
  assert.equal((await leaseOf(r, id))[3], 1n);
  noEnclave();
});

test("2: the operator opts in with its own key (host guarded-release on), read back on the quorum; an unnamed release from that key now reverts", T, async () => {
  const x = await cli(["host", "guarded-release", "on"], { key: KEYS.operator });
  assert.equal(x.code, 0, x.all);
  assert.match(x.out, /operator 0x[0-9a-f]{40} signs for 2 registered host\(s\)/);
  assert.match(x.out, new RegExp(SAME_ENDPOINT.replace(/[.]/g, "\\.")));
  assert.match(x.out, /✓ guarded-release-only on for 0x[0-9a-f]{40} \(tx 0x[0-9a-f]{64}; read back at block \d+/);
  assert.equal(await guarded(), true);
  await assert.rejects(r.pc.simulateContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "release", args: [id], account: operator }),
    /guarded release only/, "release(id) from the opted-in key reverts");
  const again = await cli(["host", "guarded-release", "on"], { key: KEYS.operator });
  assert.equal(again.code, 0); assert.match(again.out, /already on/);
  // someone else cannot opt the operator in or out: the flag is per-sender
  const other = await cli(["host", "guarded-release", "on"], { key: KEYS.other });
  assert.equal(other.code, 0, other.all);
  assert.equal(await guarded(privateKeyToAccount(KEYS.other).address), true); assert.equal(await guarded(), true);
  noEnclave();
});

test("3: the same-operator move: the actual supervisor releases with releaseLease, the quorum confirms, the same-key target claims; refund and generations", T, async () => {
  const from = await r.pc.getBlockNumber({ cacheTime: 0 }), before = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
  const x = await cli(["move", id, SAME, ...mg]);
  assert.equal(x.code, 0, x.all);
  assert.match(x.out, /same operator 0x[0-9a-f]{40}: allowed at block \d+: the ledger \(deploymentsSchema 17\) names the lease each release ends/);
  assert.match(x.out, /the source reports the lease released \(0x[0-9a-f]{64}\)/);
  assert.match(x.out, /lease released \(quorum, block \d+\)/);
  assert.match(x.out, /running on 0x[0-9a-f]{8}… now \(quorum, block \d+\)/);
  const rel = await anyReleaseTxs(r, from, { id });
  assert.deepEqual(rel.map((t) => [t.kind, t.runner.toLowerCase(), t.generation, t.success]), [["releaseLease", r.runner.toLowerCase(), 1n, true]],
    "the source named exactly its lease; no unnamed release(id)");
  const lease = await leaseOf(r, id);
  assert.deepEqual([lease[0].toLowerCase(), lease[1].toLowerCase(), lease[3]], [SAME.toLowerCase(), operator.toLowerCase(), 2n], "the target holds generation 2");
  const ev = parseEventLogs({ abi: r.A.ledger.abi, logs: await r.pc.getLogs({ address: r.addresses.ledger, fromBlock: from, toBlock: "latest" }) })
    .filter((e) => String(e.args.id || "").toLowerCase() === id.toLowerCase());
  const released = ev.filter((e) => e.eventName === "Released"), opened = ev.filter((e) => e.eventName === "LeaseOpened");
  assert.equal(released.length, 1); assert.ok(released[0].args.refunded6 > 0n, "the unused tail went back to the balance");
  assert.deepEqual(opened.map((e) => [e.args.enclaveId.toLowerCase(), e.args.generation]), [[SAME.toLowerCase(), 2n]]);
  const after = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
  assert.ok(after.rate > before.rate, "the target's price is in force for its lease");
  assert.match(srcHost.stdout(), new RegExp(`\\[release\\] ${id} releaseLease generation 1 1/4 signed`));
  assert.deepEqual(tgt.chainEffects, ["claim"]);
  noEnclave();
});

test("4: an unavailable quorum refuses the move before anything is sent", T, async () => {
  r.rpcModes[1] = "down"; r.rpcModes[2] = "down";
  try {
    const g0 = src.gatewayRequests() + tgt.gatewayRequests();
    const x = await cli(["move", id, r.runner, ...mg]);
    assert.notEqual(x.code, 0, x.all);
    assert.match(x.err, /quorum|agree|RPC/i);
    assert.equal(src.gatewayRequests() + tgt.gatewayRequests(), g0, "no host was contacted");
  } finally { r.rpcModes[1] = "ok"; r.rpcModes[2] = "ok"; }
});

test("5: a reviewed profile whose ledger code is not the deployed code refuses before any host or write; the matching profile passes that check", T, async () => {
  const wrong = await rigProfile({ deploymentsCodeHash: "0x" + "11".repeat(32) });
  const g0 = src.gatewayRequests() + tgt.gatewayRequests();
  const x = await cli(["move", id, r.runner, ...mg], { auth: wrong });
  assert.equal(x.code, 1, x.all); assert.match(x.err, /deployments at 0x[0-9a-fA-F]{40} does not carry the reviewed code/);
  const y = await cli(["host", "guarded-release", "off"], { key: KEYS.operator, auth: wrong });
  assert.equal(y.code, 1, y.all); assert.match(y.err, /does not carry the reviewed code/);
  assert.equal(await guarded(), true, "nothing was sent");
  assert.equal(src.gatewayRequests() + tgt.gatewayRequests(), g0);
  const right = await rigProfile();
  const z = await cli(["host", "guarded-release", "on"], { key: KEYS.operator, auth: right });
  assert.equal(z.code, 0, z.all); assert.match(z.err, /independent: reviewed profile sha256:/); assert.match(z.out, /already on/);
  noEnclave();
});

test("6: after the operator opts out, a same-operator move is refused again", T, async () => {
  const off = await cli(["host", "guarded-release", "off"], { key: KEYS.operator });
  assert.equal(off.code, 0, off.all); assert.equal(await guarded(), false);
  // the deployment now runs on SAME (operator key): moving it back to the rig's runner is again a same-operator move
  const x = await cli(["move", id, r.runner, ...mg]);
  assert.equal(x.code, 1, x.all); assert.match(x.err, /guardedReleaseOnly = false/);
  noEnclave();
});
