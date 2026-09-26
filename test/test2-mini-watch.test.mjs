// TEST2-MINI's sampler (windows/node/ops/hv-node-rollout/test2/mini-watch.mjs), against fakes only: no network, no relay,
// no box. It proves the sampler's safety (the one negative probe is the zero id; ID2 is probed only while the relay's row
// says it serves it; the only HTTP call is a GET of /enclaves) and the PASS arithmetic of summarize().
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ZERO_ID, ENCLAVES, OPERATOR, xUrl, zeroProbe, watch, summarize, main } from "../windows/node/ops/hv-node-rollout/test2/mini-watch.mjs";

const T1 = "0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3";
const ID2 = "0x958ae6e9d6cb638901d97d2f29d9775d8143b14fa46f6c37aaa4e3f2c78cdd42";
const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const K1 = "a".repeat(64), K2 = "b".repeat(64);

// a relay + partitions fake: `status(url)` decides the upgrade (a number = refused with it, "open" = TLS then 200)
function fakeDeps({ status = () => "open", listing = () => ({ enclaves: [] }) } = {}) {
  const opened = [], fetched = [];
  return {
    opened, fetched,
    fetchImpl: async (url, opts) => { fetched.push({ url, method: opts && opts.method }); return { ok: true, status: 200, json: async () => listing() }; },
    openWs(url) {
      opened.push({ url, at: Date.now() });
      const ws = new EventEmitter(); ws.terminate = () => {};
      setImmediate(() => { const s = status(url); if (s === "open") ws.emit("open"); else ws.emit("unexpected-response", {}, { statusCode: s }); });
      return ws;
    },
    wsStream: () => ({}),
    tlsConnect(o) {
      const s = new EventEmitter(); s.authorized = true; s.getPeerCertificate = () => ({ raw: Buffer.from(o.servername) });
      s.write = () => setImmediate(() => { s.emit("data", "HTTP/1.1 200 OK\r\n\r\nHello"); s.emit("end"); });
      setImmediate(() => s.emit("secureConnect"));
      return s;
    },
    spkiOf: (raw) => (String(raw).startsWith(T1.slice(2, 10)) ? K1 : K2),
  };
}
const row = (deps) => ({ enclaves: [{ name: "nucbox-k11", lastSeen: 1, ownerOnly: true,
  served: [{ owner: OPERATOR, expires: null }, { owner: OWNER, expires: 9 }], servesDeployments: deps.map((id) => ({ id, until: 9 })) }] });

test("the zero probe reaches ONLY the zero id's splice, and a 200 there is a failure, not a pass", async () => {
  const d = fakeDeps({ status: () => 503 });
  const r = await zeroProbe(d);
  assert.deepEqual(d.opened.map((o) => o.url), [xUrl(ZERO_ID)]);
  assert.equal(r.x, "refused(503)");
  // main's `zero` takes no id: extra arguments (a live id) change nothing
  const d2 = fakeDeps({ status: () => 503 });
  assert.equal(await main(["zero", "--id", T1, T1], d2), 0);
  assert.deepEqual(d2.opened.map((o) => o.url), [xUrl(ZERO_ID)]);
  // a regressed relay that SERVES the zero id makes the command fail
  assert.equal(await main(["zero"], fakeDeps({ status: () => "open" })), 1);
});

test("watch refuses a zero or duplicated target", async () => {
  await assert.rejects(watch({ test1: ZERO_ID, seconds: 0.1 }, fakeDeps(), () => {}), /test 1/);
  await assert.rejects(watch({ test1: T1, id2: T1, seconds: 0.1 }, fakeDeps(), () => {}), /id2/);
  await assert.rejects(watch({ test1: T1, id2: ZERO_ID, seconds: 0.1 }, fakeDeps(), () => {}), /id2/);
});

test("ID2 is probed ONLY while the relay's row lists it; the only HTTP call is a GET of /enclaves", async () => {
  let listed = false; const flips = [];
  const d = fakeDeps({ listing: () => row(listed ? [T1, ID2] : [T1]) });
  const lines = [];
  const run = watch({ test1: T1, id2: ID2, seconds: 1.5, rowMs: 40, t1Ms: 30, id2Ms: 20 }, d, (l) => lines.push(l));
  await new Promise((r) => setTimeout(r, 400)); listed = true; flips.push(Date.now());
  await new Promise((r) => setTimeout(r, 500)); listed = false; flips.push(Date.now());
  await run;
  const id2Opens = d.opened.filter((o) => o.url === xUrl(ID2));
  assert.ok(id2Opens.length > 0, "ID2 was probed while listed");
  assert.equal(id2Opens.filter((o) => o.at < flips[0]).length, 0, "never before the row listed it");
  // after the un-listing, the next row sample (<= 40 ms, plus the fetch) is the last chance: allow 100 ms, then none
  assert.equal(id2Opens.filter((o) => o.at > flips[1] + 100).length, 0, "never after the row stopped listing it");
  assert.ok(lines.some((l) => l.kind === "id2" && l.skipped), "skips are recorded");
  assert.ok(d.opened.every((o) => o.url === xUrl(T1) || o.url === xUrl(ID2)), "no other splice");
  assert.ok(d.fetched.length > 0 && d.fetched.every((f) => f.url === ENCLAVES && f.method === "GET"));
  assert.ok(lines.filter((l) => l.kind === "t1").every((l) => l.x === "open" && l.code === "200" && l.spki === K1));
});

