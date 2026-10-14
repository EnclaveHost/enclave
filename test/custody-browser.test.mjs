// Browser-side encryption, in a REAL browser: site/vendor/custody.js (the committed bundle, which must equal a fresh build of
// custody/browser.mjs) is served same-origin to Chrome for Testing, which encrypts an env map to a 3-of-5 committee and builds
// the vault calldata. Node then plays the custodians: each opens ITS share with its own key, three of them recombine the data
// key, and the bundle decrypts to exactly the env the page encrypted. The page never sees a custodian private key.
//   run: node --test test/custody-browser.test.mjs   (skipped, saying so, without Chrome for Testing)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { OUT, buildCustodyVendor } from "../scripts/build-custody-vendor.mjs";
import * as hpke from "../custody/hpke.mjs";
import * as P from "../custody/protocol.mjs";
import * as th from "../custody/threshold.mjs";
import { decodeFunctionData } from "viem";
import { UPDATE_ABI } from "../custody/owner.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const skip = !fs.existsSync(CFT) && "Chrome for Testing absent";

test("the committed site/vendor/custody.js is exactly a fresh build of custody/browser.mjs, with no node: import", async () => {
  const { js, manifest } = await buildCustodyVendor();
  const committed = fs.readFileSync(OUT);
  assert.equal(Buffer.compare(committed, js), 0, "rebuild with: node scripts/build-custody-vendor.mjs");
  assert.equal(JSON.parse(fs.readFileSync(OUT.replace(/custody\.js$/, "custody.MANIFEST.json"), "utf8")).sha256, manifest.sha256);
  assert.ok(!/from\s*["']node:/.test(js.toString("utf8")), "no node: import in a browser bundle");
});

test("Chrome encrypts to the committee; three custodians' keys recover exactly that env", { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-custody-browser-"));
  const members = [0, 1, 2, 3, 4].map(() => hpke.generateKeyPair());
  const ctx = { chainId: 8453, vault: "0x" + "5e".repeat(20), id: "0x" + "b7".repeat(32), secretRev: 1n, committeeId: "0x" + "c0".repeat(32), epoch: 1 };
  const ENV = { DATABASE_URL: "postgres://browser-user:browser-pass@db.example/app", STRIPE_KEY: "sk_test_browser_" + "z".repeat(24) };
  const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
    import * as C from "/custody.js";
    window.run = (input) => {
      const b = C.buildBundle({ ...input.ctx, secretRev: BigInt(input.ctx.secretRev), threshold: 3, members: input.members.map((k) => ({ encKey: k })), env: input.env, configText: input.configText });
      const u = C.makeUpdate({ expectPolicyRev: 0, policy: { committeeId: input.ctx.committeeId, paused: false, rules: input.rules }, bundle: { ...b, epoch: input.ctx.epoch } });
      const hex = (x) => Array.from(x, (v) => v.toString(16).padStart(2, "0")).join("");
      return { ua: navigator.userAgent, ciphertext: hex(b.ciphertext), commitments: hex(b.commitments), sealed: b.sealedShares.map(hex),
               calldata: C.encodeFunctionData({ abi: C.UPDATE_ABI, functionName: "update", args: [input.ctx.id, u] }) };
    };
    window.ready = true;
  </script>`;
  fs.writeFileSync(path.join(tmp, "index.html"), PAGE);
  fs.copyFileSync(OUT, path.join(tmp, "custody.js"));
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const f = path.join(tmp, path.basename(new URL(req.url, "http://x").pathname) || "index.html");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const chrome = spawn(CFT, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let browser;
  try {
    let log = "";
    const endpoint = await new Promise((resolve, reject) => { chrome.stderr.on("data", (c) => { log += c; const m = /DevTools listening on (ws:\S+)/.exec(log); if (m) resolve(m[1]); }); setTimeout(() => reject(new Error("chrome did not start")), 30000); });
    browser = await chromium.connectOverCDP(endpoint);
    const page = await browser.contexts()[0].newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
    const rules = { v: 1, appId: "ab".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
    const r = await page.evaluate((input) => window.run(input), { ctx: { ...ctx, secretRev: "1" }, members: members.map((m) => P.hex(m.publicKey)), env: ENV, rules, configText: P.configTextOf({ db: "${DATABASE_URL}" }) });
    assert.deepEqual(errors, []);
    assert.match(r.ua, /Chrome\//);
    // nothing the page produced carries a value in the clear
    for (const v of Object.values(ENV)) assert.ok(!JSON.stringify(r).includes(Buffer.from(v).toString("hex")));
    // the custodians, in Node: each opens its own share; any three recombine; the bundle opens
    const commitments = P.splitCommitments(Buffer.from(r.commitments, "hex"));
    const shares = r.sealed.map((s, i) => ({ x: i + 1, y: P.openShareAtRest(members[i].privateKey, { ...ctx, index: i, commitments }, new Uint8Array(Buffer.from(s, "hex"))) }));
    for (const sh of shares) assert.ok(th.verifyShare(sh.x, sh.y, commitments), "every share the browser sealed matches its commitments");
    const s = th.combine([shares[4], shares[1], shares[3]], 3);
    const opened = P.decryptBundle(P.deriveDek(s, ctx), P.bundleAad({ ...ctx, c0: commitments[0] }), new Uint8Array(Buffer.from(r.ciphertext, "hex")));
    assert.deepEqual(opened.env, ENV);
    assert.equal(opened.configSha256, P.configSha256(P.configTextOf({ db: "${DATABASE_URL}" })), "the browser committed the config");
    // and the calldata the browser built decodes to the same bundle and the owner's rules
    const { args } = decodeFunctionData({ abi: UPDATE_ABI, data: r.calldata });
    assert.equal(args[0], ctx.id);
    assert.equal(args[1].ciphertext, "0x" + r.ciphertext);
    assert.equal(JSON.parse(Buffer.from(args[1].rules.slice(2), "hex").toString()).appId, rules.appId);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
