// The dashboard's chain consumers under a network profile, on the REAL site modules (config, independent, chain, wallet,
// fund, custody, sessions, independent-chain, platform-addresses, addressbook and the vendored custody bundle), each
// profile state in its own process (test/helpers/browser-rpc-scenario.mjs): a fake Base chain behind the profile's RPC
// origins, an inert wallet provider that answers differently from the chain, and a fetch that refuses every other
// origin as a blocked public network does.
//   confirmed profile: reads, estimates, receipts, quorum and custody reads reach only the profile's origins, and the
//     wallet is asked only to send; one endpoint down fails over; all down (or too few for the quorum) is refused by name;
//   invalid / unconfirmed profile: no origin and no wallet read at all;
//   profile changed in another tab after load: every read and transaction refuses until reload (sign-out keeps its key);
//   hosted mode (no profile): unchanged - wallet-first reads and the public default pool, which this test refuses.
// A CONTROL runs the same scenarios on e820e2405's site (git archive) and shows where it reached the wallet, used fewer
// routes or a weaker agreement, kept reading after a profile change, or read through an RPC stored with a session.
// Not a browser: page rendering, the wallet popover and real wallet extensions are outside it (see
// test/site-independent-browser.test.mjs for the Chromium run).
//   run: node --test test/site-browser-rpc-closure.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(REPO, "test/helpers/browser-rpc-scenario.mjs");
const OLD = "e820e2405af91010c18913acf4740f651618c644";
const HOSTED_POOL = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io", "https://mainnet.base.org"];

function run(siteRoot, sc){
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HELPER, siteRoot, JSON.stringify(sc)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 60000);
    p.on("close", (code) => {
      clearTimeout(t);
      const line = out.trim().split("\n").pop();
      if (code !== 0 || !line || !line.startsWith("{")) return reject(new Error("scenario " + JSON.stringify(sc) + " exited " + code + "\n" + err.slice(-2000)));
      resolve(JSON.parse(line));
    });
  });
}
const SITE = path.join(REPO, "site");
const onlyProfile = (r, what) => { for (const o of r[what].origins) assert.ok(r.rpcs.includes(o), what + " reached " + o); };
const noWalletRead = (r, what) => assert.deepEqual(r[what].wallet.filter((m) => m !== "eth_sendTransaction"), [], what + " asked the wallet");
const READS = ["usdcBalance", "ethBalance", "payerHasCode", "receipt", "baseRpc"];

test("confirmed profile: every read, estimate and receipt uses only its RPCs; the wallet only broadcasts", async () => {
  const r = await run(SITE, { state: "on", sessions: true });
  for (const k of [...READS, "sendTx", "quorumSnapshot"]){ onlyProfile(r, k); noWalletRead(r, k); }
  assert.equal(r.usdcBalance.ok, 42, "the chain's answer, not the wallet's 7");
  assert.equal(r.ethBalance.ok, 1);
  assert.equal(r.payerHasCode.ok, false);
  assert.deepEqual(r.sendTx.wallet, ["eth_sendTransaction"]);
  assert.equal(r.sendTx.gas, "0x668a", "the profile's estimate (0x5208) padded 25%, not the wallet's");
  assert.equal(r.receipt.ok, "0x1");
  assert.equal(r.quorumSnapshot.ok, 100);
  assert.deepEqual(r.quorumSnapshot.origins.sort(), [...r.rpcs].sort());
  assert.equal(r.currentSession.ok, "profile client", "a stored session reads through this profile, not the RPC stored with it");
  assert.deepEqual(r.refused, []);
});

test("one configured endpoint down: the reads fail over to the profile's other routes", async () => {
  const r = await run(SITE, { state: "on", down: [0] });
  for (const k of [...READS, "sendTx", "quorumSnapshot"]){ onlyProfile(r, k); noWalletRead(r, k); }
  assert.equal(r.usdcBalance.ok, 42);
  assert.ok(r.usdcBalance.origins.includes(r.rpcs[1]), "rotated past the dead first origin");
  assert.equal(r.sendTx.gas, "0x668a");
  assert.equal(r.quorumSnapshot.ok, 100, "2 of the 3 still agree");
  assert.deepEqual(r.refused, []);
});

