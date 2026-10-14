// host-ui: the one hosting panel the Windows tray and the Android Enclave app both load. Its sentences (text.js) run in
// Node; its behaviour runs in headless Chromium (the engine of WebView2 and of Android's WebView) against fake-node.mjs,
// as a PC and as a phone. The browser half skips where no Chromium can be launched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeNode } from "../host-ui/fake-node.mjs";
import { createDevServer } from "../host-ui/dev-server.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "host-ui");
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(UI, "text.js"), "utf8"), ctx);
const T = ctx.window.EnclaveHostText;
const fake = (kind) => createFakeNode({ kind });

test("the hosting view reads a PC node's answer and a phone's, and an older node's without the new fields", () => {
  const pc = T.hostingView(fake("pc").view()), phone = T.hostingView(fake("phone").view());
  assert.equal(pc.gpuAxis, true); assert.equal(pc.cpuLabel, "CPU"); assert.equal(pc.noun, "PC");
  assert.equal(phone.gpuAxis, false); assert.equal(phone.cpuLabel, "CPU & RAM"); assert.equal(phone.noun, "phone");
  assert.equal(phone.apps[0].host, "a69dcbba.app.enclave.host");
  const old = T.hostingView({ caps: { cpuShare: 0.3, gpuShare: 0 }, inUse: { cpuShare: 0.1 }, deploymentsServed: 1, backend: "legacy" });
  assert.equal(old.canPause, false); assert.equal(old.taking, null); assert.equal(old.apps, null); assert.deepEqual([...old.axes], ["cpu", "gpu"]);
  assert.equal(T.hostingLine(old, false).text, "on (this node has no off switch yet: update the node)");
  assert.equal(T.hostingView(null).cpuCap, 0, "nothing is a default, never a crash");
});

