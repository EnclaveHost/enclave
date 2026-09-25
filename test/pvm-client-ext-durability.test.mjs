// The browser extension's rollback memory in a real headless Chromium (Chrome for Testing; skipped when absent), with the
// same deterministic barriers as test/pvm-client-durability.test.mjs: a carrier that holds the evidence request, and a
// policy server that holds each tab's policy until the test releases it -- never timing. The browser is killed (SIGKILL,
// the whole process group: harsher than closing the tab) while its page is stalled at the carrier, then relaunched on the
// same profile with its session files removed (no restored tab may re-run a page). The shipped 0.1.0 extension
// (4e55879b) reproduces the audit finding; 0.2.0 keeps the newer floor and serializes tabs under its lock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { heldCarrier } from "./fixtures/held-carrier.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const ZIP = new URL("../shielded/anchor/avf/client/dist/pvm-client-ext.zip", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const raw = (k) => k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); return { k, pub: raw(k), fp: sha(Buffer.from(raw(k), "hex")) }; };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const extId = (dir) => [...createHash("sha256").update(dir).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const APP = "ab".repeat(32);
const sign = (K, serial, over = {}) => { const now = Date.now(); const t = JSON.stringify({ type: "enclave-pvm-client-policy", key: K.pub, serial, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3),
  codeHashes: ["cc".repeat(32)], authorityHashes: ["dd".repeat(64)], runtimeIds: ["ee".repeat(32)], appIds: [APP],
  googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"],
  sealedModes: ["chunked"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null, ...over });
  return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), K.k.privateKey).toString("hex") }; };

function unpack(zipBytes) { const d = tmp("pvm-extd-"), z = path.join(d, "ext.zip"); fs.writeFileSync(z, zipBytes); const ext = path.join(d, "ext"); execFileSync("unzip", ["-q", z, "-d", ext]); return { ext, id: extId(ext) }; }

// the policy server and result sink. Each page asks for its policy (?for=<label>; 0.1.0 asks without); a policy can be
// HELD until the test releases it. Posted results are kept in arrival order, with waiters for conditions on them.
function lab() {
  const results = [], waiters = [], policies = {};
  const tick = () => { for (const w of waiters.splice(0)) w(); };
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => { b += d; }); q.on("end", async () => {
    const u = new URL(q.url, "http://x");
    if (u.pathname === "/policy") {
      const p = policies[u.searchParams.get("for") || "*"] || policies["*"];
      if (!p) { s.writeHead(404); return s.end(); }
      p.asked = true; tick();
      await p.gate;
      s.writeHead(200, { "content-type": "application/json" }); return s.end(JSON.stringify(p.doc));
    }
    if (u.pathname === "/result") { try { results.push(JSON.parse(b)); } catch {} tick(); return s.end("ok"); }
    s.writeHead(404); s.end(); }); }).listen(0, "127.0.0.1");
  const until = (pred, what) => new Promise((r, j) => {
    const t = setTimeout(() => j(new Error(`never happened: ${what}; results ${JSON.stringify(results)}`)), 60000);
    const c = () => (pred() ? (clearTimeout(t), r()) : waiters.push(c)); c(); });
  const serve = (label, doc, { held = false } = {}) => { let release = () => {}; const gate = held ? new Promise((r) => { release = r; }) : null; policies[label] = { doc, gate, asked: false }; return () => { release(); tick(); }; };
  return { srv, results, until, serve, asked: (label) => policies[label]?.asked, url: () => `http://127.0.0.1:${srv.address().port}` };
}
// one browser per launch; every page opens as its own TAB in it through the DevTools endpoint (headless Chrome opens no tab
// at all when given two URLs on its command line)
async function launch(ext, profile, urls) {
  for (const f of ["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"]) fs.rmSync(path.join(profile, "Default", f), { recursive: true, force: true });
  const portFile = path.join(profile, "DevToolsActivePort"); fs.rmSync(portFile, { force: true });
  const b = spawn(CFT, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "about:blank"], { detached: true, stdio: "ignore" });
  let port = null;
  for (let i = 0; i < 1500 && !port; i++) { try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || null; } catch {} if (!port) await wait(20); }
  if (!port) throw new Error("the browser never opened its DevTools port");
  for (const u of urls) { const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(u)}`, { method: "PUT" }); if (!r.ok) throw new Error(`could not open ${u}: ${r.status}`); }
  return { kill: async () => { try { process.kill(-b.pid, "SIGKILL"); } catch {} await new Promise((r) => (b.exitCode !== null ? r() : b.on("exit", r))); await wait(200); } };
}
async function installed(L, ext, id, P, R, relay) {
  const profile = tmp("pvm-extd-prof-");
  const b = await launch(ext, profile, [`chrome-extension://${id}/options.html?install=1&policyKeyFp=${P.fp}&serialFloor=1&releaseKeyFp=${R.fp}&policyUrl=${encodeURIComponent(L.url() + "/policy")}&relayUrl=${encodeURIComponent(relay)}&appId=${APP}&resultUrl=${encodeURIComponent(L.url() + "/result")}`]);
  await L.until(() => L.results.some((r) => "installed" in r), "the install result");
  await b.kill();
  assert.equal(L.results.find((r) => "installed" in r).installed, true, JSON.stringify(L.results));
  L.results.length = 0;
  return profile;
}
const page = (id, label) => `chrome-extension://${id}/client.html?label=${label}&path=%2F`;
const outcome = (L, label) => L.results.find((r) => r.label === label && !r.event);
const committed = (L, label) => L.results.find((r) => r.label === label && r.event === "policy-committed");