test("every configured endpoint down: refused by name, nothing sent, no hidden route", async () => {
  const r = await run(SITE, { state: "on", down: [0, 1, 2] });
  for (const k of [...READS, "sendTx", "quorumSnapshot"]){ onlyProfile(r, k); assert.deepEqual(r[k].wallet, [], k + " reached the wallet"); assert.ok(r[k].error, k + " answered"); }
  assert.match(r.sendTx.error, /none of the network profile's RPC endpoints could check this transaction - nothing was sent/);
  assert.match(r.receipt.error, /none of the network profile's RPC endpoints answered/);
  assert.match(r.quorumSnapshot.error, /only 0 of 3 chain endpoints answered/);
  assert.deepEqual(r.refused, []);
});

for (const [state, sc, why] of [["invalid", { state: "invalid", badProfile: true }, /independent profile is invalid/],
  ["unconfirmed", { state: "unconfirmed" }, /Confirm the independent profile/]])
  test(`${state} profile: no origin and no wallet read, never a public default`, async () => {
    const r = await run(SITE, sc);
    for (const k of [...READS, "sendTx"]){
      assert.deepEqual(r[k].origins, [], k + " reached an origin");
      assert.deepEqual(r[k].wallet, [], k + " reached the wallet");
      assert.ok(r[k].error, k + " answered");
    }
    for (const k of ["usdcBalance", "baseRpc", "receipt"]) assert.match(r[k].error, why);
    assert.match(r.quorumSnapshot.error, /not active in this tab/);
    assert.deepEqual(r.refused, []);
  });

test("profile changed in another tab after load: reads and transactions refuse until reload; sign-out keeps its key", async () => {
  const r = await run(SITE, { state: "changed", sessions: true });
  for (const k of [...READS, "sendTx", "quorumSnapshot"]){
    assert.deepEqual(r[k].origins, [], k + " kept using the old routes");
    assert.deepEqual(r[k].wallet, [], k + " reached the wallet");
    assert.match(r[k].error, /network profile changed in another tab/);
  }
  assert.equal(r.endSession.ok, "sid1", "the session pointer survives a refused sign-out");
});

test("hosted mode unchanged: wallet-first reads, the public default pool, and no independent session served", async () => {
  const r = await run(SITE, { state: "off", sessions: true });
  assert.equal(r.usdcBalance.ok, 7); assert.deepEqual(r.usdcBalance.wallet, ["eth_call"]);
  assert.equal(r.ethBalance.ok, 2);
  assert.equal(r.payerHasCode.ok, true);
  assert.deepEqual(r.sendTx.wallet, ["eth_estimateGas", "eth_sendTransaction"]);
  // the hosted defaults are still public RPCs (disclosed until cutover); here the network refuses them
  assert.deepEqual(r.refused, HOSTED_POOL);
  assert.equal(r.currentSession.ok, null, "a session an independent profile opened is not served through its stored RPC");
});

test("a profile saved in another tab stops a hosted tab from sending", async () => {
  const r = await run(SITE, { state: "appeared" });
  assert.match(r.sendTx.error, /network profile changed in another tab/);
  assert.ok(!r.sendTx.wallet.includes("eth_sendTransaction"));
  assert.match(r.baseRpc.error, /network profile changed/);
  assert.deepEqual(r.baseRpc.origins, []);
});

test("custody reads use every profile RPC with the profile's quorum (book-resolved vault)", async () => {
  const a = await run(SITE, { state: "on", book: true });
  assert.equal(a.custodyAvailable, true, "the platform book named the vault");
  assert.equal(a.custody.ok, null, "no policy on the fake vault");
  onlyProfile(a, "custody"); assert.deepEqual(a.custody.wallet, []);
  assert.ok(a.sendTx.ok, "the book's current ledger accepts the transaction");
  const b = await run(SITE, { state: "on", book: true, rpcs: 4, quorum: 3, down: [0] });
  assert.equal(b.custody.ok, null);
  assert.ok(b.custody.origins.includes(b.rpcs[3]), "the fourth route is used (not only the first three)");
  const c = await run(SITE, { state: "on", book: true, rpcs: 4, quorum: 3, downAfterLoad: [0, 1] });
  assert.match(c.custody.error, /only 2 of 4 RPCs answered \(need 3\)/, "the profile's quorum, not a fixed 2");
});

const haveGit = (() => { try { execFileSync("git", ["-C", REPO, "cat-file", "-e", OLD + "^{commit}"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("CONTROL: e820e2405's site fails the same checks", { skip: !haveGit && "needs the repository's git objects" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-closure-old-"));
  try {
    execFileSync("sh", ["-c", `git -C "${REPO}" archive ${OLD} site network | tar -x -C "${tmp}"`]);
    const old = path.join(tmp, "site");
    const fails = [];
    const on = await run(old, { state: "on", sessions: true });
    if (on.usdcBalance.ok === 7 && on.usdcBalance.wallet.includes("eth_call")) fails.push("confirmed profile: balance read through the wallet's RPC");
    if (on.sendTx.wallet.includes("eth_estimateGas")) fails.push("confirmed profile: gas estimated through the wallet's RPC");
    const inv = await run(old, { state: "invalid", badProfile: true });
    if (inv.usdcBalance.wallet.length) fails.push("invalid profile: the wallet was still asked for a balance");
    const ch = await run(old, { state: "changed", sessions: true });
    if (ch.baseRpc.ok && ch.baseRpc.origins.length) fails.push("profile changed elsewhere: kept reading the old routes");
    if (ch.sendTx.ok) fails.push("profile changed elsewhere: still sent a transaction");
    const off = await run(old, { state: "off", sessions: true });
    if (String(off.currentSession.ok).includes("stored rpc https://old-profile.example")) fails.push("hosted mode: served an independent session through its stored RPC");
    const c4 = await run(old, { state: "on", book: true, rpcs: 4, quorum: 3, down: [0] });
    if (!c4.custody.origins.includes(c4.rpcs[3])) fails.push("custody: only the first three routes");
    const cq = await run(old, { state: "on", book: true, rpcs: 4, quorum: 3, downAfterLoad: [0, 1] });
    if (!/need 3/.test(cq.custody.error || "")) fails.push("custody: agreement of 2 regardless of the profile's quorum");
    console.log("old source failures:\n  " + fails.join("\n  "));
    assert.equal(fails.length, 8, "each check this test makes fails on the old source: " + JSON.stringify(fails));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