test("watch ends early and cleanly when its stop promise resolves", async () => {
  const d = fakeDeps({ listing: () => row([T1]) }); const lines = [];
  const t0 = Date.now(); let fire; const stop = new Promise((r) => { fire = r; });
  setTimeout(fire, 200);
  await watch({ test1: T1, seconds: 60, rowMs: 40, t1Ms: 30, stop }, d, (l) => lines.push(l));
  assert.ok(Date.now() - t0 < 2000, "ended on stop, not after 60 s");
  const n = lines.length; await new Promise((r) => setTimeout(r, 150));
  assert.equal(lines.length, n, "nothing is written after it returns");
});

test("a STALE row (the /enclaves read hangs) stops ID2 probes within 3 s: the gate needs a fresh listing", async () => {
  let calls = 0, hungAt = null;
  const d = fakeDeps();
  d.fetchImpl = async (_url, opts) => {
    // the relay stops answering: the request ends only by its own abort signal, as the real fetch does
    if (++calls > 3) { if (!hungAt) hungAt = Date.now(); return new Promise((_r, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))); }
    return { ok: true, status: 200, json: async () => row([T1, ID2]) };
  };
  await watch({ test1: T1, id2: ID2, seconds: 4.5, rowMs: 100, t1Ms: 1000, id2Ms: 50 }, d, () => {});
  const late = d.opened.filter((o) => o.url === xUrl(ID2) && o.at > hungAt + 3200);
  assert.ok(d.opened.some((o) => o.url === xUrl(ID2)), "probed while fresh");
  assert.equal(late.length, 0, "no ID2 probe once the last row is over 3 s old");
});

// ---- summarize(): synthetic JSONL on a fixed clock ------------------------------------------------------------------
const T0 = Date.parse("2026-09-26T18:00:00.000Z");
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const R = (s, o) => ({ t: iso(s), kind: "row", ...o });
const up = (owners, deps) => ({ present: true, lastSeen: 1, owners: owners.map((owner) => ({ owner })), deps: deps.map((id) => ({ id })) });
const P = (s, kind, o = {}) => ({ kind, t: iso(s), start: iso(s), end: iso(s + 1.5), x: "open", code: "200", spki: kind === "t1" ? K1 : K2, ca: true, ...o });
// ADD at +100 s: the owner appears in the row sample at +130 s (the relay bound the attach between +128 and +130);
// ID2 served from +150; REMOVE at `rm` (+400 by default): the row is absent at rm+10..rm+18, back with [operator] at rm+20
function scenario({ t1 = () => ({}), rows = () => null, id2 = () => ({}), rm = 400 } = {}) {
  const L = [];
  for (let s = 0; s <= 600; s += 2) {
    let r;
    if (s < 130) r = up([OPERATOR], [T1]);
    else if (s < 150) r = up([OPERATOR, OWNER], [T1]);
    else if (s < rm + 10) r = up([OPERATOR, OWNER], [T1, ID2]);
    else if (s < rm + 20) r = { present: false };
    else r = up([OPERATOR], [T1]);
    L.push(R(s, rows(s) || r));
  }
  for (let s = 0; s <= 600; s += 1) {
    const base = s >= rm + 10 && s < rm + 22 ? { x: "refused(404)", code: "000", spki: null } : {};
    L.push(P(s, "t1", { ...base, ...t1(s) }));
  }
  for (let s = 0; s <= 600; s += 2) L.push(s >= 150 && s < rm + 10 ? P(s, "id2", id2(s)) : { t: iso(s), kind: "id2", skipped: "not in servesDeployments" });
  return L;
}
const opts = { key1: K1, key2: K2, id2: ID2, addAt: iso(100), rmAt: iso(400) };

test("summarize: the expected run PASSES every line", () => {
  const s = summarize(scenario(), opts);
  assert.deepEqual(s.verdicts, { A1: "PASS", A2: "PASS", A3: "PASS", C1: "PASS", A4: "PASS", A5: "PASS", gate: "PASS" }, s.lines.join("\n"));
});

test("summarize A1: a 404 (the row absent) or an absent row sample during the ADD FAILS", () => {
  assert.equal(summarize(scenario({ t1: (s) => (s === 140 ? { x: "refused(404)", code: "000", spki: null } : {}) }), opts).verdicts.A1, "FAIL");
  assert.equal(summarize(scenario({ rows: (s) => (s === 150 ? { present: false } : null) }), opts).verdicts.A1, "FAIL");
});