// the stall and the kill, then an older policy: the finding reproduces when the older one reaches the carrier
async function stallKillRollback(zipBytes, v2) {
  const { ext, id } = unpack(zipBytes), L = lab(), C = heldCarrier(), P = key(), R = key();
  await Promise.all([new Promise((r) => L.srv.on("listening", r)), new Promise((r) => C.srv.on("listening", r))]);
  const out = {};
  try {
    const profile = await installed(L, ext, id, P, R, C.url());
    L.serve("*", sign(P, 3)); L.serve("stall", sign(P, 3));
    let b = await launch(ext, profile, [page(id, "stall")]);
    await C.until(1);                                    // policy 3 accepted; the evidence request is held at the carrier
    out.committedBeforeEvidence = v2 ? committed(L, "stall")?.serial ?? null : null;
    await b.kill();                                      // the browser dies while its page is stalled
    out.stalledOutcome = outcome(L, "stall") ? "posted" : "none";
    L.serve("*", sign(P, 2)); L.serve("rollback", sign(P, 2));
    b = await launch(ext, profile, [page(id, "rollback")]);
    const n = C.held.length;
    await Promise.race([L.until(() => outcome(L, "rollback"), "the rollback outcome"), C.until(n + 1)]);
    out.rollback = C.held.length > n ? "reached the carrier" : outcome(L, "rollback").refused;
    await b.kill();
  } finally { L.srv.close(); C.close(); }
  return out;
}

const skip = (!fs.existsSync(CFT) && "no Chrome for Testing") || (!fs.existsSync(ZIP) && "no built extension");

test("the finding, in a real browser on the shipped 0.1.0 extension: killed while stalled at the carrier, it forgets the newer policy and accepts the older", { skip, timeout: 180000 }, async () => {
  const old = execFileSync("git", ["-C", REPO, "show", "4e55879b:shielded/anchor/avf/client/dist/pvm-client-ext.zip"], { maxBuffer: 1 << 26 });
  assert.equal(sha(old), "8235d20cf437a58076556beea427e10caf8858668c8a894da5e1f7ae0687ac53", "the shipped 0.1.0 extension");
  const o = await stallKillRollback(old, false);
  console.log("0.1.0", JSON.stringify(o));
  assert.equal(o.stalledOutcome, "none");
  assert.equal(o.rollback, "reached the carrier", "0.1.0 sent the evidence request under the older policy");
});

test("since 0.2.0, in a real browser: the policy is committed before the evidence request; killed while stalled, the floor holds and the older policy is refused", { skip, timeout: 180000 }, async () => {
  const o = await stallKillRollback(fs.readFileSync(ZIP), true);
  console.log("0.2.0", JSON.stringify(o));
  assert.equal(o.committedBeforeEvidence, 3, "policy-committed (serial 3) was posted before the carrier saw the evidence request");
  assert.equal(o.stalledOutcome, "none");
  assert.match(o.rollback, /rollback/);
});

