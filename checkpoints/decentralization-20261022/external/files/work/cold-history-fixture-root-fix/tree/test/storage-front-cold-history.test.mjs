// COLD START of a relay-free guest under a long-held lease (work/storage-front-cold-history-interface.txt): the ACTUAL
// direct path in Go (bootstrap Reader.Authorize on the owner-committed startup package, then Authorization.WriterAuthority
// under WhenFinal), a FRESH reader per check (no coverage, no relay, no cache), against the live rev-16d ledger bytecode
// on anvil (test/helpers/lease16d-rig.mjs). Leases are made month-old the real way: 1,575 renewals 1,700 s apart (31 days).
// Five providers stand in front of the chain, shaped like the live ones (logs/probe-history.json, probe-logs.json):
//   measured (the guest's pinned set): A: 200-block ranges, nothing older than its recent horizon (mainnet.base.org);
//   B: nothing older than its recent horizon (publicnode); C: no eth_getLogs at all (drpc free plan);
//   owner history: H1: 50-block ranges (nodies.app), H2: 1000-block ranges (tenderly). "rpc2.hist-a.test" is a second
//   name for H1's operator.
// THIS IS SOURCE/ARCHITECTURE EVIDENCE ON A LOCAL CHAIN: whether real public endpoints serve old logs is the live probe's
// question (logs/probe-history.json, probe-throughput.json), not this file's.
//   run: node --test test/storage-front-cold-history.test.mjs   (needs anvil and go)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startLease16dRig } from "./helpers/lease16d-rig.mjs";

const M2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../isolation/m2");
const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("go", ["version"], { stdio: "ignore" }); return false; } catch { return "needs anvil and go"; } })();
const NAMES = ["rpc.measured-a.test", "rpc.measured-b.test", "rpc.measured-c.test", "rpc.hist-a.test", "rpc.hist-b.test"];
const H1 = "https://rpc.hist-a.test/base", H2 = "https://rpc.hist-b.test/v1/base?key=synthetic-read-only", H1ALIAS = "https://rpc2.hist-a.test/base";
const APP = "a1".repeat(32), RUNTIME = "b2".repeat(32), DAY = 86400, STEP = 1700;
let rig, ticker, offset = 0;
const D = {};   // name -> { id, pkg, claims: [{block, logIndex, time}] }
const [MA, MB, MC, HA, HB] = [0, 1, 2, 3, 4];