test("summarize A1: a probe cut IN FLIGHT at the handover is INFO; the same cut elsewhere FAILS", () => {
  const atHand = summarize(scenario({ t1: (s) => (s === 128 ? { code: "000", cut: "ECONNRESET" } : {}) }), opts);
  assert.equal(atHand.verdicts.A1, "PASS");
  assert.ok(atHand.lines.some((l) => /INFO cut at the handover/.test(l)));
  assert.equal(summarize(scenario({ t1: (s) => (s === 180 ? { code: "000", cut: "ECONNRESET" } : {}) }), opts).verdicts.A1, "FAIL");
  // a wrong KEY is never "a cut", wherever it is: outside the handover, and INSIDE it (enclave-bf's W1)
  assert.equal(summarize(scenario({ t1: (s) => (s === 180 ? { spki: K2 } : {}) }), opts).verdicts.A1, "FAIL");
  assert.equal(summarize(scenario({ t1: (s) => (s === 128 ? { spki: K2 } : {}) }), opts).verdicts.A1, "FAIL");
  assert.equal(summarize(scenario({ t1: (s) => (s === 128 ? { spki: K2, code: "000", cut: "ECONNRESET" } : {}) }), opts).verdicts.A1, "FAIL");
  // a 200 whose key was not read (spki null) is not proof of test 1's key, and it is never a cut either
  assert.equal(summarize(scenario({ t1: (s) => (s === 128 ? { spki: null } : {}) }), opts).verdicts.A1, "FAIL");
  // at most 2 cuts: two pass, three do not
  const cuts = (n) => (s) => (s >= 127 && s < 127 + n ? { code: "000", cut: "ECONNRESET" } : {});
  assert.equal(summarize(scenario({ t1: cuts(2) }), opts).verdicts.A1, "PASS");
  assert.equal(summarize(scenario({ t1: cuts(3) }), opts).verdicts.A1, "FAIL");
});

test("summarize: a REMOVE 2-4 min after the ADD stays out of the ADD's lines (enclave-bf's W2)", () => {
  const s = summarize(scenario({ rm: 250 }), { ...opts, rmAt: iso(250) });
  assert.deepEqual(s.verdicts, { A1: "PASS", A2: "PASS", A3: "PASS", C1: "PASS", A4: "PASS", A5: "PASS", gate: "PASS" }, s.lines.join("\n"));
});

test("summarize A1: no handover seen, or too few probes (a dead watcher), FAILS", () => {
  assert.equal(summarize(scenario({ rows: (s) => (s >= 130 && s < 410 ? up([OPERATOR], [T1]) : null) }), opts).verdicts.A1, "FAIL");
  const sparse = scenario().filter((l) => l.kind !== "t1" || Date.parse(l.start) % 10_000 === 0);
  assert.equal(summarize(sparse, opts).verdicts.A1, "FAIL");
});

test("summarize A2: a third owner in the row after the ADD FAILS", () => {
  const extra = "0x0b2d009c0000000000000000000000000000ee61";
  assert.equal(summarize(scenario({ rows: (s) => (s === 160 ? up([OPERATOR, OWNER, extra], [T1]) : null) }), opts).verdicts.A2, "FAIL");
});

test("summarize A3: fewer than 3 consecutive 200s on ID2's key FAILS; C1 is NOT SEEN without a verified chain", () => {
  assert.equal(summarize(scenario({ id2: (s) => (s % 4 === 0 ? { spki: K1 } : {}) }), opts).verdicts.A3, "FAIL");
  assert.equal(summarize(scenario({ id2: () => ({ ca: false }) }), opts).verdicts.C1, "NOT SEEN");
});

test("summarize A4: the owner or ID2 listed after the break, or the row not back within 60 s, FAILS", () => {
  assert.equal(summarize(scenario({ rows: (s) => (s === 430 ? up([OPERATOR, OWNER], [T1]) : null) }), opts).verdicts.A4, "FAIL");
  assert.equal(summarize(scenario({ rows: (s) => (s === 440 ? up([OPERATOR], [T1, ID2]) : null) }), opts).verdicts.A4, "FAIL");
  assert.equal(summarize(scenario({ rows: (s) => (s >= 410 && s < 480 ? { present: false } : null) }), opts).verdicts.A4, "FAIL");
});

test("summarize A5: a test-1 gap over 60 s, or a failure after recovery, FAILS", () => {
  const long = { x: "refused(404)", code: "000", spki: null };
  assert.equal(summarize(scenario({ t1: (s) => (s >= 410 && s < 480 ? long : {}) }), opts).verdicts.A5, "FAIL");
  assert.equal(summarize(scenario({ t1: (s) => (s === 500 ? long : {}) }), opts).verdicts.A5, "FAIL");
});

test("summarize: an ID2 probe after the break FAILS the gate", () => {
  const L = scenario(); L.push(P(415, "id2"));
  assert.equal(summarize(L, opts).verdicts.gate, "FAIL");
});