test("since 0.2.0, in a real browser: two tabs with an older and a newer policy, in either order, serialize under the lock -- the floor ends at the newer", { skip, timeout: 240000 }, async () => {
  const { ext, id } = unpack(fs.readFileSync(ZIP)), L = lab(), C = heldCarrier(), P = key(), R = key();
  await Promise.all([new Promise((r) => L.srv.on("listening", r)), new Promise((r) => C.srv.on("listening", r))]);
  try {
    const profile = await installed(L, ext, id, P, R, C.url());
    // (a) both tabs open and ask; the NEWER (5) is released first and commits; then the OLDER (4): refused as a rollback
    let goNew = L.serve("new-a", sign(P, 5), { held: true }), goOld = L.serve("old-a", sign(P, 4), { held: true });
    let b = await launch(ext, profile, [page(id, "new-a"), page(id, "old-a")]);
    await L.until(() => L.asked("new-a") && L.asked("old-a"), "both tabs asking for their policies");
    goNew(); await L.until(() => committed(L, "new-a"), "the newer committed");
    goOld(); await L.until(() => outcome(L, "old-a"), "the older's outcome");
    assert.deepEqual([committed(L, "new-a").serial, committed(L, "new-a").gen], [5, 2]);
    assert.equal(committed(L, "old-a"), undefined, "the older was never committed");
    assert.match(outcome(L, "old-a").refused, /rollback/); assert.equal(outcome(L, "old-a").step, "policy");
    await b.kill();
    // (b) the OLDER (6) is released first, commits and stalls at the carrier; then the NEWER (7) commits over it; the kill
    // leaves 7; a relaunch with 6 is refused
    goNew = L.serve("new-b", sign(P, 7), { held: true }); goOld = L.serve("old-b", sign(P, 6), { held: true });
    const n = C.held.length;
    b = await launch(ext, profile, [page(id, "new-b"), page(id, "old-b")]);
    await L.until(() => L.asked("new-b") && L.asked("old-b"), "both tabs asking for their policies");
    goOld(); await L.until(() => committed(L, "old-b"), "the older committed"); await C.until(n + 1);
    goNew(); await L.until(() => committed(L, "new-b"), "the newer committed");
    assert.deepEqual([committed(L, "old-b").serial, committed(L, "old-b").gen, committed(L, "new-b").serial, committed(L, "new-b").gen], [6, 3, 7, 4]);
    await b.kill();
    L.serve("again", sign(P, 6));
    b = await launch(ext, profile, [page(id, "again")]);
    await L.until(() => outcome(L, "again"), "the relaunch outcome");
    assert.match(outcome(L, "again").refused, /rollback/, "the floor is 7 after the kill");
    await b.kill();
    // (c) the same serial with different content in two tabs, released together: one commits, the other is equivocation
    const Q = sign(P, 8), Q2 = sign(P, 8, { codeHashes: ["c1".repeat(32)] });   // signed by the right key, same serial, different content
    assert.notEqual(Q.policy, Q2.policy);
    const g1 = L.serve("eq-1", Q, { held: true }), g2 = L.serve("eq-2", Q2, { held: true });
    b = await launch(ext, profile, [page(id, "eq-1"), page(id, "eq-2")]);
    await L.until(() => L.asked("eq-1") && L.asked("eq-2"), "both tabs asking");
    g1(); g2();
    await L.until(() => outcome(L, "eq-1") && outcome(L, "eq-2") || (committed(L, "eq-1") && outcome(L, "eq-2")) || (committed(L, "eq-2") && outcome(L, "eq-1")), "one committed, the other refused");
    const won = committed(L, "eq-1") ? "eq-1" : "eq-2", lost = won === "eq-1" ? "eq-2" : "eq-1";
    assert.equal(committed(L, lost), undefined); assert.match(outcome(L, lost).refused, /equivocat|same serial|different/i, JSON.stringify(outcome(L, lost)));
    assert.equal(committed(L, won).gen, 5);
    await b.kill();
    // (d) the SAME policy (identical bytes) in two tabs is not equivocation: both see it committed, at one generation
    const S = sign(P, 9), s1 = L.serve("same-1", S, { held: true }), s2 = L.serve("same-2", S, { held: true });
    b = await launch(ext, profile, [page(id, "same-1"), page(id, "same-2")]);
    await L.until(() => L.asked("same-1") && L.asked("same-2"), "both tabs asking");
    s1(); s2();
    await L.until(() => committed(L, "same-1") && committed(L, "same-2"), "both committed");
    assert.deepEqual([committed(L, "same-1").gen, committed(L, "same-2").gen], [6, 6]);
    await b.kill();
  } finally { L.srv.close(); C.close(); }
});