test("the panel's sentences: the switch line, the rows, the notes, the questions", () => {
  const v = T.hostingView(fake("pc").view());
  assert.equal(T.hostingLine(v, false).text, "on \u00B7 listed on enclave.host, taking new work under your limits");
  assert.equal(T.hostingLine({ ...v, taking: false, takingWhy: "not registered on the network yet" }, false).warn, true);
  assert.equal(T.hostingLine({ ...v, paused: true, served: 0 }, false).text, "off \u00B7 nothing runs; this PC is all yours");
  assert.equal(T.hostingLine({ ...v, paused: true, served: 2 }, false).text, "off \u00B7 stopping 2 app(s)\u2026");
  assert.equal(T.hostingLine(v, true).text, "turning off\u2026");
  assert.deepEqual({ ...T.limitsRow(v, 0.5, 0.25, false) }, { text: "CPU 50% \u00B7 GPU 25%", warn: false });
  assert.deepEqual({ ...T.limitsRow(v, 0.2, 0.25, true) }, { text: "CPU 20% \u00B7 GPU 25% \u00B7 not applied", warn: true });
  assert.deepEqual({ ...T.limitsRow(v, 0.2, 0.25, false) }, { text: "CPU 20% \u00B7 GPU 25% \u00B7 more in use", warn: true });
  const phone = T.hostingView(fake("phone").view());
  assert.equal(T.limitsRow(phone, 0.5, 0, false).text, "CPU & RAM 50%");
  assert.match(T.statusText(v), /^Node: reachable \u00B7 backend hv \u00B7 2 deployments served$/);
  assert.equal(T.gasText(v), "", "gas not low: nothing said");
  assert.match(T.gasText({ ...v, gasLow: true, gasHoursLeft: 5.4 }), /^Operator gas is LOW \(about 5 hours left\): send a little ETH on Base to 0x389c.* or apps stop renewing and go away$/);
  assert.doesNotMatch(T.statusText({ ...v, gasLow: true }), /gas/, "the gas warning is its own (amber) line, not the muted status");
  assert.equal(T.cpuLines(v, 0.2, true).note, "Below what is in use: Apply asks before it drops running deployments (newest first) until use fits.");
  assert.equal(T.cpuLines(v, 0.9, false).note, "New claims stop at 75%: the node keeps 25% for itself.");
  assert.equal(T.cpuLines(phone, 1, false).note, "", "a phone keeps no reserve");
  const drop = T.askDrop([{ id: "0x" + "a".repeat(64), appRef: "enclave-apps/cron@1.0.2", cpuShare: 0.1, gpuShare: 0 }], 0.2, 0, phone);
  assert.equal(drop.body.slice(0, 66), "Applying CPU & RAM 20% leaves no room for 1 deployment running on ");
  assert.equal(drop.ok, "Drop 1 and apply");
  const off = T.askOff([{ id: "0x1" }, { id: "0x2" }], phone);
  assert.match(off.body, /^2 apps running on this phone are stopped now .* this phone's CPU and memory are all yours/);
  assert.match(T.askOff([{ id: "0x1" }], v).body, /this PC's CPU, GPU and memory are all yours/);
});

test("prices, the payout wallet and earnings are said and checked as the nodes check them", () => {
  const v = T.hostingView(fake("pc").view());
  assert.deepEqual({ ...T.priceLines(v.cpuPrice, "cpu", "CPU", "PC") }, { line: "CPU $0.047 an hour \u00B7 default",
    note: "Default: the cheapest TEE CPU host's rate (nucbox-k11-4) for this PC's 24 GB \u00D7 446.7 GFLOPS. A deployment pays the share of it it leases." });
  const phone = T.hostingView(fake("phone").view());
  assert.match(T.priceLines(phone.cpuPrice, "cpu", "CPU", "phone").note, /the network's starting rate \(no other pVM CPU host yet\) for this phone's 4 GB \u00D7 1\.4 GFLOPS/);
  assert.equal(T.parsePrice("$0.05"), 0.05); assert.equal(T.parsePrice("0"), null); assert.equal(T.parsePrice("1001"), null); assert.equal(T.parsePrice("abc"), null);
  assert.equal(T.priceHint("0.05", { ...v.cpuPrice, override: 0.05 }, "CPU").canSave, false, "the saved price again is no change");
  assert.equal(T.isAddress("0x" + "0".repeat(40)), false); assert.equal(T.isAddress("0x0b2d009c0c9Af05b12100D77F3c815fea822eE61"), true);
  assert.equal(T.walletHint("0x12", "", true, true).tone, "warn");
  assert.equal(T.walletHint("0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", "", true, true).canSave, true);
  assert.equal(T.walletHint("0x0b2d009c0c9af05b12100d77f3c815fea822ee61", "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", true, true).canSave, false);
  const e = T.earningsView(fake("pc").earnings());
  assert.equal(e.earned, 1.234567);
  assert.deepEqual({ ...T.earningsRow(e) }, { text: "$1.23 earned \u00B7 add a payout wallet", warn: true });
  assert.deepEqual({ ...T.earningsRow({ ...e, payTo: "0xabc", paidOut: 3 }) }, { text: "$1.23 earned \u00B7 $3.00 paid", warn: false });
  assert.equal(T.earningsLines(null, "the chain could not be read", "PC").note, "the chain could not be read");
  assert.equal(T.usdPrice(0.0036), "$0.0036"); assert.equal(T.usdPrice(1.5), "$1.50"); assert.equal(T.usd(0.005), "$0.01");
});

test("every host app ships every file the panel loads: the Windows tray's build copies exactly them", () => {
  const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  const loads = [...html.matchAll(/(?:src|href)="([a-z-]+\.(?:js|css))"/g)].map((m) => m[1]).concat("index.html").sort();
  assert.deepEqual(loads, ["app.css", "app.js", "bridge.js", "index.html", "text.js"]);
  for (const f of loads) assert.ok(fs.existsSync(path.join(UI, f)), f);
  const cmd = fs.readFileSync(path.join(UI, "..", "windows", "tray", "build.cmd"), "utf8");
  assert.deepEqual(/for %%f in \(([^)]*index\.html[^)]*)\) do copy/.exec(cmd)[1].split(/\s+/).sort(), loads);
});

test("the Windows installer compiles the tray's theme alone, never the tray's WebView2 shell (the .33 bundle build broke on that)", () => {
  const win = path.join(UI, "..", "windows");
  const setup = fs.readFileSync(path.join(win, "installer", "build-setup.cmd"), "utf8"), tray = fs.readFileSync(path.join(win, "tray", "build.cmd"), "utf8");
  const sources = (cmd) => cmd.split("\n").filter((l) => /csc/i.test(l) && /\.cs\b/.test(l)).map((l) => (l.match(/[\w\\.]+\.cs\b/g) || []).map((f) => f.split("\\").pop()));
  for (const list of sources(setup)) { assert.ok(list.includes("TrayTheme.cs"), list.join(" ")); assert.ok(!list.includes("EnclaveTray.cs"), list.join(" ")); }
  for (const list of sources(tray)) assert.deepEqual(list.sort(), ["EnclaveTray.cs", "TrayTheme.cs"]);
  const theme = fs.readFileSync(path.join(win, "tray", "TrayTheme.cs"), "utf8");
  assert.ok(!/WebView2/.test(theme.replace(/^\s*\/\/.*$/gm, "")), "the theme file references nothing of WebView2");
  for (const t of ["static class Theme", "sealed class ThemeButton"]) assert.ok(theme.includes(t), t);
});

