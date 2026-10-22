// `enclave --independent move` end to end (work/independent-move-interface.txt), on a local anvil chain with the real
// ledger, the deployed schema-4 registry and the pinned session factory:
//   - the SOURCE host is the ACTUAL supervisor.js (unmodified) behind the real management gateway: it stops the app,
//     sends the real runner-only release() and answers only after the ledger no longer names it;
//   - the TARGET host is a stand-in behind its own gateway and operator-signed record: its signed claimHint sends the
//     real claim() from its own registry operator;
//   - the CLI confirms every release on its own quorum before hinting, and reports placement from the quorum only.
// No relay, fleet list, unauthenticated hint, address book or Enclave API is used (the network guard proves it).
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY || path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const BOOK = "0x" + "ab".repeat(20);
const TARGET_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";   // anvil #4: the target host's operator
const TARGET_ENDPOINT = "https://target.independent.test", TARGET = keccak256(toBytes(TARGET_ENDPOINT));
const TARGET_PUBLIC = Object.freeze({ address: "8.8.8.8", port: 8443 });
const TOKEN = "7c".repeat(32);
const skip = haveTools();
const T = skip ? { skip, timeout: 180000 } : { timeout: 180000 };
let r, tmp, pinsFile, netLog, sessionDir, routeEnv = {}, id, src, srcHost, tgt, mg, routeLog;

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-move-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
  // the target: a second open-registration host on the schema-4 registry, at twice the source's price
  await r.write(r.wc(TARGET_KEY), r.addresses.registry, r.A.registry4.abi, "register", [TARGET_ENDPOINT, "independent/host", "0x" + "00".repeat(32), 2000n, 0n,
    "0x0000000000000000000000000000000000000000"]);
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

async function cli(args, opts = {}) { await r.mine(); await r.mine(); return run(args, opts); }
function run(args, { key = KEYS.owner } = {}) {
  const base = ["--independent", "--contract-pins", pinsFile, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1", "--yes"];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessionDir,
      ...(key ? { ENCLAVE_KEY: key } : {}), ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: BOOK,
      NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort), ...routeEnv } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 150 s]"; p.kill("SIGKILL"); }, 150000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
}
const get = (x) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [x] });
const noEnclave = () => {
  assert.equal(r.apiHits.length, 0, "the stand-in Enclave API was never called");
  assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");
};
const ledgerEvents = async (fromBlock) => parseEventLogs({ abi: r.A.ledger.abi,
  logs: await r.pc.getLogs({ address: r.addresses.ledger, fromBlock, toBlock: "latest" }) });

test("move: refused before anything is signed or sent (scope, target, reachability, usage)", T, async () => {
  // a session WITHOUT api.placement first: a move needs both api.restart and api.placement
  const narrow = await openSession(r, { sessionDir, actions: ["api.status", "api.restart"] });
  id = await narrow.createViaVault();
  assert.equal((await cli(["fund", id, "--usdc", "1", "--wallet"])).code, 0);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await r.mine(); await r.mine();
  const d = await get(id);
  srcHost = await startActualHost(r, { id, owner: narrow.vault, dir: fs.mkdtempSync(path.join(tmp, "src-host-")), token: TOKEN, leaseUntil: d.leaseUntil });
  // the source gateway re-authorizes every 100 ms: a release's answer must still arrive (reauthorize: false)
  src = await startManagement(r, { id, dir: fs.mkdtempSync(path.join(tmp, "src-")), upstream: srcHost.upstream, upstreamToken: TOKEN, gateway: { recheckMs: 100 } });
  tgt = await startManagement(r, { id, dir: fs.mkdtempSync(path.join(tmp, "tgt-")), host: { runner: TARGET, key: TARGET_KEY, endpoint: TARGET_ENDPOINT },
    address: TARGET_PUBLIC, gateway: { recheckMs: 100 } });
  routeLog = path.join(tmp, "route.log");
  routeEnv = { ENCLAVE_TEST_ROUTE: `${src.route},${tgt.route}`, ENCLAVE_TEST_ROUTE_LOG: routeLog };
  mg = ["--directories", `${src.directoryOrigin},${tgt.directoryOrigin}`, "--state-dir", path.join(tmp, "mstate")];
  const g0 = src.gatewayRequests() + tgt.gatewayRequests();
  const noScope = await cli(["move", id, TARGET, ...mg]);
  assert.equal(noScope.code, 1); assert.match(noScope.err, /lacks the api\.placement scope; nothing was sent/);
  // the session with placement (the same vault); every further refusal still sends nothing
  await openSession(r, { sessionDir, actions: ["api.status", "api.restart", "api.placement"] });
  const unknownHost = await cli(["move", id, "0x" + "77".repeat(32), ...mg]);
  assert.equal(unknownHost.code, 1); assert.match(unknownHost.err, /not an active, priced host on the pinned registry/);
  const unreachable = await cli(["move", id, TARGET, "--directories", src.directoryOrigin, "--state-dir", path.join(tmp, "mstate")]);
  assert.equal(unreachable.code, 1); assert.match(unreachable.err, /publishes no usable management endpoint.*nothing was sent/);
  const names = await cli(["move", id, "some-box", ...mg]);
  assert.equal(names.code, 1); assert.match(names.err, /registry host id/);
  assert.equal(src.gatewayRequests() + tgt.gatewayRequests(), g0, "no host was contacted");
  assert.equal((await get(id)).runner.toLowerCase(), r.runner.toLowerCase());
  noEnclave();
});

