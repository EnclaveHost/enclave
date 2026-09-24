// The SHIPPED extension (the pinned pvm-client-ext.zip of the current pin, unzipped and loaded unpacked) in a real Chrome for Testing over the
// DevTools protocol, with deterministic barriers: the extension's own "policy-committed" post to the lab result URL, and
// the lab relay holding /evidence. Cases: a stall at evidence followed by SIGKILL of the whole browser, then a relaunch
// that must find the committed serial and refuse a rollback; the same with only the tab closed; two tabs holding old and
// new serials in both orders; equal serial with other bytes across tabs. The 0.1.0 zip runs the first case as the
// preserved old-client failure. What passing proves: persistence across browser process death and tab close on this
// machine. NOT proven here: persistence across whole-machine power loss (chrome.storage.local's write reaches the browser
// process and the OS page cache; nothing here cuts power).
//   run: ENCLAVE_PVM_CLIENT_CLI=<pinned pvm-client.mjs> [ENCLAVE_PVM_CLIENT_OLD_CLI=<0.1.0 pvm-client.mjs>] node --test test/verifier-pvm-client-ext.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { labServer, keys, signedPolicy, fpOf, APP, unzipTo } from "./helpers/pvm-lab.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const zipBeside = (cli) => (cli ? path.join(path.dirname(cli), "pvm-client-ext.zip") : "");
const NEW_ZIP = zipBeside(process.env.ENCLAVE_PVM_CLIENT_CLI), OLD_ZIP = zipBeside(process.env.ENCLAVE_PVM_CLIENT_OLD_CLI);
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const have = (p) => !!p && fs.existsSync(p);
if (STRICT && !(have(CFT) && have(NEW_ZIP) && have(OLD_ZIP))) throw new Error("strict integration: Chrome for Testing, the pinned extension zip or the pinned 0.1.0 extension zip is missing");
const skipNew = !(have(CFT) && have(NEW_ZIP)) && "Chrome for Testing or the pinned extension zip absent";
const skipOld = !(have(CFT) && have(OLD_ZIP)) && "the pinned 0.1.0 extension zip absent (ENCLAVE_PVM_CLIENT_OLD_CLI)";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-ext-"));
const K = keys();
const browsers = new Set();   // every launched browser, so a failed case cannot leave one running on its CDP socket
let L; test.before(async () => { L = await labServer(); });
test.after(async () => { for (const b of browsers) await b.quit(); L?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
// an unpacked extension's id: sha256 of the absolute directory path, first 32 hex digits mapped 0-9a-f -> a-p
const idOf = (dir) => createHash("sha256").update(dir).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

async function launch(extDir, profile) {
  const b = spawn(CFT, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const endpoint = await new Promise((resolve, reject) => { b.stderr.on("data", (c) => { log += c; const m = /DevTools listening on (ws:\S+)/.exec(log); if (m) resolve(m[1]); }); b.on("exit", () => reject(new Error(`chrome exited before listening: ${log.slice(-400)}`))); setTimeout(() => reject(new Error(`chrome did not start listening: ${log.slice(-400)}`)), 30000).unref(); });
  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0], id = idOf(extDir);
  const exited = new Promise((r) => b.on("exit", r));
  const self = { browser, ctx, id, pid: b.pid,
    open: async (url) => { const p = await ctx.newPage(); await p.goto(url); return p; },
    // the harsh end: SIGKILL of the whole process group, no graceful shutdown, no flush hint from us
    kill: async () => { browsers.delete(self); try { process.kill(-b.pid, "SIGKILL"); } catch {} await exited; try { await browser.close(); } catch {} },
    quit: async () => { browsers.delete(self); try { await browser.close(); } catch {} try { process.kill(-b.pid, "SIGKILL"); } catch {} } };
  browsers.add(self); return self;
}
const stateDoc = async (br) => { const p = await br.open(`chrome-extension://${br.id}/options.html`); const d = await p.evaluate(() => chrome.storage.local.get(["stateDoc", "state"])); await p.close(); return d.stateDoc ? { ...d.stateDoc.state, gen: d.stateDoc.gen } : d.state || null; };
const installUrl = (id, name) => `chrome-extension://${id}/options.html?install=1&policyKeyFp=${fpOf(K.policy)}&serialFloor=1&releaseKeyFp=${fpOf(K.release)}&policyUrl=${encodeURIComponent(L.base + "/policy/current")}&relayUrl=${encodeURIComponent(L.base + "/r/" + name)}&appId=${APP}&resultUrl=${encodeURIComponent(L.base + "/result")}`;
const pageUrl = (id, label) => `chrome-extension://${id}/client.html?label=${label}&path=%2F`;
// open a request tab under the policy named after its label: 0.2.0 asks the carrier for it by label (?for=), 0.1.0 asks
// for nothing, so the carrier's current policy is set to the same one (this keeps the 0.2.0 cases runnable against the
// 0.1.0 zip as the negative control: they must then fail on the durable-serial assertions, not on the carrier)
const openTab = (s, label) => { L.defaultPolicy = label; return s.br.open(pageUrl(s.br.id, label)); };
const outcome = (label) => L.waitPost((x) => x.label === label && x.step, `the outcome of ${label}`);
const committedBefore = (label) => L.posts.some((x) => x.label === label && x.event === "policy-committed");   // 0.2.0 posts it before its evidence request
// a tab has DECIDED when it posted its outcome or sent an evidence request (the n-th of its install): a refusal is then a
// post and no new request; a client that acts instead fails the count assertion at once rather than hanging
const decided = (label, relay, n) => L.when(() => L.posts.some((x) => x.label === label && x.step) || L.count(relay) >= n, `${label} to decide`);
async function fresh(zip, name) {
  const extDir = unzipTo(zip, path.join(tmp, name, "ext")); const profile = path.join(tmp, name, "profile"); fs.mkdirSync(profile, { recursive: true });
  const br = await launch(extDir, profile);
  const before = L.posts.filter((x) => x.installed === true).length;
  const p = await br.open(installUrl(br.id, name)); await L.when(() => L.posts.filter((x) => x.installed === true).length > before, `the install post of ${name}`); await p.close();
  return { name, extDir, profile, br };
}
// a relaunch on the same profile must not restore the killed browser's tabs (Chrome would re-run their pages and each
// would send another evidence request, which the exact counts below would catch as an extra arrival): the session
// files are removed first. The owner's extension suite met exactly that on a SIGKILLed profile.
const clearSessions = (profile) => { for (const d of [profile, path.join(profile, "Default")]) { for (const n of ["Sessions", "Session Storage", "Current Session", "Last Session", "Current Tabs", "Last Tabs"]) fs.rmSync(path.join(d, n), { recursive: true, force: true }); } };
const relaunch = async (s) => { clearSessions(s.profile); s.br = await launch(s.extDir, s.profile); return s.br; };

test("pinned build: stall at evidence, then the whole browser SIGKILLed: the relaunch finds the committed serial and refuses a rollback", { skip: skipNew }, async () => {
  L.policies.set("e1-new", signedPolicy(K, 2)); L.policies.set("e1-old", signedPolicy(K, 1));
  const s = await fresh(NEW_ZIP, "e1");
  await openTab(s, "e1-new"); await L.evidenceRequested("e1", 1);   // the page acted on the policy; the relay holds it
  await s.br.kill();
  await relaunch(s);
  const st = await stateDoc(s.br); assert.equal(st?.serial, 2, `after the kill the committed serial must be 2 (${JSON.stringify(st)})`);
  assert.equal(committedBefore("e1-new"), true, "the commit was reported before the evidence request");
  await openTab(s, "e1-old"); await decided("e1-old", "e1", 2);
  assert.equal(L.count("e1"), 1, "no evidence request under the rolled-back policy");
  const r = await outcome("e1-old"); assert.equal(r.step, "policy"); assert.match(r.refused, /rollback/);
  assert.match(r.userAgent || "", /Chrome\/151\./, "the outcome came from the real browser"); assert.equal(r.extension, s.br.id, "under the computed unpacked-extension id");
  await s.br.quit();
});
test("pinned build: stall at evidence, then only the TAB closed: the serial stays committed and a rollback in a new tab is refused", { skip: skipNew }, async () => {
  L.policies.set("e2-new", signedPolicy(K, 3)); L.policies.set("e2-old", signedPolicy(K, 2));
  const s = await fresh(NEW_ZIP, "e2");
  const p = await openTab(s, "e2-new"); await L.evidenceRequested("e2", 1);
  await p.close();
  assert.equal((await stateDoc(s.br))?.serial, 3, "the serial committed by the closed tab remains");
  await openTab(s, "e2-old"); await decided("e2-old", "e2", 2);
  assert.equal(L.count("e2"), 1); const r = await outcome("e2-old"); assert.equal(r.step, "policy"); assert.match(r.refused, /rollback/);
  await s.br.quit();
});
test("pinned build: two tabs; new first then old: the old tab is refused before acting; old first then new: the state ends new and the old completion cannot overwrite it", { skip: skipNew }, async () => {
  for (const [n, sr] of [["e3-new", 6], ["e3-old", 5], ["e3-old2", 7], ["e3-new2", 8]]) L.policies.set(n, signedPolicy(K, sr));
  const s = await fresh(NEW_ZIP, "e3");
  const pn = await openTab(s, "e3-new"); await L.evidenceRequested("e3", 1);
  await openTab(s, "e3-old"); await decided("e3-old", "e3", 2);
  assert.equal(L.count("e3"), 1, "the old tab must be refused, not act"); const ro = await outcome("e3-old"); assert.equal(ro.step, "policy"); assert.match(ro.refused, /rollback/);
  L.release("e3", 1); const rn = await outcome("e3-new"); assert.equal(rn.step, "evidence"); await pn.close();
  assert.equal((await stateDoc(s.br))?.serial, 6);
  const po = await openTab(s, "e3-old2"); await L.evidenceRequested("e3", 2);
  const pn2 = await openTab(s, "e3-new2"); await L.evidenceRequested("e3", 3);
  assert.equal((await stateDoc(s.br))?.serial, 8, "both accepted in order: the state is the newer while both act");
  L.release("e3", 3); await outcome("e3-new2"); await pn2.close();
  L.release("e3", 2); await outcome("e3-old2"); await po.close();          // the older request finishes last
  assert.equal((await stateDoc(s.br))?.serial, 8, "the older completion must not overwrite the newer serial");
  assert.equal(committedBefore("e3-new") && committedBefore("e3-old2") && committedBefore("e3-new2"), true);
  await s.br.quit();
});
test("pinned build: equal serial with other bytes across two tabs is refused as equivocation; the same bytes again are accepted and acted on", { skip: skipNew }, async () => {
  L.policies.set("e4-a", signedPolicy(K, 9)); L.policies.set("e4-b", signedPolicy(K, 9, { tag: "other bytes" })); L.policies.set("e4-c", L.policies.get("e4-a"));
  const s = await fresh(NEW_ZIP, "e4");
  const pa = await openTab(s, "e4-a"); await L.evidenceRequested("e4", 1);
  await openTab(s, "e4-b"); await decided("e4-b", "e4", 2);
  assert.equal(L.count("e4"), 1, "equivocation must be refused without acting on it"); const rb = await outcome("e4-b"); assert.equal(rb.step, "policy"); assert.match(rb.refused, /equivocation/);
  L.release("e4", 1); await outcome("e4-a"); await pa.close();
  await openTab(s, "e4-c"); await L.evidenceRequested("e4", 2); L.release("e4", 2);
  const rc = await outcome("e4-c"); assert.equal(rc.step, "evidence");
  assert.equal((await stateDoc(s.br))?.serial, 9);
  await s.br.quit();
});
test("0.1.0 (preserved old-client failure): stall at evidence, then the browser SIGKILLed: the OLD serial remains and a rollback is acted on", { skip: skipOld }, async () => {
  L.policies.set("o1-new", signedPolicy(K, 2)); L.policies.set("o1-old", signedPolicy(K, 1));
  const s = await fresh(OLD_ZIP, "o1");
  await openTab(s, "o1-new"); await L.evidenceRequested("o1", 1);
  await s.br.kill(); await relaunch(s);
  const st = await stateDoc(s.br); assert.equal(st?.serial, 1, `0.1.0 persists nothing before the exchange: serial still 1 (${JSON.stringify(st)})`);
  assert.equal(committedBefore("o1-new"), false, "0.1.0 reports no commit");
  await openTab(s, "o1-old"); await decided("o1-old", "o1", 2);
  assert.equal(L.count("o1"), 2, "0.1.0 acts on the older policy after the kill: the gap");
  L.release("o1", 2); const r = await outcome("o1-old"); assert.equal(r.step, "evidence"); assert.match(r.userAgent || "", /Chrome\/151\./); assert.equal(r.extension, s.br.id);
  await s.br.quit();
});
