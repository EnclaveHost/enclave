// relay/state-replica.mjs: the platform API's replicated, fenced, encrypted state - three members in this process over a
// transport the test can partition, each with its own real directory. Members are driven by hand (campaign / commit /
// tick) so every safety case is deterministic; one case runs the members' own timers end to end.
//   run: node --test --test-concurrency=1 test/platform-api-replica.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ReplicaNode, sealMessage, openMessage, openArchive, scanDir, cmpHead } from "../relay/state-replica.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function group({ n = 3, leaseMs = 300, key = randomBytes(32), archive = null, now = Date.now, maxSkewMs = 120000, id = "test-group" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pa-replica-"));
  const cut = new Set();                                      // "i-j": messages from i to j are dropped
  const down = new Set();
  const nodes = [];
  // what an attacker on the path saw: every sealed request and answer, per (from, to); `replayOnly` drops every NEW request
  // and answers it with the last captured answer from that member, without any key
  const tap = { requests: [], answers: new Map(), replayOnly: false };
  const send = (from) => async (to, buf) => {
    if (down.has(to) || down.has(from) || cut.has(`${from}-${to}`) || cut.has(`${to}-${from}`)) throw new Error("unreachable");
    if (tap.replayOnly) { const a = tap.answers.get(`${from}-${to}`); if (!a) throw new Error("dropped"); return a; }
    tap.requests.push({ from, to, buf: Buffer.from(buf) });
    const out = await nodes[to].handle(buf);
    tap.answers.set(`${from}-${to}`, Buffer.from(out));
    return out;
  };
  const make = (i, extra = {}) => new ReplicaNode({ self: i, n, key, group: id, dir: path.join(root, `m${i}/data`), metaFile: path.join(root, `m${i}/meta.json`), send: send(i), leaseMs,
                                                   info: { name: `m${i}` }, archive, archiveMs: 0, now, maxSkewMs, ...extra });
  for (let i = 0; i < n; i++) nodes.push(make(i));
  return { root, nodes, cut, down, key, make, tap, isolate: (i) => { for (let j = 0; j < n; j++) if (j !== i) cut.add(`${i}-${j}`); }, heal: () => { cut.clear(); down.clear(); },
           write: (i, rel, text) => { const d = nodes[i].dir; fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel + ".tmp"), text); fs.renameSync(path.join(d, rel + ".tmp"), path.join(d, rel)); },
           read: (i, rel) => { try { return fs.readFileSync(path.join(nodes[i].dir, rel), "utf8"); } catch { return null; } },
           cleanup: () => { for (const x of nodes) x.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const quiet = async (g) => { await sleep(g.nodes[0].leaseMs + 30); };      // past every member's join quiet period and lease

test("election: one primary per epoch from a majority; a commit reaches the members before it counts; followers hold exactly the primary's files", async () => {
  const g = group();
  try {
    await quiet(g);
    assert.equal(await g.nodes[0].campaign(), true);
    assert.equal(g.nodes[0].role, "leader"); assert.equal(g.nodes[1].leader, 0); assert.equal(g.nodes[2].leader, 0);
    // a second candidate in the same lease window is refused (the primary's lease is live at every member)
    assert.equal(await g.nodes[1].campaign(), false);
    assert.equal(g.nodes[0].role, "leader");
    g.write(0, "accounts.json", '{"accounts":{"acct_1":{"wallet":"0xabc"}}}');
    g.write(0, "pads/ledger.json", '{"n":1}');
    assert.equal(await g.nodes[0].commit(), true);
    for (const i of [1, 2]) {
      assert.equal(g.read(i, "accounts.json"), g.read(0, "accounts.json"));
      assert.equal(g.read(i, "pads/ledger.json"), '{"n":1}');
      assert.deepEqual(g.nodes[i].head, g.nodes[0].head);
    }
    fs.unlinkSync(path.join(g.nodes[0].dir, "pads/ledger.json"));
    assert.equal(await g.nodes[0].commit(), true);
    assert.equal(g.read(1, "pads/ledger.json"), null, "a removal replicates too");
    assert.equal(await g.nodes[0].commit(), true, "nothing changed: no traffic, still true while the lease is live");
  } finally { g.cleanup(); }
});

test("quorum: one member down still commits (2 of 3); two down fails the commit and the primary steps down at once", async () => {
  const g = group();
  let demoted = null;
  g.nodes[0].onFollower = (why) => { demoted = why; };
  try {
    await quiet(g); await g.nodes[0].campaign();
    g.down.add(2);
    g.write(0, "orders.json", '{"o":1}');
    assert.equal(await g.nodes[0].commit(), true);
    assert.equal(g.read(1, "orders.json"), '{"o":1}'); assert.equal(g.read(2, "orders.json"), null);
    g.down.add(1);
    g.write(0, "orders.json", '{"o":2}');
    assert.equal(await g.nodes[0].commit(), false, "no majority: the write is NOT acknowledged");
    assert.equal(g.nodes[0].role, "follower"); assert.match(demoted, /could not reach a majority/);
  } finally { g.cleanup(); }
});

test("a lagging member (down for several commits) is brought level with a full snapshot", async () => {
  const g = group();
  try {
    await quiet(g); await g.nodes[0].campaign();
    g.down.add(2);
    for (let k = 0; k < 4; k++) { g.write(0, `f${k}.json`, String(k)); assert.equal(await g.nodes[0].commit(), true); }
    g.heal();
    g.write(0, "f9.json", "9");
    assert.equal(await g.nodes[0].commit(), true);
    for (let k of [0, 1, 2, 3, 9]) assert.equal(g.read(2, `f${k}.json`), String(k));
    assert.deepEqual(g.nodes[2].head, g.nodes[0].head);
  } finally { g.cleanup(); }
});

test("failover: an isolated primary loses its lease and stops; the majority elects a successor with every acknowledged write; the old primary rejoins as a follower and cannot commit", async () => {
  const g = group();
  const demoted = [];
  g.nodes[0].onFollower = (why) => demoted.push(why);
  try {
    await quiet(g); await g.nodes[0].campaign();
    g.write(0, "accounts.json", '{"v":1}'); assert.equal(await g.nodes[0].commit(), true);
    g.isolate(0);
    // the old primary cannot renew; its lease ends; it notices on its own tick
    assert.equal(await g.nodes[0].commit({ heartbeat: true }), false);
    assert.equal(g.nodes[0].leaseValid(), false);
    // the others refuse to elect while the old lease could still be valid...
    assert.equal(await g.nodes[1].campaign(), false);
    await sleep(g.nodes[1].leaseMs + 40);
    // ...and elect after it lapsed, with the acknowledged state
    assert.equal(await g.nodes[1].campaign(), true);
    assert.equal(g.read(1, "accounts.json"), '{"v":1}');
    g.write(1, "accounts.json", '{"v":2}'); assert.equal(await g.nodes[1].commit(), true);
    // the old primary, back on the network, is refused at its old epoch and follows the new one
    g.heal();
    g.nodes[0].role = "leader"; g.nodes[0].leaseUntil = Date.now() + 10000;     // even if it still believed it led
    g.write(0, "accounts.json", '{"v":"split-brain"}');
    assert.equal(await g.nodes[0].commit(), false, "a stale primary's write is refused by the members of the newer epoch");
    assert.equal(g.nodes[0].role, "follower");
    assert.equal(g.read(1, "accounts.json"), '{"v":2}'); assert.equal(g.read(2, "accounts.json"), '{"v":2}');
    g.write(1, "x.json", "1"); assert.equal(await g.nodes[1].commit(), true);
    assert.equal(g.read(0, "accounts.json"), '{"v":2}', "the old primary's divergent file was replaced by the snapshot");
    assert.ok(demoted.length >= 1);
  } finally { g.cleanup(); }
});

test("a successor adopts the most advanced state among its voters (a write only one other member holds is not lost)", async () => {
  const g = group();
  try {
    await quiet(g); await g.nodes[0].campaign();
    g.down.add(2);
    g.write(0, "stripe-events.json", '{"evt_1":true}');
    assert.equal(await g.nodes[0].commit(), true, "acknowledged by members 0 and 1");
    g.down.clear(); g.down.add(0);                        // the primary dies; member 2 never saw the write
    await sleep(g.nodes[2].leaseMs + 40);
    assert.equal(await g.nodes[2].campaign(), true, "member 2 wins with member 1's vote");
    assert.equal(g.read(2, "stripe-events.json"), '{"evt_1":true}', "and fetched the newer state from its voter");
  } finally { g.cleanup(); }
});

test("one vote per epoch; a member that rebooted (forgot its votes) stays quiet for a lease before voting", async () => {
  const g = group();
  try {
    await quiet(g);
    assert.equal(await g.nodes[0].campaign(), true);
    const e = g.nodes[0].promised;
    // member 1 reboots: a new process with no meta and no state, joined now
    fs.rmSync(path.dirname(g.nodes[1].metaFile), { recursive: true, force: true });
    g.nodes[1] = g.make(1);
    g.down.add(0);
    await sleep(g.nodes[2].leaseMs + 40);
    // member 2's candidacy needs member 1's vote; member 1 is still in its quiet period after the reboot
    g.nodes[1].quietUntil = Date.now() + 10000;
    assert.equal(await g.nodes[2].campaign(), false, "a just-rebooted member does not vote");
    g.nodes[1].quietUntil = 0;
    assert.equal(await g.nodes[2].campaign(), true);
    assert.ok(g.nodes[2].promised > e);
  } finally { g.cleanup(); }
});

test("AEAD: another key, another kind or one flipped byte does not open; members refuse such a request; archives are ciphertext that only K opens", async () => {
  const k = randomBytes(32), other = randomBytes(32);
  const sealed = sealMessage(k, "req", { t: "vote", epoch: 9, from: 1 });
  assert.throws(() => openMessage(other, "req", sealed), /does not open/);
  assert.throws(() => openMessage(k, "res", sealed), /does not open/);
  const flipped = Buffer.from(sealed); flipped[20] ^= 1;
  assert.throws(() => openMessage(k, "req", flipped), /does not open/);
  const archives = [];
  const g = group({ key: k, archive: async (buf, head) => { archives.push({ buf, head }); } });
  try {
    await quiet(g); await g.nodes[0].campaign();
    await assert.rejects(g.nodes[1].handle(sealMessage(other, "req", { t: "vote", epoch: 99, from: 0, head: { epoch: 0, seq: 0 } })), /does not open/);
    g.write(0, "accounts.json", JSON.stringify({ wallet: "0xfeedfacecafebeef", email: "owner@example.com" }));
    assert.equal(await g.nodes[0].commit(), true);
    await g.nodes[0]._archive();
    assert.equal(archives.length, 1);
    const blob = archives[0].buf;
    assert.ok(!blob.includes("0xfeedfacecafebeef") && !blob.includes("owner@example.com") && !blob.includes("accounts.json"), "no plaintext, not even a file name");
    const o = openArchive(k, blob);
    assert.equal(Buffer.from(o.files["accounts.json"], "base64").toString(), JSON.stringify({ wallet: "0xfeedfacecafebeef", email: "owner@example.com" }));
    assert.equal(cmpHead(o.head, g.nodes[0].head), 0);
    assert.throws(() => openArchive(other, blob), /does not open/);
  } finally { g.cleanup(); }
});

test("timers end to end: the group elects by itself, renews by heartbeat, and re-elects within a few leases after the primary is cut off; never two valid leases", async () => {
  const g = group({ leaseMs: 300 });
  let twoLeaders = false;
  try {
    for (const x of g.nodes) x.start();
    const watch = setInterval(() => { if (g.nodes.filter((x) => x.leaseValid()).length > 1) twoLeaders = true; }, 5);
    const leaderOf = () => g.nodes.findIndex((x) => x.leaseValid());
    for (let i = 0; i < 100 && leaderOf() < 0; i++) await sleep(20);
    const first = leaderOf();
    assert.ok(first >= 0, "a primary was elected");
    await sleep(900);
    assert.equal(leaderOf(), first, "heartbeats keep the same primary");
    g.write(first, "accounts.json", '{"kept":true}'); assert.equal(await g.nodes[first].commit(), true);
    g.isolate(first);
    let next = -1;
    for (let i = 0; i < 150 && (next < 0 || next === first); i++) { await sleep(20); next = leaderOf(); }
    assert.ok(next >= 0 && next !== first, "a new primary after the old one was cut off");
    assert.equal(g.read(next, "accounts.json"), '{"kept":true}');
    clearInterval(watch);
    assert.equal(twoLeaders, false, "at no sampled moment did two members hold a valid lease");
  } finally { g.cleanup(); }
});

// ---- adversarial: captured ciphertext, no key -----------------------------------------------------------------------------
test("REPLAYED ANSWERS (root's reproduction): with every new request dropped and only earlier captured answers replayed, a commit is NOT counted, nothing is acknowledged, and the primary steps down", async () => {
  const g = group();
  try {
    await quiet(g);
    assert.equal(await g.nodes[0].campaign(), true, "a primary, with every answer captured on the way");
    g.write(0, "warmup.json", "1"); assert.equal(await g.nodes[0].commit(), true);   // captured: real append acks too
    g.tap.replayOnly = true;
    g.write(0, "acknowledged-write.json", '{"must":"reach a majority"}');
    assert.equal(await g.nodes[0].commit(), false, "a replayed ok:true answers another request: it is not counted");
    assert.equal(g.nodes[0].role, "follower");
    assert.equal(g.read(1, "acknowledged-write.json"), null); assert.equal(g.read(2, "acknowledged-write.json"), null);
    assert.equal(await g.nodes[0].commit({ heartbeat: true }), false, "nor does a replayed heartbeat ack renew a lease");
  } finally { g.cleanup(); }
});

test("REPLAYED GRANTS: captured vote grants from an earlier election do not elect anyone in a later one", async () => {
  const g = group();
  try {
    await quiet(g);
    assert.equal(await g.nodes[0].campaign(), true);
    g.down.add(0);
    await sleep(g.nodes[1].leaseMs + 40);
    g.tap.replayOnly = true;                       // member 1 campaigns; every answer it gets is some earlier captured one
    g.tap.answers.set("1-2", g.tap.answers.get("0-2")); g.tap.answers.set("1-0", g.tap.answers.get("0-1"));
    assert.equal(await g.nodes[1].campaign(), false, "answers bound to other requests are never counted as grants");
    assert.notEqual(g.nodes[1].role, "leader");
  } finally { g.cleanup(); }
});

test("REPLAYED REQUESTS: an old authentic snapshot, append or heartbeat replayed to a follower changes nothing (nonce, freshness window, monotonic head)", async () => {
  let clock = Date.now();
  const g = group({ now: () => clock, maxSkewMs: 5000 });
  try {
    clock += 400;
    assert.equal(await g.nodes[0].campaign(), true);
    const establish = g.tap.requests.filter((r) => r.to === 1).at(-1).buf;          // the epoch's opening snapshot to member 1
    g.write(0, "accounts.json", '{"v":1}'); assert.equal(await g.nodes[0].commit(), true);
    const append1 = g.tap.requests.filter((r) => r.to === 1).at(-1).buf;
    g.write(0, "accounts.json", '{"v":2}'); assert.equal(await g.nodes[0].commit(), true);
    assert.equal(g.read(1, "accounts.json"), '{"v":2}');
    // within the window: refused as already seen
    await assert.rejects(g.nodes[1].handle(establish), /replayed request/);
    await assert.rejects(g.nodes[1].handle(append1), /replayed request/);
    // past the window (or after the follower's process restarted and forgot its nonce cache): refused as stale...
    clock += 6000;
    await assert.rejects(g.nodes[1].handle(establish), /stale or future/);
    // ...and even a member that accepted it as fresh would not move backwards: a restarted follower with a cleared cache,
    // inside a wide window, answers the old snapshot "behind" and keeps the newer state
    const restarted = g.make(1, { maxSkewMs: 3600000 });
    g.nodes[1] = restarted;
    const out = await restarted.handle(establish);
    assert.ok(out.length > 0);
    assert.equal(g.read(1, "accounts.json"), '{"v":2}', "an old snapshot never erases newer acknowledged state");
    assert.deepEqual(restarted.head, g.nodes[0].head);
    // a request addressed to another member, or sealed for another group, is refused
    const to2 = g.tap.requests.find((r) => r.to === 2).buf;
    await assert.rejects(restarted.handle(to2), /not a request for this member|replayed|stale/);
    const other = group({ key: g.key, id: "another-group" });
    try { await assert.rejects(other.nodes[1].handle(append1), /does not open/); } finally { other.cleanup(); }
  } finally { g.cleanup(); }
});

test("a crash between two files of one change: the journaled change is re-applied whole at the next start; the directory never mixes two heads", async () => {
  const g = group();
  try {
    await quiet(g); await g.nodes[0].campaign();
    g.write(0, "a.json", "a1"); g.write(0, "b.json", "b1"); assert.equal(await g.nodes[0].commit(), true);
    const f = g.nodes[1], head = { epoch: f.head.epoch, seq: f.head.seq + 1 };
    // the follower journaled {a2, b2} and crashed after writing only a.json
    fs.writeFileSync(f.metaFile + ".pending", JSON.stringify({ head, changed: { "a.json": Buffer.from("a2").toString("base64"), "b.json": Buffer.from("b2").toString("base64") }, removed: [] }));
    fs.writeFileSync(path.join(f.dir, "a.json"), "a2");
    const again = g.make(1);
    assert.equal(g.read(1, "a.json"), "a2"); assert.equal(g.read(1, "b.json"), "b2", "the whole change, not half");
    assert.deepEqual(again.head, head);
    assert.equal(fs.existsSync(f.metaFile + ".pending"), false);
  } finally { g.cleanup(); }
});