test("move: an unconfirmed stop releases nothing; the CLI reports it from the quorum and exits 4", T, async () => {
  srcHost.mode.stop = "fail";
  const x = await cli(["move", id, TARGET, ...mg]);
  srcHost.mode.stop = undefined;
  assert.equal(x.code, 4, x.err + x.out);
  assert.match(x.out, /release answer: the host could not confirm the app stopped, so it released nothing \(HTTP 502 stop_unconfirmed\) \(outcome unknown\)/);
  assert.match(x.err, /the lease is still held by .* on the quorum/);
  assert.equal((await get(id)).runner.toLowerCase(), r.runner.toLowerCase(), "the ledger still names the source");
  assert.deepEqual(srcHost.effects.filter((e) => e.delete), [{ delete: "vm-move-1", refused: true }]);
  assert.doesNotMatch(srcHost.stdout(), /\[move\]|\[claim\] released/, "no release transaction was sent");
  assert.deepEqual(tgt.chainEffects, [], "the target was never hinted");
  // the actual supervisor restored the record: still running here
  const st = await cli(["status", id, "--host", "--json", ...mg]);
  assert.equal(st.code, 0, st.err); assert.equal(JSON.parse(st.out.slice(st.out.indexOf("{"))).hostReported.status, "running");
});

test("move: the actual source releases only after the ledger shows it, the quorum confirms, the signed hint lands on the target", T, async () => {
  const from = await r.pc.getBlockNumber();
  const before = await get(id);
  const x = await cli(["move", id, TARGET, ...mg]);
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /the source reports the lease released \(0x[0-9a-f]{64}\); confirming on the quorum/);
  assert.match(x.out, /lease released \(quorum, block \d+\)/);
  assert.match(x.out, /running on 0x[0-9a-f]{8}… now \(quorum, block \d+\)/);
  const after = await get(id);
  assert.equal(after.runner.toLowerCase(), TARGET.toLowerCase());
  assert.ok(Number(after.leaseUntil) > Math.floor(Date.now() / 1000));
  // funds: the source's release refunded the unused tail to the RECORD; the target's claim bought time at ITS price
  const ev = await ledgerEvents(from);
  const released = ev.filter((e) => e.eventName === "Released"), claimed = ev.filter((e) => e.eventName === "Claimed");
  assert.equal(released.length, 1); assert.equal(released[0].args.enclaveId.toLowerCase(), r.runner.toLowerCase());
  assert.ok(released[0].args.refunded6 > 0n, "the unused lease tail went back to the balance");
  assert.equal(claimed.length, 1); assert.equal(claimed[0].args.enclaveId.toLowerCase(), TARGET.toLowerCase());
  assert.equal(claimed[0].args.operator.toLowerCase(), privateKeyToAccount(TARGET_KEY).address.toLowerCase());
  const rateFor = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "rateFor", args: [id, TARGET] });
  assert.equal(after.rate, rateFor); assert.ok(after.rate > before.rate, "the target's price is in force for its lease");
  // the actual supervisor: one confirmed stop, one release, logged only once the ledger no longer named it
  assert.match(srcHost.stdout(), new RegExp(`\\[move\\] ${id} released for an owner move \\(0x[0-9a-f]{64}\\)`));
  assert.equal(srcHost.effects.filter((e) => e.delete && !e.refused).length, 1);
  assert.deepEqual(tgt.chainEffects, ["claim"]);
  // both hosts were dialed only at their signed public addresses
  const routes = fs.readFileSync(routeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(routes.every((y) => [`${PUBLIC_MANAGEMENT.address}:${PUBLIC_MANAGEMENT.port}`, `${TARGET_PUBLIC.address}:${TARGET_PUBLIC.port}`].includes(y.from)));
  noEnclave();
});

test("move back: a slow release answer is delivered (not cut by re-authorization); the actual supervisor's signed hint route declines", T, async () => {
  const from = await r.pc.getBlockNumber();
  tgt.mode.release = "slow";
  const x = await cli(["move", id, r.runner, "--wait", "12", ...mg]);
  tgt.mode.release = undefined;
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /the source reports the lease released \(0x[0-9a-f]{64}\)/, "the answer arrived although the lease ended under it");
  assert.match(x.out, /declines: management claimHint refused \(HTTP 503\).*not claiming/);
  assert.match(x.out, /released and queued: no host has claimed it within 12s/);
  assert.match((await get(id)).runner, /^0x0{64}$/);
  assert.deepEqual(tgt.chainEffects, ["claim", "release"]);
  const released = (await ledgerEvents(from)).filter((e) => e.eventName === "Released");
  assert.equal(released.length, 1); assert.ok(released[0].args.refunded6 > 0n);
  noEnclave();
});

test("move: a lost release answer is decided by the quorum, never resent", T, async () => {
  await r.write(r.wc(TARGET_KEY), r.addresses.ledger, r.A.ledger.abi, "claim", [id, TARGET]);
  tgt.mode.release = "drop";
  const x = await cli(["move", id, r.runner, "--wait", "10", ...mg]);
  tgt.mode.release = undefined;
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /release answer: .*\(outcome unknown\); reading the quorum/);
  assert.match(x.out, /lease released \(quorum, block \d+\)/);
  assert.deepEqual(tgt.chainEffects, ["claim", "release", "release"], "exactly one release for this move (the claim above was the test's own)");
  assert.match((await get(id)).runner, /^0x0{64}$/);
  noEnclave();
});

test("move of a queued record only hints; a declining target leaves it queued with its balance intact", T, async () => {
  const b0 = (await get(id)).balance6;
  tgt.mode.claim = "decline";
  const x = await cli(["move", id, TARGET, "--wait", "10", ...mg]);
  tgt.mode.claim = undefined;
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /holds no live lease .*asking 0x[0-9a-f]{8}… to claim it/);
  assert.match(x.out, /declines: stand-in declines/);
  assert.match(x.out, /released and queued/);
  assert.equal((await get(id)).balance6, b0, "no money moved");
  noEnclave();
});