// ---- the panel in Chromium --------------------------------------------------------------------------------------------
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { }
async function launch() {
  if (!chromium) return null;
  for (const executablePath of [process.env.CHROME, undefined].filter((x, i) => x || i === 1)) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { }
  }
  return null;
}
const browser = await launch();
const skip = browser ? false : "no Chromium to launch (set CHROME to a chrome binary)";
test.after(async () => { if (browser) await browser.close(); });

async function open(kind, opts = {}) {
  const node = createFakeNode({ kind });
  const srv = createDevServer({ fake: node });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ctx = await browser.newContext(kind === "phone" ? { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true } : { viewport: { width: 372, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/${opts.query || ""}`);
  await page.waitForFunction(() => !document.getElementById("panel").hasAttribute("aria-busy") && document.getElementById("status").textContent.startsWith("Node: reachable"));
  const text = (sel) => page.locator(sel).innerText();
  return { node, page, text, errors, close: async () => { await ctx.close(); srv.close(); } };
}

test("Limits: a move arms Apply and says so; Apply sends the caps; a cap below use asks before it drops, newest first", { skip }, async () => {
  const p = await open("pc");
  try {
    await p.page.click("#rowLimits");
    assert.equal(await p.page.isDisabled("#apply"), true);
    await p.page.focus("#cpu"); await p.page.keyboard.press("ArrowRight"); await p.page.keyboard.press("ArrowRight");
    assert.equal(await p.text("#valLimits"), "CPU 60% \u00B7 GPU 25% \u00B7 not applied");
    assert.equal(await p.text("#unsaved"), "not applied");
    await p.page.click("#apply");
    await p.page.waitForFunction(() => document.getElementById("valLimits").textContent === "CPU 60% \u00B7 GPU 25%");
    assert.deepEqual(p.node.state.log.at(-1).put, { cpuShare: 0.6, gpuShare: 0.25 });
    // below use (0.3 in use): the node's 409 is the question; Cancel changes nothing
    await p.page.fill("#cpu", "2");
    await p.page.click("#apply");
    await p.page.waitForSelector("#ask[open]");
    assert.equal(await p.text("#askHeading"), "Drop running work?");
    assert.equal(await p.text("#askDetail"), "0x77e75476\u2026  enclave-apps/api-mcp-a\u2026.4.1  20% CPU", "the newest only: what stays then fits");
    await p.page.click("#askCancel");
    assert.equal(await p.text("#error"), "Not applied: nothing was dropped. Raise the caps, or Reset.");
    assert.equal(p.node.state.caps.cpuShare, 0.6);
    // again, confirmed: dropped, its id sent back as the confirmation
    await p.page.click("#apply");
    await p.page.waitForSelector("#ask[open]");
    await p.page.click("#askOk");
    await p.page.waitForFunction(() => document.getElementById("error").textContent === "Dropped 1 deployment: its lease goes back to the network.");
    assert.equal(p.node.state.caps.cpuShare, 0.1); assert.equal(p.node.state.apps.length, 1);
    assert.deepEqual(p.node.state.log.at(-1).put.drop, ["0x77e75476" + "2".repeat(56)]);
    // Reset puts an unapplied move back
    await p.page.fill("#cpu", "10");
    await p.page.click("#reset");
    assert.equal(await p.page.inputValue("#cpu"), "2");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("the switch asks before it stops running apps; Cancel keeps hosting on, the confirmation turns it off", { skip }, async () => {
  const p = await open("pc");
  try {
    await p.page.click("#switch");
    await p.page.waitForSelector("#ask[open]");
    assert.equal(await p.text("#askOk"), "Stop 2 apps and turn off");
    await p.page.keyboard.press("Escape");
    await p.page.waitForFunction(() => document.getElementById("error").textContent === "Hosting is still on: nothing was stopped.");
    assert.equal(p.node.state.caps.paused, false);
    await p.page.click("#switch");
    await p.page.waitForSelector("#ask[open]");
    await p.page.click("#askOk");
    await p.page.waitForFunction(() => document.getElementById("switch").getAttribute("aria-checked") === "false");
    assert.equal(p.node.state.caps.paused, true);
    assert.equal(await p.text("#hostingLine"), "off \u00B7 nothing runs; this PC is all yours");
    await p.page.click("#switch");
    await p.page.waitForFunction(() => document.getElementById("switch").getAttribute("aria-checked") === "true");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("Price: Edit, a bad price refused before it is sent, Save, Use default", { skip }, async () => {
  const p = await open("pc");
  try {
    await p.page.click("#rowPrice");
    const cpu = '.price[data-axis="cpu"]';
    await p.page.click(`${cpu} [data-part="edit"]`);
    await p.page.fill(`${cpu} [data-part="box"]`, "0");
    assert.equal(await p.page.isDisabled(`${cpu} [data-part="save"]`), true);
    assert.equal(await p.text(`${cpu} [data-part="hint"]`), "a price in USDC an hour, above 0 and at most 1000");
    await p.page.fill(`${cpu} [data-part="box"]`, "0.08");
    await p.page.keyboard.press("Enter");
    await p.page.waitForFunction(() => /^Price saved/.test(document.getElementById("error").textContent));
    assert.equal(p.node.state.pricing.cpuPerHour, 0.08);
    assert.equal(await p.text(`${cpu} [data-part="line"]`), "CPU $0.080 an hour \u00B7 your price");
    assert.equal(await p.text("#valPrice"), "CPU $0.080/h \u00B7 GPU $0.310/h");
    await p.page.click(`${cpu} [data-part="edit"]`);
    await p.page.click(`${cpu} [data-part="default"]`);
    await p.page.waitForFunction(() => document.getElementById("error").textContent === "Back to the default price.");
    assert.equal(p.node.state.pricing.cpuPerHour, null);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("Earnings: the payout wallet is checked as it is typed, saved, then read-only with Edit; Pay out now", { skip }, async () => {
  const p = await open("pc");
  try {
    await p.page.click("#rowEarnings");
    assert.equal(await p.page.isEditable("#wallet"), true, "no wallet yet: the field is open for the first one");
    await p.page.fill("#wallet", "0x0b2d");
    assert.match(await p.text("#walletHint"), /^not a wallet address yet: 0x followed by 40 characters 0-9, a-f \(4 of 40\)$/);
    assert.equal(await p.page.isDisabled("#saveWallet"), true);
    assert.equal(await p.page.isDisabled("#payNow"), true, "nobody to pay yet");
    await p.page.fill("#wallet", "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61");
    await p.page.click("#saveWallet");
    await p.page.waitForFunction(() => /^Payout wallet saved: earnings go to 0x0b2d00\u2026eE61\.$/.test(document.getElementById("error").textContent));
    assert.equal(p.node.state.wallet, "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61");
    assert.equal(await p.page.isEditable("#wallet"), false);
    assert.equal(await p.text("#walletHint"), "\u2713 earnings are paid to this wallet");
    assert.equal(await p.text("#valEarnings"), "$1.23 earned \u00B7 $0.00 paid");
    await p.page.click("#payNow");
    await p.page.waitForFunction(() => /^Paid out \(tx 0xffffff\u2026fff1\)\.$/.test(document.getElementById("error").textContent));
    assert.equal(await p.text("#valEarnings"), "$0.00 earned \u00B7 $1.23 paid");
    // Edit, then Esc in the field cancels the edit only; Esc again closes the section
    await p.page.click("#editWallet");
    await p.page.fill("#wallet", "0x12");
    await p.page.keyboard.press("Escape");
    assert.equal(await p.page.inputValue("#wallet"), "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61");
    assert.equal(await p.page.isVisible("#pageEarnings"), true);
    await p.page.keyboard.press("Escape");
    assert.equal(await p.page.isVisible("#pageEarnings"), false);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("as a phone: one CPU & RAM share and no GPU anywhere, the panel's own title, Apps by name", { skip }, async () => {
  const p = await open("phone", { query: "?notitle" });
  try {
    assert.equal(await p.page.isVisible("#mast"), true);
    await p.page.click("#rowLimits");
    assert.equal(await p.page.isVisible("#gpuBlock"), false);
    assert.equal(await p.text("#cpuTitle"), "CPU & RAM SHARE OFFERED");
    await p.page.fill("#cpu", "14");
    await p.page.click("#apply");
    await p.page.waitForFunction(() => document.getElementById("valLimits").textContent === "CPU & RAM 70%");
    assert.deepEqual(p.node.state.log.at(-1).put, { cpuShare: 0.7 }, "no GPU share is ever sent from a phone");
    await p.page.click("#rowPrice");
    assert.equal(await p.page.isVisible('.price[data-axis="gpu"]'), false);
    assert.equal(await p.text("#valPrice"), "CPU $0.011/h");
    // a phone's payout goes out with its next transaction: said as pending
    await p.page.click("#rowEarnings");
    await p.page.fill("#wallet", "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61");
    await p.page.click("#saveWallet");
    await p.page.waitForFunction(() => /^Payout wallet saved/.test(document.getElementById("error").textContent));
    await p.page.click("#payNow");
    await p.page.waitForFunction(() => /^Paying out \$1\.23 to 0x0b2d00\u2026eE61: the transaction goes out within a minute\.$/.test(document.getElementById("error").textContent));
    assert.equal(await p.page.isDisabled("#payNow"), true, "not twice while it is paying");
    // Android's Back: a question is cancelled, then the open section closes, then the app is left (the shell's hide)
    await p.page.click("#switch");
    await p.page.waitForSelector("#ask[open]");
    assert.equal(await p.page.evaluate(() => window.EnclaveHostPanel.back()), true);
    await p.page.waitForFunction(() => document.getElementById("error").textContent === "Hosting is still on: nothing was stopped.");
    assert.equal(p.node.state.caps.paused, false);
    assert.equal(await p.page.evaluate(() => window.EnclaveHostPanel.back()), true, "the open section closes");
    assert.equal(await p.page.isVisible("#pageEarnings"), false);
    assert.equal(await p.page.evaluate(() => window.EnclaveHostPanel.back()), false, "nothing open: the shell is asked to hide");
    await p.page.click("#rowApps");
    assert.equal(await p.text("#valApps"), "2 serving");
    assert.equal(await p.page.locator("#apps a").first().innerText(), "a69dcbba.app.enclave.host");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test("a node that can't be reached, or is being updated, is said as such and the controls wait", { skip }, async () => {
  const p = await open("pc");
  try {
    p.node.state.unreachable = "there is no token file at C:\\ProgramData\\Enclave\\hosting\\hosting-admin.token: is the node running?";
    await p.page.evaluate(() => window.EnclaveHostPanel.refresh());
    await p.page.waitForFunction(() => /^Node: not reachable\. there is no token file/.test(document.getElementById("status").textContent));
    assert.equal(await p.page.isDisabled("#switch"), true);
    assert.equal(await p.page.isDisabled("#cpu"), true);
    p.node.state.update = { state: "installing", to: "2026.10.13.32" };
    await p.page.evaluate(() => window.EnclaveHostPanel.refresh());
    await p.page.waitForFunction(() => document.getElementById("status").textContent === "Updating to 2026.10.13.32: installing. Hosting stops for a few minutes and resumes on its own.");
    p.node.state.unreachable = false; p.node.state.update = null;
    // the operator's gas running out: its own line, in amber, naming the operator (a8 2026-10-13: not in muted ink)
    p.node.state.gas = { operator: "0x1A01194c34Fe3577C6d0a54feB78af6253e494e0", low: true, hoursLeft: 12, renewalsLeft: 300 };
    await p.page.evaluate(() => window.EnclaveHostPanel.refresh());
    await p.page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Node: reachable"));
    assert.equal(await p.page.isDisabled("#switch"), false);
    assert.equal(await p.text("#gas"), "Operator gas is LOW (about 12 hours left): send a little ETH on Base to 0x1A01194c34Fe3577C6d0a54feB78af6253e494e0 or apps stop renewing and go away");
    assert.equal(await p.page.$eval("#gas", (e) => getComputedStyle(e).color), "rgb(255, 145, 77)", "amber (DESIGN.md --amber #FF914D)");
    p.node.state.unreachable = "the node is not answering";
    await p.page.evaluate(() => window.EnclaveHostPanel.refresh());
    await p.page.waitForFunction(() => /^Node: not reachable/.test(document.getElementById("status").textContent));
    assert.equal(await p.page.isVisible("#gas"), false, "no gas line while the node can't be asked");
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});