const sha = (b) => createHash("sha256").update(b).digest("hex");
function manifest(id, history) {
  return Buffer.from(JSON.stringify({ version: 1, chainId: 8453, ledger: rig.ledger, deployment: id, owner: rig.ownerAddress,
    appRef: `catalog://0x${"5a".repeat(32)}/3`, appId: APP, runtimeId: RUNTIME, configText: '{"writerAuthority":"$ENCLAVE_WRITER_AUTHORITY"}',
    secretsMode: "public", ...(history ? { history: { rpcs: history } } : {}) }));
}
const envelope = (pkg) => JSON.stringify({ guestBootstrap: { version: 1, sha256: sha(pkg) } });
async function deployment(name, history, options) {
  const id = await rig.create(options);
  const pkg = manifest(id, history);
  await rig.setConfig(id, envelope(pkg));   // the OWNER commits to the exact package bytes
  D[name] = { id, pkg, claims: [] };
  return D[name];
}
async function claim(d, host = rig.hosts.a) {
  const c = await rig.claim(d.id, host);
  const b = await rig.pc.getBlock({ blockNumber: BigInt(c.block) });
  d.claims.push({ ...c, time: Number(b.timestamp) });
}
const factOf = (d, c = d.claims.at(-1)) => ({ source: "lease16", chainId: 8453, ledger: rig.ledger.toLowerCase(), deployment: d.id, claimBlock: c.block, claimLogIndex: c.logIndex });
function shape() {            // the live-like provider shapes, relative to the current head
  return rig.pc.getBlockNumber().then((h) => {
    const head = Number(h);
    rig.honest(10);
    Object.assign(rig.peers[MA].mode, { rangeLimit: 200, historyBelow: head - 300 });
    Object.assign(rig.peers[MB].mode, { historyBelow: head - 300 });
    Object.assign(rig.peers[MC].mode, { noLogs: true });
    Object.assign(rig.peers[HA].mode, { rangeLimit: 50 });
    Object.assign(rig.peers[HB].mode, { rangeLimit: 1000 });
    return head;
  });
}
// one Go run: the checks in order, each on a fresh reader; onAuthorized(check) runs when a pausing check has authorized
async function go(checks, { onAuthorized, during } = {}) {
  const pause = fs.mkdtempSync(path.join(os.tmpdir(), "cold-history-"));
  const routes = Object.fromEntries(NAMES.map((n, i) => [n, rig.peers[i].url]));
  routes["rpc2.hist-a.test"] = rig.peers[HA].url;
  const env = { ...process.env, GOFLAGS: "-mod=mod", COLD_HISTORY_RIG: JSON.stringify({ routes, measured: NAMES.slice(0, 3).map((n) => "https://" + n),
    ledger: rig.ledger, clockOffsetSec: offset, checks: checks.map((c) => ({ windowMs: 20000, intervalMs: 500, ...c, ...(c.pause ? { pause } : {}),
      package: (c.package || D[c.d].pkg).toString("base64"), id: D[c.d].id, appId: APP, runtimeId: RUNTIME, d: undefined })) }) };
  const child = spawn("go", ["test", "-count=1", "-run", "^TestColdHistoryRig$", "-v", "./bootstrap"], { cwd: M2, env });
  let out = "";
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  // Attach the exit listener immediately. A callback error must unblock the paused child and
  // be reported by this test, never become an unhandled rejection while a 10-minute child waits.
  const closed = new Promise((ok, fail) => { child.once("close", ok); child.once("error", fail); });
  const killer = setTimeout(() => child.kill("SIGKILL"), 600000);
  let watching = !!onAuthorized, callbackError;
  const watch = (async () => {
    while (watching) {
      if (fs.existsSync(path.join(pause, "authorized"))) {
        fs.rmSync(path.join(pause, "authorized"));
        try { await onAuthorized(); } catch (e) { callbackError = e; }
        finally { fs.writeFileSync(path.join(pause, "proceed"), "1"); watching = false; }
      }
      if (watching) await new Promise((r) => setTimeout(r, 100));
    }
  })();
  let code;
  try { if (during) during(); code = await closed; }
  finally {
    watching = false; clearTimeout(killer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await watch; fs.rmSync(pause, { recursive: true, force: true });
  }
  if (callbackError) throw callbackError;
  assert.equal(code, 0, out);
  assert.match(out, /--- PASS: TestColdHistoryRig/, "the Go checks ran (not skipped)");
  return out;
}
const attempts = (out, name) => Number((out.match(new RegExp(`^ATTEMPTS ${name} (\\d+)`, "m")) || [])[1]);

before(async () => {
  if (skip) return;
  rig = await startLease16dRig({ providers: 5 });
  rig.honest(10);
  // three month-old leases (two with owner history sources, one legacy package without), claimed at the same time
  const long = [await deployment("D1", [H1, H2]), await deployment("D2", [H1, H2]), await deployment("D3", null)];
  for (const d of long) await claim(d);
  const rate = BigInt((await rig.row(long[0].id)).rate);
  const need = String(((rate * 1800n * 1600n) / 10n ** 6n) + 10n);        // 1,575 renewals and a margin, in USDC
  for (const d of long) await rig.fundMore(d.id, need);
  const steps = Math.ceil(31 * DAY / STEP), t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    await rig.raw("evm_increaseTime", [STEP]);
    for (const d of long) await rig.renew(d.id, rig.hosts.a);
    // day 15: D2's runner releases and claims again (the same runner): a new lease, a new generation
    if (i === Math.round(15 * DAY / STEP)) { await rig.release(D.D2.id, rig.hosts.a); await claim(D.D2); }
    if (i % 100 === 0 || i === steps) {     // progress: a harness too slow for its own timeout shows at once
      const sec = (Date.now() - t0) / 1000;
      console.log(`# setup: ${i}/${steps} renewal rounds (${i * long.length} renewals) in ${sec.toFixed(0)} s, ${((i * long.length) / sec).toFixed(1)} tx/s`);
    }
  }
  // short leases for the startup-race and owner-change checks, and the single-operator package
  for (const [name, hist] of [["D4", [H1, H1ALIAS]], ["D5", [H1, H2]], ["D6", [H1, H2]], ["D7", [H1, H2]]]) {
    const isTransfer = name === "D7", host = isTransfer ? rig.hosts.c : rig.hosts.a;
    if (isTransfer) await rig.selfHost(host);
    await deployment(name, hist, isTransfer ? { fund: "0" } : undefined); await claim(D[name], host);
    const r = BigInt((await rig.row(D[name].id)).rate);
    if (isTransfer) {
      assert.equal(r, 0n, "the ownership-transfer fixture is self-hosted with no refundable backing");
      assert.equal((await rig.row(D[name].id)).balance6, 0n);
    } else await rig.fundMore(D[name].id, String((r * 1800n * 12n) / 10n ** 6n + 2n));
    for (let k = 0; k < 8; k++) await rig.renew(D[name].id, host);   // current through every check
  }
  await rig.mine(30);
  const latest = await rig.pc.getBlock();
  offset = Number(latest.timestamp) - Math.floor(Date.now() / 1000);
  ticker = setInterval(() => rig.mine(1).catch(() => {}), 1000);          // Base makes a block every 2 s; here every 1 s
});
after(async () => { clearInterval(ticker); if (rig) await rig.stop(); });

