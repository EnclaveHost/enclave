// The GUEST's writer-authority read (isolation/m2/bootstrap/leasegen.go, the measured front's relay-free and fallback
// path) on the live rev-16d ledger bytecode on anvil, behind the three provider proxies of test/helpers/lease16d-rig.mjs,
// through the real measured RPC client (NewReader: HTTPS names, a guest-egress-like transport). This file mutates the
// chain; bootstrap's TestLease16dRig (env-gated) reads it and checks each expectation. Needs anvil and go.
//   run: node --test test/storage-front-binding-go.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startLease16dRig } from "./helpers/lease16d-rig.mjs";

const M2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../isolation/m2");
const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("go", ["version"], { stdio: "ignore" }); return false; } catch { return "needs anvil and go"; } })();
let rig;
before(async () => { if (!skip) rig = await startLease16dRig(); });
after(async () => { if (rig) await rig.stop(); });
const factOf = (id, c) => JSON.stringify({ source: "lease16", chainId: 8453, ledger: rig.ledger.toLowerCase(), deployment: id, claimBlock: c.block, claimLogIndex: c.logIndex });
// asynchronous: the rig's providers are served by THIS process's event loop while go test reads them
async function goCheck(checks) {
  const env = { ...process.env, GOFLAGS: "-mod=mod", LEASE16D_RIG: JSON.stringify({ proxies: rig.peers.map((p) => p.url), ledger: rig.ledger, checks }) };
  const child = spawn("go", ["test", "-count=1", "-run", "^TestLease16dRig$", "-v", "./bootstrap"], { cwd: M2, env });
  let out = "";
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
  const code = await new Promise((ok) => child.on("close", ok));
  clearTimeout(timer);
  assert.equal(code, 0, out);
  assert.match(out, /--- PASS: TestLease16dRig/, "the Go check ran (not skipped)");
}

test("the guest's read: finality, renewals, reclaims, the release's runner, and public-provider behaviour", { skip, timeout: 900000 }, async () => {
  rig.honest(10);
  const id = await rig.create(), A = rig.hosts.a, B = rig.hosts.b;
  const c1 = await rig.claim(id, A); await rig.mine(3);
  await goCheck([{ name: "not final yet", id, code: "claim_not_final", retry: true }]);
  await rig.mine(20);
  await rig.renew(id, A); await rig.mine(20);
  await goCheck([
    { name: "final, renewed: the claim's fact", id, fact: JSON.parse(factOf(id, c1)) },
    { name: "bound to the release's runner", id, runner: A.id, fact: JSON.parse(factOf(id, c1)) },
    { name: "another runner than the release's", id, runner: B.id, code: "runner_mismatch", retry: false },
  ]);
  // the same runner releases and claims again: a new lease, a higher generation
  await rig.release(id, A); const c2 = await rig.claim(id, A); await rig.mine(300);
  // public providers: 200-block ranges everywhere, 429s on one
  for (const p of rig.peers) p.mode.rangeLimit = 200;
  rig.peers[0].mode.rateLimit = 2;
  await goCheck([{ name: "reclaimed by the same runner, through range limits and 429s", id, runner: A.id, fact: JSON.parse(factOf(id, c2)) }]);
  // an unserved history on every provider: refused, never an empty history; one dropping a log: disagreement
  rig.honest(10); for (const p of rig.peers) p.mode.historyBelow = c2.block + 1;
  await goCheck([{ name: "history unserved", id, code: "history_unavailable", retry: false }]);
  rig.honest(10); rig.peers[1].mode.dropLastLog = true;
  await goCheck([{ name: "one provider drops a log", id, code: "disagree", retry: true }]);
  // EVERY provider hides the newer claim: the replay against the row refuses (never the older generation)
  rig.honest(10); for (const p of rig.peers) p.mode.hideClaimsAfter = c1.block;
  await goCheck([{ name: "colluding providers hide the newest claim", id, code: "inconsistent_logs", retry: true }]);
  rig.honest(10); rig.peers[0].mode.down = true; rig.peers[1].mode.down = true;
  await goCheck([{ name: "two providers down", id, code: "quorum_unavailable", retry: true }]);
  rig.honest(10);
});