test("a month-old lease, fresh guest, no relay and no cache: proven from the owner's history sources; the legacy package fails as before", { skip, timeout: 900000 }, async () => {
  const head = await shape();
  const age = (Number((await rig.pc.getBlock()).timestamp) - D.D1.claims[0].time) / DAY;
  assert.ok(age > 30, `the lease is ${age.toFixed(1)} days old`);
  assert.ok(D.D1.claims[0].block < head - 300, "the claim is below every measured provider's horizon");
  const out = await go([
    { name: "D1-cold", d: "D1", fact: factOf(D.D1) },
    { name: "D2-reclaimed-day15", d: "D2", fact: factOf(D.D2) },                        // the LATEST claim, never day 0's
    { name: "D3-legacy-package", d: "D3", code: "history_unavailable" },                // the frozen behaviour, unchanged
  ]);
  assert.match(out, /^ADMITTED D1-cold rpc\.hist-a\.test,rpc\.hist-b\.test$/m, "the history hosts joined the allowlist only after Authorize");
  assert.match(out, /^ADMITTED D3-legacy-package $/m);
  assert.ok(D.D2.claims[1].block > D.D2.claims[0].block);
});

test("budgeted incremental scanning: a fresh guest with a small per-attempt budget resumes across attempts inside its startup window", { skip, timeout: 900000 }, async () => {
  await shape();
  const out = await go([{ name: "D1-budget", d: "D1", fact: factOf(D.D1), maxRequests: 40 }]);
  assert.ok(attempts(out, "D1-budget") > 1, "the scan took several attempts, each resuming the last one's coverage");
});

test("renewals keep the generation; omitted, history-limited, forked or single-operator sources never yield a fact", { skip, timeout: 900000 }, async () => {
  await shape();
  await rig.renew(D.D1.id, rig.hosts.a); await rig.mine(15);
  await go([{ name: "D1-renewed", d: "D1", fact: factOf(D.D1) }]);
  // H1 omits D2's day-15 reclaim: the two history sources disagree
  await shape(); rig.peers[HA].mode.hideClaimsAfter = D.D2.claims[0].block;
  await go([{ name: "D2-one-omits", d: "D2", windowMs: 3000, contains: "disagree" }]);
  // BOTH omit it: the replay against the row refuses; the older generation is never returned
  await shape(); rig.peers[HA].mode.hideClaimsAfter = rig.peers[HB].mode.hideClaimsAfter = D.D2.claims[0].block;
  await go([{ name: "D2-both-omit", d: "D2", windowMs: 3000, contains: "inconsistent_logs" }]);
  // H2 serves recent blocks only: one operator left for the old range
  const head = await shape(); rig.peers[HB].mode.historyBelow = head - 300;
  await go([{ name: "D1-h2-limited", d: "D1", code: "history_unavailable" }]);
  // H2 on another fork (its agreed-block hash differs): not admitted
  await shape(); rig.peers[HB].mode.lieHash = true;
  await go([{ name: "D1-h2-fork", d: "D1", code: "history_unavailable" }]);
  // a package naming two hosts of ONE operator, measured sources serving no logs: one independent source
  await shape(); for (const i of [MA, MB, MC]) rig.peers[i].mode.noLogs = true;
  await go([{ name: "D4-one-operator", d: "D4", code: "history_unavailable" }]);
});

test("the startup is bound to its authorization: a same-runner reclaim, a config change or a transfer after it yields no fact", { skip, timeout: 900000 }, async () => {
  await shape();
  // between Authorize and the writer authority, the SAME runner releases and claims again
  let reclaimed;
  await go([{ name: "D5-reclaimed-during-start", d: "D5", pause: true, code: "lease_changed" }],
    { onAuthorized: async () => { await rig.release(D.D5.id, rig.hosts.a); await claim(D.D5); reclaimed = D.D5.claims.at(-1); await rig.mine(15); } });
  assert.ok(reclaimed, "the reclaim happened during the startup");
  // the owner commits another package (config change), or transfers the deployment
  await go([{ name: "D6-config-changed", d: "D6", pause: true, contains: "startup authorization changed" }],
    { onAuthorized: async () => { await rig.setConfig(D.D6.id, envelope(Buffer.from('{"other":"package"}'))); await rig.mine(3); } });
  await go([{ name: "D7-transferred", d: "D7", pause: true, contains: "startup authorization changed" }],
    { onAuthorized: async () => { await rig.transfer(D.D7.id); await rig.mine(3); } });
  // a package that does not match the owner's commitment: refused, and no history host ever joins the allowlist
  await go([{ name: "D1-uncommitted", d: "D1", package: manifest(D.D1.id, [H2, H1]), authorizeFails: "differs from owner commitment" }]);
});

test("external endpoint loss: a history source down for the whole window gives no fact; one back within it gives the fact", { skip, timeout: 900000 }, async () => {
  await shape(); rig.peers[HB].mode.down = true;
  await go([{ name: "D1-h2-down", d: "D1", windowMs: 4000, contains: "quorum_unavailable" }]);
  await shape(); rig.peers[HB].mode.down = true;
  const out = await go([{ name: "D1-h2-back", d: "D1", windowMs: 60000, intervalMs: 1000, fact: factOf(D.D1) }],
    { during: () => setTimeout(() => { rig.peers[HB].mode.down = false; }, 4000) });
  assert.ok(attempts(out, "D1-h2-back") > 1, "it waited through the outage");
});
